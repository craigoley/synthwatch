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
test('★ a spec cannot reach the prod DB — DATABASE_URL is absent, and a Postgres client cannot even be imported', async () => {
  await withPlantedSecrets(async () => {
    // (a) DATABASE_URL is not in the child env — you cannot write a DB you cannot locate or authenticate to.
    const probe = `
      import { test } from '../../lib/flow';
      console.log('__DBURL__' + (process.env.DATABASE_URL ? 'PRESENT' : 'ABSENT'));
      test('probe', async () => {});
    `;
    const r = await runSandboxPreview(probe, { targetUrl: 'https://example.com', timeoutMs: 30_000 });
    assert.equal(r.ok, true, `spec should load; stderr=${r.stderr}`);
    assert.ok(r.stdout.includes('__DBURL__ABSENT'), 'DATABASE_URL must be absent in the sandbox');

    // (b) a spec importing a Postgres client FAILS the static gate (esbuild bundles only node built-ins +
    //     the lib/flow alias; an npm package cannot be resolved) → it never runs at all.
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
