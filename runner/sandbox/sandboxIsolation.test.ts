// ★★ THE ACCEPTANCE TEST for the sandbox preview. The sandbox's safety IS the feature — if either of these
// leaks, it does not ship. Runs offline (no DB, no Azure): the child-process allowlist (sandboxEnv) makes the
// "hostile spec sees no prod secret" property provable HERE by planting fake secrets in the parent env and
// proving the executed spec cannot see them. (The authoritative infra layer — a separate secret-free ACA
// identity with no DB grant, infra/main.bicep — is asserted by review + the deploy, not runnable off-Azure.)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSandboxPreview } from './runSandboxPreview.js';
import { PROD_SECRET_ENV_NAMES } from './sandboxEnv.js';

const FAKE = {
  CRED_ENC_KEY: 'FAKE_CREDENCKEY_bXVzdF9ub3RfbGVhaw',
  DATABASE_URL: 'postgres://FAKE_DBUSER:FAKE_DBPASS@prod-db:5432/synthwatch',
  ACS_EMAIL_CONNECTION_STRING: 'endpoint=https://fake.acs;accesskey=FAKE_ACS_LEAK',
  AZURE_OPENAI_API_KEY: 'FAKE_AOAI_KEY_leak',
  VERCEL_BYPASS_TOKEN: 'FAKE_VERCEL_leak',
} as const;

/** Plant fake prod secrets in THIS (parent) process's env for the duration of a body, then restore. If the
 *  child inherited the parent env, these distinctive values would surface in its output. */
async function withPlantedSecrets(body: () => Promise<void>): Promise<void> {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(FAKE)) {
    prior[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    await body();
  } finally {
    for (const k of Object.keys(FAKE)) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  }
}

// ── PROVE-CAN-FAIL 1: a spec that prints process.env → NO prod secret appears ───────────────────────────
test('★ a spec that dumps process.env sees NO prod secret (allowlist env, not inherited)', async () => {
  await withPlantedSecrets(async () => {
    const hostile = `
      import { test } from '../../lib/flow';
      console.log('__ENVDUMP__' + JSON.stringify(process.env));
      test('probe', async () => {});
    `;
    const r = await runSandboxPreview(hostile, { targetUrl: 'https://example.com', timeoutMs: 30_000 });
    assert.equal(r.ok, true, `spec should load; stderr=${r.stderr}`);
    assert.deepEqual(r.tests, ['probe']);

    // The spec's dump is on the child's stdout — parse it and assert isolation two ways.
    const line = r.stdout.split('\n').find((l) => l.startsWith('__ENVDUMP__'));
    assert.ok(line, 'the spec printed its env');
    const childEnv = JSON.parse(line!.slice('__ENVDUMP__'.length)) as Record<string, string>;

    // (a) no prod-secret KEY is present in the child env.
    for (const name of PROD_SECRET_ENV_NAMES) {
      assert.ok(!(name in childEnv), `LEAK: ${name} is present in the sandbox child env`);
    }
    // (b) no prod-secret VALUE appears ANYWHERE in the child's output (defends against a renamed/derived leak).
    for (const [name, value] of Object.entries(FAKE)) {
      assert.ok(!r.stdout.includes(value), `LEAK: the value of ${name} appeared in sandbox output`);
    }
  });
});

// ── PROVE-CAN-FAIL 2: a spec cannot reach or write the prod DB ──────────────────────────────────────────
test('★ a spec cannot locate or authenticate to the prod DB — DATABASE_URL/creds are absent (and the DB client cannot be imported)', async () => {
  await withPlantedSecrets(async () => {
    // (a) THE REAL DEFENSE: DATABASE_URL (and every cred) is absent from the child env — you cannot reach a DB
    //     you cannot locate or authenticate to. NB: node:net/node:tls remain available, so the compile gate is
    //     NOT a network boundary — a hostile spec could speak the Postgres wire protocol raw; it just has no
    //     host, no user, no password. Secret-absence is what holds, not the gate.
    const probe = `
      import { test } from '../../lib/flow';
      console.log('__DBURL__' + (process.env.DATABASE_URL ? 'PRESENT' : 'ABSENT'));
      test('probe', async () => {});
    `;
    const r = await runSandboxPreview(probe, { targetUrl: 'https://example.com', timeoutMs: 30_000 });
    assert.equal(r.ok, true, `spec should load; stderr=${r.stderr}`);
    assert.ok(r.stdout.includes('__DBURL__ABSENT'), 'DATABASE_URL must be absent in the sandbox');

    // (b) SECONDARY (defense-in-depth, NOT a network boundary): a spec importing a Postgres client FAILS the
    //     static gate (esbuild bundles only node built-ins + the lib/flow alias; an npm package cannot be
    //     resolved) → the convenient path never even compiles. This raises the bar; (a) is what guarantees it.
    const dbWrite = `
      import { test } from '../../lib/flow';
      import { Pool } from 'pg';
      test('probe', async () => { await new Pool().query("INSERT INTO spec_cache VALUES ('x')"); });
    `;
    await assert.rejects(
      () => runSandboxPreview(dbWrite, { targetUrl: 'https://example.com', timeoutMs: 30_000 }),
      /pg|resolve|Could not|build/i,
      'a spec importing a Postgres client must fail the compile gate',
    );
  });
});

// ── B2: the preview returns a REAL trace — a wrong selector is DIAGNOSABLE from the preview alone ────────
// The whole point of B2: "my selector is wrong" must be answerable without a deploy. If the trace can't show
// WHERE a selector failed (the step, its timing, the screenshot at failure), B2 isn't done.
test('★ B2: a wrong-selector spec yields a trace showing the failing step, its timing, and a screenshot', async () => {
  const wrong = `
    import { test, expect, step } from '../../lib/flow';
    test('wrong selector', async ({ page }) => {
      await step('open the page', async () => { await page.goto('https://example.com', { waitUntil: 'domcontentloaded' }); });
      await step('assert a bogus selector', async () => { await expect(page.locator('#nope-does-not-exist')).toBeVisible({ timeout: 3000 }); });
    });
  `;
  const r = await runSandboxPreview(wrong, { targetUrl: 'https://example.com', timeoutMs: 60_000 });

  assert.equal(r.status, 'fail', `expected a 'fail' verdict; stderr=${r.stderr}`);
  assert.equal(r.failedStep, 'assert a bogus selector', 'the failing step must be named');

  // Per-step status + timing — the "where did it fail" the SRE reads (the run_steps shape, same as a real check).
  const steps = r.steps ?? [];
  assert.equal(steps.length, 2, 'both steps recorded');
  assert.equal(steps[0].status, 'pass');
  assert.equal(steps[1].status, 'fail');
  assert.ok(steps[1].durationMs >= 0, 'the failing step carries a timing');
  assert.ok((steps[1].errorMessage ?? '').length > 0, 'the failing step carries an error message');

  // The diagnosable artifacts: a failure screenshot + a trace.zip, plus trace_signals (same shape a real check produces).
  assert.ok(r.screenshot && r.screenshot.byteLength > 0, 'a failure screenshot was captured');
  assert.ok(r.trace && r.trace.byteLength > 0, 'a trace.zip was captured');
  assert.ok(r.traceSignals, 'trace_signals extracted');
});

// ── BOUND: a runaway spec is hard-killed at the timeout (the DoS-on-your-own-bill guard) ────────────────
test('★ a spec that never returns is hard-killed at the timeout', async () => {
  const runaway = `
    import { test } from '../../lib/flow';
    while (true) {} // busy-loop at module top level — the RCE moment that must not outlive the budget
    test('never', async () => {});
  `;
  const r = await runSandboxPreview(runaway, { targetUrl: 'https://example.com', timeoutMs: 1_500 });
  assert.equal(r.timedOut, true, 'the runaway spec must be killed at the timeout');
  assert.equal(r.ok, false);
});
