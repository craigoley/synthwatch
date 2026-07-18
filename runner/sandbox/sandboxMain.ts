// The `synthwatch-sandbox` ACA job entrypoint (infra/main.bicep runs `node dist/sandbox/sandboxMain.js`).
// It runs under the SANDBOX identity with a SECRET-FREE, allowlist env — NO CRED_ENC_KEY, NO prod DATABASE_URL,
// NO DB grant — so this whole process is the low-privilege blast-radius box the design promises.
//
// The api passes the uploaded spec as base64 in the SW_SANDBOX_SPEC_B64 env (set on jobs/start), runs the
// preview, writes the JSON result to stdout AND uploads it to the sandbox blob container as `<token>.json` (the
// sandbox identity's ONLY storage grant — infra/main.bicep) so the api's GET /preview/{token} can fetch it.
// Never touches the DB. ★ REMAINING SEAM (tier-1 real trace): sandboxChild still returns `trace:'seam'` — the
// uploaded result carries the compiled/loaded test names + captured stdout, not yet a Playwright trace.
import { runSandboxPreview } from './runSandboxPreview.js';
import { uploadSandboxResult } from './sandboxUpload.js';

async function main(): Promise<void> {
  const b64 = process.env.SW_SANDBOX_SPEC_B64;
  const target = process.env.SW_SANDBOX_TARGET_URL ?? 'https://example.com';
  if (!b64) {
    process.stderr.write('sandboxMain: SW_SANDBOX_SPEC_B64 not set (the api sets it on jobs/start)\n');
    process.exit(2);
  }
  const spec = Buffer.from(b64, 'base64').toString('utf8');
  const result = await runSandboxPreview(spec, { targetUrl: target });
  const resultJson = JSON.stringify(result);
  // stdout for the execution log; the blob for the api poll (best-effort — never fail the run on egress).
  process.stdout.write(resultJson + '\n');
  await uploadSandboxResult(process.env.SW_SANDBOX_RESULT_TOKEN, resultJson);
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`sandboxMain: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
