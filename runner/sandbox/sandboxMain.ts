// The `synthwatch-sandbox` ACA job entrypoint (infra/main.bicep runs `node dist/sandbox/sandboxMain.js`).
// It runs under the SANDBOX identity with a SECRET-FREE, allowlist env — NO CRED_ENC_KEY, NO prod DATABASE_URL,
// NO DB grant — so this whole process is the low-privilege blast-radius box the design promises.
//
// The api passes the uploaded spec as base64 in SW_SANDBOX_SPEC_B64 (set on jobs/start). This runs the preview
// (a REAL Playwright trace, produced by the SAME browserFlow.runTracedFlow a real check uses), then uploads to
// the sandbox blob container (the sandbox identity's ONLY storage grant): the result JSON → `<token>.json`
// (steps + trace_signals + status), the trace.zip → `<token>/trace.zip`, and any failure screenshot →
// `<token>/screenshot.png`. Never touches the DB. Artifacts are SIZE-CAPPED here so a runaway spec can't fill
// the container (the storage version of the #269 self-DoS); an over-cap artifact is dropped and the poll shows
// it honestly-absent.
import { runSandboxPreview } from './runSandboxPreview.js';
import { uploadSandboxArtifact, uploadSandboxResult } from './sandboxUpload.js';

// ★ Artifact caps. A simple flow's trace.zip is well under 20 MB; a multi-nav/heavy-page runaway is bounded. A
//   full-page PNG is ~0.5–2 MB, so 4 MB is generous. Over-cap → DROPPED (steps + signals still serve; the
//   missing artifact renders honestly-absent). stdout in the result JSON is bounded so a stdout-spamming spec
//   can't bloat `<token>.json`.
const TRACE_CAP_BYTES = 20 * 1024 * 1024;
const SCREENSHOT_CAP_BYTES = 4 * 1024 * 1024;
const STDOUT_CAP_BYTES = 128 * 1024;

async function main(): Promise<void> {
  const b64 = process.env.SW_SANDBOX_SPEC_B64;
  const target = process.env.SW_SANDBOX_TARGET_URL ?? 'https://example.com';
  if (!b64) {
    process.stderr.write('sandboxMain: SW_SANDBOX_SPEC_B64 not set (the api sets it on jobs/start)\n');
    process.exit(2);
  }
  const spec = Buffer.from(b64, 'base64').toString('utf8');
  const token = process.env.SW_SANDBOX_RESULT_TOKEN;
  const result = await runSandboxPreview(spec, { targetUrl: target });

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
