// Entry point for the red-test harness sub-command (mirrors rollupMain / reconcileMain). PR 1: PRINTS the
// result (no persistence — PR 2 adds the red_tests table + INSERT + API read). Not cron-wired; run on demand.
//
//   node dist/redTestMain.js <check_id> --fault=bad-url:<url>          # HTTP monitor: point target at a wrong url
//   node dist/redTestMain.js <check_id> --fault=route-block:<pattern>  # browser monitor: abort the anchor request
//   node dist/redTestMain.js <check_id> --method=attested --attest-outcome=red --evidence=<ref> --broke=<desc>
//
// ★ Outcome: 'red' (the monitor's assertion fired on the known-bad input — a PROVEN red-test), 'not-red' (the
// monitor stayed green — a weak assertion), or 'inconclusive' (the run failed for an UNRELATED reason — NOT a
// red-test). The harness never claims 'red' unless the monitor's own assertion went red.
import { pool } from './db.js';
import type { Check } from './db.js';
import {
  runHttpRedTest,
  runBrowserRedTest,
  recordAttested,
  persistRedTest,
  type RedTestResult,
  type Fault,
} from './redTest.js';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

/** Parse `--fault=bad-url:<url>` / `--fault=route-block:<pattern>` (the ':' splits kind from value). */
function parseFault(): Fault | null {
  const raw = arg('fault');
  if (!raw) return null;
  const sep = raw.indexOf(':');
  const kind = sep >= 0 ? raw.slice(0, sep) : raw;
  const value = sep >= 0 ? raw.slice(sep + 1) : '';
  if (kind === 'bad-url' && value) return { kind: 'bad-url', url: value };
  if (kind === 'route-block' && value) return { kind: 'route-block', pattern: value };
  return null;
}

async function loadCheck(id: number): Promise<Check | null> {
  const { rows } = await pool.query('SELECT * FROM checks WHERE id = $1', [id]);
  return (rows[0] as Check | undefined) ?? null;
}

async function main(): Promise<void> {
  const checkId = Number(process.argv[2]);
  if (!Number.isInteger(checkId)) throw new Error('usage: redTestMain.js <check_id> --fault=bad-url:<url>|route-block:<pattern> [--method=attested ...]');

  const check = await loadCheck(checkId);
  if (!check) throw new Error(`check ${checkId} not found`);

  const method = arg('method') ?? 'executed';
  let result: RedTestResult;

  if (method === 'attested') {
    const outcome = arg('attest-outcome');
    const evidence = arg('evidence');
    const broke = arg('broke');
    if ((outcome !== 'red' && outcome !== 'not-red') || !evidence || !broke) {
      throw new Error('attested needs --attest-outcome=red|not-red --evidence=<ref> --broke=<what-was-broken>');
    }
    result = recordAttested(check, { outcome, evidenceRef: evidence, whatWasBroken: broke });
  } else {
    const fault = parseFault();
    if (!fault) throw new Error('executed needs --fault=bad-url:<url> (http) or --fault=route-block:<pattern> (browser)');
    if (fault.kind === 'bad-url') {
      result = await runHttpRedTest(check, fault);
    } else {
      result = await runBrowserRedTest(check, fault);
    }
  }

  console.log(
    `[red-test] check=${result.checkId} "${check.name}" method=${result.method} ` +
      `OUTCOME=${result.outcome.toUpperCase()} verdict=${result.verdict ?? '-'} fault="${result.fault}"`,
  );
  console.log(`           ${result.detail}`);

  // ★ PR 2 — CAPTURE. Persist ONLY a confirmed red (the guardrail is in persistRedTest + the schema CHECK).
  // An inconclusive/not-red result writes NOTHING → the scorecard's redTest.captured stays honestly false.
  const persisted = await persistRedTest(result);
  console.log(
    persisted
      ? `           ✔ recorded a red_tests row (check ${result.checkId}, method ${result.method}) — /reports/trust will flip redTest.captured=true.`
      : `           ✗ NO row written (outcome=${result.outcome}) — captured stays false; only a CONFIRMED red is persisted.`,
  );

  // Exit non-zero for a NON-red executed result so a CI/wrapper can tell a proven red-test from a gap.
  if (result.method === 'executed-red-fixture' && result.outcome !== 'red') process.exitCode = 2;
}

main()
  .catch((err) => {
    console.error('[red-test] failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
