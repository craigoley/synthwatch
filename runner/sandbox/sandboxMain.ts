// The `synthwatch-sandbox` ACA job entrypoint (infra/main.bicep runs `node dist/sandbox/sandboxMain.js`).
// It runs under the SANDBOX identity with a SECRET-FREE, allowlist env — NO CRED_ENC_KEY, NO prod DATABASE_URL,
// NO DB grant — so this whole process is the low-privilege blast-radius box the design promises.
//
// Pass 1: the api passes the uploaded spec as base64 in the SW_SANDBOX_SPEC_B64 env (set on jobs/start), runs
// the preview, and writes the JSON result to stdout. ★ SEAM (api wiring, next increment): read the spec FROM /
// write the trace TO a dedicated `sandbox-artifacts` blob container — the sandbox identity's ONLY storage grant
// (infra/main.bicep) — so the dashboard "Tests" area and the PR check can fetch the result. Never touches the DB.
import { runSandboxPreview } from './runSandboxPreview.js';

async function main(): Promise<void> {
  const b64 = process.env.SW_SANDBOX_SPEC_B64;
  const target = process.env.SW_SANDBOX_TARGET_URL ?? 'https://example.com';
  if (!b64) {
    process.stderr.write('sandboxMain: SW_SANDBOX_SPEC_B64 not set (the api sets it on jobs/start)\n');
    process.exit(2);
  }
  const spec = Buffer.from(b64, 'base64').toString('utf8');
  const result = await runSandboxPreview(spec, { targetUrl: target });
  // SEAM: upload `result` to sandbox-artifacts/<token> for the api to poll. Pass-1: stdout.
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`sandboxMain: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
