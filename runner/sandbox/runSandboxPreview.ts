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
import { IDENTITY_REDACTOR, makeRedactor, previewPersistPlan, scrubError, type Redactor } from '../redact.js';
import { compileSpec } from '../specfetch/compileSpec.js';
import { buildRedactedTraceZip } from '../traceRedact.js';
import { buildSandboxEnv, type SandboxRunVars } from './sandboxEnv.js';
import { credentialValues, isCredentialedRun, type SandboxCredentials } from './sandboxPayload.js';

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
 * ★ Walks the tree and scrubs each STRING LEAF. It must NOT scrub `JSON.stringify(signals)` instead: that
 * serializes a value like `P@ss"w0rd\x` into its ESCAPED form (`P@ss\"w0rd\\x`), which the escaped-literal
 * knownValues rule cannot match — so any credential containing a quote or backslash would survive the scrub
 * while looking scrubbed. Per-leaf redaction sees the real value.
 */
function redactTraceSignals(signals: unknown | null, redact: Redactor): unknown | null {
  if (signals === null || signals === undefined) return signals;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      // Keys can carry a credential too (an object keyed by header/param value), so scrub both sides.
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [redact(k), walk(val)]));
    }
    return v;
  };
  try {
    return walk(signals);
  } catch {
    // Fail-closed: if the scrub fails we drop the signals entirely rather than ship them raw.
    return null;
  }
}

/**
 * The credential values to register with makeRedactor, plus their ENCODED forms.
 *
 * ★ makeRedactor matches knownValues as escaped LITERALS — the exact byte sequence. But a browser does not
 * echo a credential back verbatim: Chromium percent-encodes it in a recorded navigation URL, and a JSON body
 * carries it backslash-escaped. So `p@ss w0rd` appears in trace.network as `p@ss%20w0rd` and the literal rule
 * misses it entirely. The fleet path has always had this gap; it only becomes load-bearing here, where the
 * value is an ARBITRARY user-typed password rather than something the platform chose.
 *
 * Registering the encoded variants alongside the raw value closes it for the shapes we can enumerate.
 * ★ This is defense-in-depth, not a proof: an encoding we did not anticipate would still slip through. That
 * residual risk is accepted for the TEXT channels; it is not bounded by withholding the screenshot, which a
 * credentialed preview KEEPS (redact.ts previewPersistPlan → failureScreenshot: true, unconditional). The
 * Tests area is editor/admin-only and the operator typed the credential, so showing it back is not a
 * disclosure — and a password field renders MASKED, so it does not appear in the image anyway.
 */
function redactionValues(creds: SandboxCredentials | undefined): string[] {
  const out = new Set<string>();
  for (const v of credentialValues(creds)) {
    out.add(v);
    for (const enc of [encodeURIComponent, encodeURI, (s: string) => JSON.stringify(s).slice(1, -1)]) {
      try {
        const e = enc(v);
        if (e && e !== v) out.add(e);
      } catch {
        /* a lone surrogate can throw in encodeURI* — the raw value is still registered */
      }
    }
  }
  return [...out];
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
     * Per-run "Redact credentials from output" toggle. DEFAULT ON (absent ⇒ ON; only a literal `false`
     * disables). ★ Deliberately NOT part of SandboxRunVars: those fields are what buildSandboxEnv publishes
     * to the CHILD, and the child must never learn whether redaction is on — it just runs the spec. The
     * decision is the PARENT's, applied to output on the way back.
     */
    redactCredentials?: boolean;
    /**
     * ★ TEST-ONLY, and the ONLY way the redaction suite can prove it is not vacuous. Drops a credentialed
     * run back to the NON-SENSITIVE treatment — IDENTITY_REDACTOR and the RAW trace zip — so the meta-test
     * can assert the sentinel suite REDS with the protections off. It disables the whole sensitive
     * treatment rather than only the redactor so the mutant differs on every channel the suite scans.
     * ★ It no longer has anything to do with the screenshot: previewPersistPlan keeps that on BOTH paths,
     * so the image is a constant here, not a protection this flag toggles.
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
  // ★ The toggle is expressed HERE, by dropping `sensitive`, rather than by a second flag threaded through
  //   every downstream branch. redactCredentials=false ⇒ sensitive=false ⇒ IDENTITY_REDACTOR and the raw
  //   trace — i.e. OFF reuses the already-proven non-sensitive path instead of adding a third mode nobody
  //   tests. Screenshots are kept either way now (previewPersistPlan), so the toggle governs SCRUBBING only.
  //   Default ON: only a literal `false` from the payload disables (decodeSandboxPayload enforces that).
  const redactCredentials = vars.redactCredentials !== false;
  const sensitive =
    isCredentialedRun(vars.credentials) && redactCredentials && !vars.__unsafeDisableSensitiveHandlingForTest;
  const redact: Redactor = sensitive ? makeRedactor(null, redactionValues(vars.credentials)) : IDENTITY_REDACTOR;

  // ★ STATIC GATE: esbuild compiles ONLY through the single lib/flow alias — a spec importing arbitrary npm
  //   (a Postgres client, an exfil lib) fails to compile and never runs. Same admission rule as merge/runtime.
  //   The throw is scrubbed: an esbuild syntax error QUOTES THE OFFENDING SOURCE LINE, so a spec that inlines
  //   a credential would otherwise echo it straight back through the api's 4xx body.
  // ★ The caught error is converted to a SCRUBBED message inside the catch, and the throw happens OUTSIDE
  //   it. That is not a lint dodge — attaching the original as `cause` (what preserve-caught-error asks for)
  //   would re-attach the very string this scrub exists to remove, and anything walking the cause chain (a
  //   logger, the api's error serializer, `util.inspect`) would print it. Throwing outside the catch means
  //   there is no caught error in scope to preserve, so the rule is satisfied honestly rather than silenced.
  let compiledJs: string | undefined;
  let compileError: string | null = null;
  try {
    compiledJs = await compileSpec(specSource);
  } catch (e) {
    compileError = redact(e instanceof Error ? e.message : String(e));
  }
  if (compileError !== null || compiledJs === undefined) {
    throw new Error(compileError ?? 'spec failed to compile');
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

          // ── B10 policy for a preview, via previewPersistPlan — NOT the fleet's tracePersistPlan ───────
          // SENSITIVE  → a REDACTED/REDUCED zip: text entries scrubbed, images KEPT (buildRedactedTraceZip's
          //              keepImages, the preview-only divergence).
          // SCREENSHOT → KEPT on both paths. previewPersistPlan returns failureScreenshot: true
          //              unconditionally, so credentials do not change screenshot retention.
          // ★ The retention rule is about FAILURE, not sensitivity: sandboxChild writes screenshot.png only
          //   `if (traced.screenshot)`, which runTracedFlow sets on a failing run — so a PASSING preview has
          //   no screenshot and never did (see PreviewResult.screenshot's docstring above).
          // ★ Text redaction is UNCHANGED and still credential-gated — only the image claim moved.
          const plan = previewPersistPlan(sensitive);

          if (sensitive) {
            // Scrub EVERY text field that reaches the result JSON — not just the obvious error channels.
            // ★ tests[], failedStep and steps[].name are SPEC-AUTHORED strings. `test('login as ' + user)` /
            //   `step('enter ' + pw)` is an entirely ordinary way to write a login flow, and those names are
            //   uploaded verbatim inside {token}.json and rendered by the UI. Scrubbing only errorMessage
            //   left that wide open.
            // ★ failedStep is scrubbed BEFORE scrubError, because scrubError's fallback
            //   (sensitiveErrorMessage) interpolates failedStep into the message — so an unscrubbed one would
            //   re-inject the secret through the very path meant to blank a fully-secret error.
            tests = tests.map(redact);
            failedStep = failedStep === null ? null : redact(failedStep);
            steps = steps.map((s) => ({
              ...s,
              name: redact(s.name),
              errorMessage: s.errorMessage === null ? null : redact(s.errorMessage),
            }));
            error = error === null ? null : scrubError(redact, (status ?? 'error') as TerminalStatus, failedStep, error);
            traceSignals = redactTraceSignals(traceSignals, redact);
          }

          // The child holds no blob creds — it wrote the trace/screenshot as temp files; the PARENT uploads.
          if (j.tracePath) {
            if (plan.failureTraceMode === 'redacted') {
              // buildRedactedTraceZip is FAIL-CLOSED: false ⇒ destPath removed ⇒ we ship NO trace. A raw
              // byte can never reach the blob because scrubbing broke.
              const redactedPath = `${j.tracePath}.redacted.zip`;
              // ★ keepImages: the preview divergence. Text still scrubbed; the picture survives.
              const built = await buildRedactedTraceZip(j.tracePath, redactedPath, redact, { keepImages: true });
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
          // plan.failureScreenshot is true for every preview, so this reduces to "read it if the child
          // produced one" — i.e. on a FAILING run. On a pass there is no screenshotPath to read. The temp
          // dir is rm'd by runSandboxPreview's finally either way.
          if (j.screenshotPath && plan.failureScreenshot) screenshot = await readFile(j.screenshotPath).catch(() => null);
        } catch {
          /* no valid report → ok stays false */
          // ★ FAIL CLOSED on a sensitive run. The redaction above happens INSIDE this try, and the fields
          //   are assigned RAW before it runs — so a throw part-way through (a malformed signals tree, a
          //   readFile error) would otherwise resolve the unscrubbed values. Drop every text channel that
          //   may not have been scrubbed rather than ship a maybe-redacted one.
          if (sensitive) {
            tests = [];
            failedStep = null;
            steps = [];
            traceSignals = null;
            error = 'preview failed and its output could not be safely redacted — output withheld';
            trace = null;
            screenshot = null;
          }
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
