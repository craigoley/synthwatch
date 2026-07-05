// WIRING proof for the prod-guard fan-out: each aux entrypoint actually ENFORCES the guard as its
// first executable statement. The verdict matrix is unit-tested in prodGuard.test.ts; what that
// can't prove is per-file placement — so these spawn the REAL compiled entrypoints (dist/*Main.js,
// the exact artifacts the ACA jobs run) as child processes and assert on exit code + stderr.
//
// The refusal cases use a prod-SUFFIX host that does not exist (test-guard.<suffix>): if the guard
// were missing or mis-placed, the child would attempt a DB connection (DNS error) instead of
// printing the refusal — so "exit 1 + REFUSING TO START on stderr" is only reachable via the guard,
// BEFORE any query (for retentionMain: before its DELETE loop can start).
//
// The pass-guard cases assert the OPPOSITE: with SYNTHWATCH_DEPLOYED=1 the stderr must NOT contain
// the refusal banner — the child then fails on the unreachable fake host (or argv validation),
// which is exactly the point: it got PAST the guard. Bounded by a kill-timer so a hung child can
// never wedge the suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIST = dirname(fileURLToPath(import.meta.url)); // dist/ — this test runs compiled
const FAKE_PROD_URL =
  'postgresql://u:p@test-guard-nonexistent.postgres.database.azure.com:5432/synthwatch';
const REFUSAL = 'REFUSING TO START';
const KILL_MS = 15_000;

const ENTRYPOINTS = [
  'retentionMain.js', // DELETEs — the scariest local-against-prod shape; gets the full matrix
  'rollupMain.js',
  'narrativeMain.js',
  'reconcileMain.js',
  'redTestMain.js',
];

interface ChildResult {
  code: number | null;
  stderr: string;
  killed: boolean;
}

function runEntry(file: string, env: Record<string, string>): Promise<ChildResult> {
  return new Promise((resolve) => {
    // Minimal env (PATH only + the case's vars): no inherited DATABASE_URL/markers can leak in.
    const child = spawn(process.execPath, [join(DIST, file)], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), KILL_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, stderr, killed: signal === 'SIGKILL' });
    });
  });
}

for (const entry of ENTRYPOINTS) {
  test(`★ ${entry}: LOCAL context + prod host → refuses BEFORE any query (exit 1 + banner)`, async () => {
    const r = await runEntry(entry, { DATABASE_URL: FAKE_PROD_URL });
    assert.equal(r.code, 1, `guard refusal exits 1 (got ${r.code}${r.killed ? ', killed' : ''})`);
    assert.ok(r.stderr.includes(REFUSAL), `stderr carries the refusal banner:\n${r.stderr}`);
    assert.ok(
      !/getaddrinfo|ENOTFOUND|ECONNREFUSED/.test(r.stderr),
      `no connection was ever attempted (refusal precedes the pool):\n${r.stderr}`,
    );
  });

  test(`${entry}: deployed context (SYNTHWATCH_DEPLOYED=1) + prod host → passes the guard silently`, async () => {
    const r = await runEntry(entry, { DATABASE_URL: FAKE_PROD_URL, SYNTHWATCH_DEPLOYED: '1' });
    // The child proceeds past the guard and then fails on the unreachable fake host / argv
    // validation — the assertion is solely that the GUARD did not fire.
    assert.ok(!r.stderr.includes(REFUSAL), `guard must not fire when the marker is present:\n${r.stderr}`);
  });
}

// retentionMain (the DELETE-er) gets the remaining two contract cases explicitly.
test('★ retentionMain: LOCAL + prod host + SYNTHWATCH_ALLOW_PROD=1 → hatch opens (guard silent)', async () => {
  const r = await runEntry('retentionMain.js', {
    DATABASE_URL: FAKE_PROD_URL,
    SYNTHWATCH_ALLOW_PROD: '1',
  });
  assert.ok(!r.stderr.includes(REFUSAL), `hatch must bypass the guard:\n${r.stderr}`);
});

test('★ retentionMain: LOCAL + LOCAL DB → proceeds (must NOT overblock local dev)', async () => {
  // 127.0.0.1:9 (discard port, nothing listens) — instant ECONNREFUSED AFTER the guard passes.
  const r = await runEntry('retentionMain.js', {
    DATABASE_URL: 'postgres://postgres@127.0.0.1:9/synthwatch_test',
  });
  assert.ok(!r.stderr.includes(REFUSAL), `a local DB must never trip the guard:\n${r.stderr}`);
});
