// The `synthwatch-sandbox` ACA job entrypoint (infra/main.bicep runs `node dist/sandbox/sandboxMain.js`).
// It runs under the SANDBOX identity with a SECRET-FREE, allowlist env — NO CRED_ENC_KEY, NO prod DATABASE_URL,
// NO DB grant — so this whole process is the low-privilege blast-radius box the design promises.
//
// ★ THE SPEC + CREDENTIALS ARRIVE VIA THE PAYLOAD BLOB, NOT THE ARM ENV (sandboxPayload.ts explains why in
// full: ACA persists a jobs/start env override VERBATIM in job execution history, readable by any Reader on
// the RG, retention unbounded-by-contract for triggerType:'Manual'). The env carries only the per-run AES
// key, whose leak into that history is harmless without the ciphertext. The legacy SW_SANDBOX_SPEC_B64 path
// is still honoured so this can deploy BEFORE the api switches channels; PR4 removes it.
//
// This runs the preview
// (a REAL Playwright trace, produced by the SAME browserFlow.runTracedFlow a real check uses), then uploads to
// the sandbox blob container (the sandbox identity's ONLY storage grant): the result JSON → `<token>.json`
// (steps + trace_signals + status), the trace.zip → `<token>/trace.zip`, and any failure screenshot →
// `<token>/screenshot.png`. Never touches the DB. Artifacts are SIZE-CAPPED here so a runaway spec can't fill
// the container (the storage version of the #269 self-DoS); an over-cap artifact is dropped and the poll shows
// it honestly-absent.
import { runSandboxPreview } from './runSandboxPreview.js';
import { isCredentialedRun, resolveSandboxPayload } from './sandboxPayload.js';
import { fetchAndDeleteSandboxPayload, uploadSandboxArtifact, uploadSandboxResult } from './sandboxUpload.js';

// ★ Artifact caps. A simple flow's trace.zip is well under 20 MB; a multi-nav/heavy-page runaway is bounded. A
//   full-page PNG is ~0.5–2 MB, so 4 MB is generous. Over-cap → DROPPED (steps + signals still serve; the
//   missing artifact renders honestly-absent). stdout in the result JSON is bounded so a stdout-spamming spec
//   can't bloat `<token>.json`.
const TRACE_CAP_BYTES = 20 * 1024 * 1024;
const SCREENSHOT_CAP_BYTES = 4 * 1024 * 1024;
const STDOUT_CAP_BYTES = 128 * 1024;

async function main(): Promise<void> {
  const target = process.env.SW_SANDBOX_TARGET_URL ?? 'https://example.com';
  const token = process.env.SW_SANDBOX_RESULT_TOKEN;

  // ★ FETCH → DELETE → decrypt, all BEFORE a single line of uploaded code compiles or runs. The delete is
  //   the FIRST thing that happens to the payload blob, so a hostile spec never executes while a
  //   neighbouring run's ciphertext is still resident in the shared container.
  let resolved;
  try {
    resolved = await resolveSandboxPayload(process.env, { fetchAndDeletePayload: fetchAndDeleteSandboxPayload });
  } catch (e) {
    // These messages are constructed to name the FIELD or the ENVELOPE, never the plaintext — see
    // decodeSandboxPayload. Nothing here can echo a credential.
    process.stderr.write(`sandboxMain: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
    return;
  }
  const { spec, credentials } = resolved.payload;
  // ★ Default ON. decodeSandboxPayload already normalises this to a real boolean (only a literal `false`
  //   disables), and the legacy env channel carries no credentials at all — so `?? true` here is the
  //   belt-and-braces default for a payload shape that predates the field.
  const redactCredentials = resolved.payload.redactCredentials ?? true;

  // Channel + credentialed-ness + the toggle — NEVER a value, and never the spec. An OFF run is the one we
  // most want a trail for, and this line is the job-log half of that trail (the DB half is the api's
  // sandbox_preview.redact_credentials column). `source` makes the PR4 cutover observable too.
  process.stderr.write(
    `sandboxMain: spec via ${resolved.source}; credentials ${isCredentialedRun(credentials) ? 'PRESENT' : 'absent'}; ` +
      `redaction ${redactCredentials ? 'ON' : 'OFF (operator opted out)'}\n`,
  );

  const result = await runSandboxPreview(spec, { targetUrl: target, credentials, redactCredentials });

  // Upload the binary artifacts FIRST (best-effort) so the result JSON's hasTrace/hasScreenshot reflect what
  // actually landed. The trusted PARENT holds the blob creds — the child never did.
  let hasTrace = false;
  let hasScreenshot = false;
  const trace = result.trace ?? null;
  const screenshot = result.screenshot ?? null;
  if (trace && trace.byteLength <= TRACE_CAP_BYTES) {
    hasTrace = await uploadSandboxArtifact(token, 'trace.zip', trace, 'application/zip');
  } else if (trace) {
    process.stderr.write(`sandboxMain: trace ${trace.byteLength}B over the ${TRACE_CAP_BYTES}B cap — dropped\n`);
  }
  if (screenshot && screenshot.byteLength <= SCREENSHOT_CAP_BYTES) {
    hasScreenshot = await uploadSandboxArtifact(token, 'screenshot.png', screenshot, 'image/png');
  } else if (screenshot) {
    process.stderr.write(`sandboxMain: screenshot ${screenshot.byteLength}B over the ${SCREENSHOT_CAP_BYTES}B cap — dropped\n`);
  }

  // The result JSON (→ `<token>.json` + echoed to stdout) — JSON-SAFE: no Buffers, hasTrace/hasScreenshot flags
  // instead. Steps + trace_signals are small and travel inside it.
  const stdoutCapped =
    result.stdout.length > STDOUT_CAP_BYTES ? `${result.stdout.slice(0, STDOUT_CAP_BYTES)}\n…(truncated)` : result.stdout;
  const payload = {
    ok: result.ok,
    tests: result.tests,
    status: result.status ?? null,
    error: result.error ?? null,
    failedStep: result.failedStep ?? null,
    steps: result.steps ?? [],
    traceSignals: result.traceSignals ?? null,
    stdout: stdoutCapped,
    stderr: result.stderr,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    hasTrace,
    hasScreenshot,
  };
  const resultJson = JSON.stringify(payload);
  process.stdout.write(resultJson + '\n');
  await uploadSandboxResult(token, resultJson);
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`sandboxMain: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
