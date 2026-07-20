// runSandboxPreview — the ONE preview entry point, callable from BOTH the dashboard "Tests" area (via the
// api → the synthwatch-sandbox ACA job) AND a monitors-repo PR check (same api, posts the trace as a comment).
// It NEVER writes a check, NEVER persists to the fleet, NEVER touches spec_cache — the only path to a real
// monitor stays the repo PR.
//
// Flow: STATIC GATE (compile through the single lib/flow alias — the same admission rule the merge/runtime
// path enforces) → execute the spec in a CHILD PROCESS under an ALLOWLIST env (no inherited secrets) with a
// HARD timeout → capture output → return. The infra layer (infra/main.bicep: a separate identity, secret-free
// env, no DB) is the authoritative boundary; the child-process allowlist here is defense-in-depth AND what
// makes the "no secret leaks" acceptance test runnable off-Azure.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TerminalStatus } from '../db.js';
import { IDENTITY_REDACTOR, makeRedactor, scrubError, tracePersistPlan, type Redactor } from '../redact.js';
import { compileSpec } from '../specfetch/compileSpec.js';
import { buildRedactedTraceZip } from '../traceRedact.js';
import { buildSandboxEnv, type SandboxRunVars } from './sandboxEnv.js';
import { credentialValues, isCredentialedRun } from './sandboxPayload.js';

const CHILD_ENTRY = fileURLToPath(new URL('./sandboxChild.js', import.meta.url));

/**
 * Scrub a preview's trace_signals through the run's redactor.
 *
 * ★ THIS DIVERGES FROM THE FLEET PATH ON PURPOSE. traceSignals.ts stores network URLs RAW — deliberately,
 * for byte-parity with the C# TraceExtractor, pinned by a shared golden fixture (#170–#172). That parity
 * constraint binds the STORED FLEET path, which has a C# counterpart reading the same rows. A preview has
 * no C# counterpart and is never persisted to the fleet, so scrubbing here breaks nothing — and NOT
 * scrubbing would leave a typed password sitting in a `?password=…` request URL inside the result JSON.
 *
 * Round-tripping through JSON scrubs every string in the tree (URLs, console text, headers) in one pass.
 * `<redacted>` contains no quote or backslash, so a replacement can never break JSON validity.
 */
function redactTraceSignals(signals: unknown | null, redact: Redactor): unknown | null {
  if (signals === null || signals === undefined) return signals;
  try {
    return JSON.parse(redact(JSON.stringify(signals)));
  } catch {
    // Fail-closed: if the scrub-and-reparse fails we drop the signals entirely rather than ship them raw.
    return null;
  }
}

/** Bounds (mirrored by the ACA replicaTimeout + the api-side per-user rate/concurrency caps). */
export const SANDBOX_DEFAULT_TIMEOUT_MS = 120_000;

/** One recorded step of the preview flow — the RecordedStep shape, sans runId (a preview has no run). */
export interface PreviewStep {
  index: number;
  name: string;
  status: string;
  durationMs: number;
  errorMessage: string | null;
}

export interface PreviewResult {
  /** True iff the spec compiled, loaded, and the flow reported 'pass' within the timeout. */
  ok: boolean;
  /** The captured test names. */
  tests: string[];
  /** Everything the child wrote — INCLUDING the spec's own output. The isolation test asserts on this. */
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  // ── B2: the REAL trace, produced by the SAME browserFlow.runTracedFlow a real check uses ──
  /** The flow verdict (undefined if the browser run never reported — e.g. compile/load failure). */
  status?: 'pass' | 'fail' | 'error';
  /** The flow error message (e.g. a selector-not-found), or null. */
  error?: string | null;
  /** The step that failed, or null. */
  failedStep?: string | null;
  /** Per-step name/status/timing (the run_steps shape). */
  steps?: PreviewStep[];
  /** trace_signals (extractTraceSignals output), or null if no trace was produced. */
  traceSignals?: unknown | null;
  /** The trace.zip bytes (read from the child's temp file), or null. The caller uploads them under the MI. */
  trace?: Buffer | null;
  /** The failure screenshot bytes, or null (pass runs have no failure screenshot). */
  screenshot?: Buffer | null;
}

/**
 * Preview-run an uploaded spec. `specSource` is untrusted; `vars.targetUrl` is a non-prod / public target.
 * Throws only if the STATIC GATE (compile) rejects the spec — that is the same "can this even be admitted?"
 * check the merge path applies. A spec that runs but misbehaves is reported in the result, not thrown.
 */
export async function runSandboxPreview(
  specSource: string,
  vars: Partial<SandboxRunVars> & { targetUrl: string } & {
    /**
     * ★ TEST-ONLY, and the ONLY way the redaction suite can prove it is not vacuous. Drops a credentialed
     * run back to the NON-SENSITIVE treatment — IDENTITY_REDACTOR *and* no artifact suppression — so the
     * meta-test can assert the sentinel suite REDS with the protections off. It disables the WHOLE
     * sensitive treatment, not just the redactor, because otherwise the screenshot-suppression assertion
     * would have no mutant to fail against and would be the vacuous check in an anti-vacuity suite.
     * Never pass this in prod. (Same accepted pattern as crypto.ts's `ivOverride`.)
     */
    __unsafeDisableSensitiveHandlingForTest?: boolean;
  },
): Promise<PreviewResult> {
  const runVars: SandboxRunVars = {
    targetUrl: vars.targetUrl,
    timeoutMs: vars.timeoutMs ?? SANDBOX_DEFAULT_TIMEOUT_MS,
    credentials: vars.credentials,
  };
  // ★ A CREDENTIALED PREVIEW IS UNCONDITIONALLY `sensitive`. There is no check row to carry a `sensitive`
  //   column here, so the flag is derived from the run itself: the user typed a credential ⇒ treat this run
  //   exactly as the fleet treats a sensitive monitor. The typed values are registered as knownValues, so
  //   makeRedactor scrubs each one as an escaped literal wherever it appears — on TOP of the builtin
  //   token-shape denylist, which is what catches the SESSION material the login produces (the cookie/JWT
  //   the credential is exchanged for is not the credential, and is just as reusable).
  //   An UNCREDENTIALED preview gets IDENTITY_REDACTOR — byte-for-byte today's behaviour.
  const sensitive = isCredentialedRun(vars.credentials) && !vars.__unsafeDisableSensitiveHandlingForTest;
  const redact: Redactor = sensitive ? makeRedactor(null, credentialValues(vars.credentials)) : IDENTITY_REDACTOR;

  // ★ STATIC GATE: esbuild compiles ONLY through the single lib/flow alias — a spec importing arbitrary npm
  //   (a Postgres client, an exfil lib) fails to compile and never runs. Same admission rule as merge/runtime.
  //   The throw is scrubbed: an esbuild syntax error QUOTES THE OFFENDING SOURCE LINE, so a spec that inlines
  //   a credential would otherwise echo it straight back through the api's 4xx body.
  let compiledJs: string;
  try {
    compiledJs = await compileSpec(specSource);
  } catch (e) {
    // ★ NO `cause` — DELIBERATE, and the one place preserve-caught-error must not be obeyed. The cause IS
    //   the unredacted esbuild error (source line and all); attaching it would re-attach the very string
    //   this line exists to scrub, and anything that walks the cause chain (a logger, an api serializer,
    //   `util.inspect`) would print the credential. The scrubbed message keeps the diagnostic.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(redact(e instanceof Error ? e.message : String(e)));
  }

  const dir = await mkdtemp(join(tmpdir(), 'sw-sandbox-'));
  const specFile = join(dir, 'spec.compiled.mjs');
  try {
    await writeFile(specFile, compiledJs, 'utf8');
    return await runChild(specFile, runVars, sensitive, redact);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runChild(specFile: string, vars: SandboxRunVars, sensitive: boolean, redact: Redactor): Promise<PreviewResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // ★ detached — the child leads its OWN process group, so the timeout kill reaps grandchildren too
    //   (a hostile spec that spawns a detached grandchild cannot outlive the budget by escaping its parent).
    const child = spawn(process.execPath, [CHILD_ENTRY, specFile], {
      env: buildSandboxEnv(vars), // ★ allowlist — the child NEVER inherits the parent's secrets
      cwd: tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    // ★ hard kill the whole process GROUP — a runaway/infinite spec (or a detached grandchild it spawned)
    //   cannot outlive the budget. `-pid` targets the group; fall back to the direct child if pid is unset.
    const hardKill = (): void => {
      if (typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          /* group already gone (ESRCH) or unsupported — fall through to the direct-child kill */
        }
      }
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      hardKill();
    }, vars.timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    // ★ spawn failure (EMFILE/ENOMEM under load, a bad CHILD_ENTRY path) emits 'error' — WITHOUT this listener
    //   Node re-throws it as uncaught, 'close' never fires, and the promise (plus the temp dir) hangs forever.
    child.on('error', (e) => {
      clearTimeout(timer);
      // ★ stdout/stderr go through the redactor on EVERY resolve path — see the 'close' handler's note.
      resolve({
        ok: false,
        tests: [],
        stdout: redact(stdout),
        stderr: redact(stderr + `sandbox spawn error: ${e.message}\n`),
        timedOut,
        exitCode: null,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Read the child's report + its temp-file artifacts (before runSandboxPreview's finally rm's the dir).
      void (async () => {
        let tests: string[] = [];
        let reported = false;
        let status: PreviewResult['status'];
        let error: string | null = null;
        let failedStep: string | null = null;
        let steps: PreviewStep[] = [];
        let traceSignals: unknown | null = null;
        let trace: Buffer | null = null;
        let screenshot: Buffer | null = null;
        // The child's JSON report is its LAST stdout line; the spec's own output precedes it.
        const lastLine = stdout.trim().split('\n').pop() ?? '';
        try {
          const j = JSON.parse(lastLine) as {
            ok?: boolean; tests?: string[]; status?: PreviewResult['status']; error?: string | null;
            failedStep?: string | null; steps?: PreviewStep[]; traceSignals?: unknown | null;
            tracePath?: string | null; screenshotPath?: string | null;
          };
          reported = j.ok === true;
          tests = j.tests ?? [];
          status = j.status;
          error = j.error ?? null;
          failedStep = j.failedStep ?? null;
          steps = j.steps ?? [];
          traceSignals = j.traceSignals ?? null;

          // ── B10 policy for a preview, via the SAME tracePersistPlan the fleet path uses ──────────────
          // SENSITIVE  → the plan's verdict verbatim: a REDACTED/REDUCED zip (text entries scrubbed, ALL
          //              images dropped by classifyEntry — a screencast frame of a logged-in page cannot be
          //              text-scrubbed) and NO screenshot at all.
          // ★ NO page.screenshot({ mask }) — masking blacks out only the selectors you NAMED, so a
          //   credential rendered somewhere unpredicted (an error toast, the autofill dropdown, a
          //   "signed in as…" header) survives. Suppression is the only bound we can actually state.
          const plan = tracePersistPlan(sensitive, (status ?? 'error') as TerminalStatus);

          if (sensitive) {
            // Scrub the text channels the fleet path scrubs: per-step error messages, the flow error, and
            // (preview-only, see redactTraceSignals) trace_signals.
            steps = steps.map((s) => ({ ...s, errorMessage: s.errorMessage === null ? null : redact(s.errorMessage) }));
            error = error === null ? null : scrubError(redact, (status ?? 'error') as TerminalStatus, failedStep, error);
            traceSignals = redactTraceSignals(traceSignals, redact);
          }

          // The child holds no blob creds — it wrote the trace/screenshot as temp files; the PARENT uploads.
          if (j.tracePath) {
            if (plan.failureTraceMode === 'redacted') {
              // buildRedactedTraceZip is FAIL-CLOSED: false ⇒ destPath removed ⇒ we ship NO trace. A raw
              // byte can never reach the blob because scrubbing broke.
              const redactedPath = `${j.tracePath}.redacted.zip`;
              const built = await buildRedactedTraceZip(j.tracePath, redactedPath, redact);
              trace = built ? await readFile(redactedPath).catch(() => null) : null;
            } else {
              // ★ NON-SENSITIVE: today's preview behaviour, UNCHANGED — the RAW zip on pass AND fail. This
              //   is a deliberate divergence from the plan's non-sensitive branch ('none' on pass, which
              //   exists so a fleet monitor's green runs don't accumulate 90d of zips). A preview is a
              //   one-shot the user is watching, its blobs expire in 1 day, and the trace on a PASSING
              //   preview is the whole point of B2.
              trace = await readFile(j.tracePath).catch(() => null);
            }
          }
          // Sensitive ⇒ plan.failureScreenshot is false ⇒ the bytes are never even read; the temp dir is
          // rm'd by runSandboxPreview's finally, so the PNG never crosses this process boundary.
          if (j.screenshotPath && plan.failureScreenshot) screenshot = await readFile(j.screenshotPath).catch(() => null);
        } catch {
          /* no valid report → ok stays false */
        }
        // ★ stdout/stderr LAST, on every path. The platform has never redacted stdout anywhere (the fleet
        //   path logs raw and always has), but here stdout carries the SPEC'S OWN output — a `console.log`
        //   of the password, an unhandled throw quoting it — and sandboxMain ships 128 KB of it inside
        //   `{token}.json`, which the UI renders. This is the one genuinely NEW surface this feature opens.
        resolve({
          ok: reported && !timedOut,
          tests,
          stdout: redact(stdout),
          stderr: redact(stderr),
          timedOut,
          exitCode: code,
          status,
          error,
          failedStep,
          steps,
          traceSignals,
          trace,
          screenshot,
        });
      })();
    });
  });
}
