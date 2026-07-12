import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hostOfTarget,
  matchesPattern,
  inferFromDomain,
  resolveEnvironment,
  type EnvDomainMap,
} from './envDomainMap.js';

test('hostOfTarget: extracts a lowercased host from a URL / bare host, else ""', () => {
  assert.equal(hostOfTarget('https://WWW.Wegmans.com/shop'), 'www.wegmans.com');
  assert.equal(hostOfTarget('http://preview.commerce.wegmans.com'), 'preview.commerce.wegmans.com');
  assert.equal(hostOfTarget('preview.commerce.wegmans.com'), 'preview.commerce.wegmans.com'); // bare host
  assert.equal(hostOfTarget('https://localhost:3000/x'), 'localhost'); // port stripped
  assert.equal(hostOfTarget(''), '');
  assert.equal(hostOfTarget(null), '');
  assert.equal(hostOfTarget(undefined), '');
});

test('matchesPattern: exact host + *.suffix (apex AND subdomain), case-insensitive', () => {
  assert.equal(matchesPattern('preview.commerce.wegmans.com', 'preview.commerce.wegmans.com'), true); // exact
  assert.equal(matchesPattern('www.wegmans.com', 'preview.commerce.wegmans.com'), false);
  // *.suffix matches the apex AND any subdomain
  assert.equal(matchesPattern('staging.wegmans.com', '*.staging.wegmans.com'), true); // apex
  assert.equal(matchesPattern('api.staging.wegmans.com', '*.staging.wegmans.com'), true); // subdomain
  assert.equal(matchesPattern('deep.api.staging.wegmans.com', '*.staging.wegmans.com'), true);
  // a bare "staging.wegmans.com" as a suffix must NOT match an unrelated host that merely CONTAINS it
  assert.equal(matchesPattern('notstaging.wegmans.com', '*.staging.wegmans.com'), false);
  assert.equal(matchesPattern('www.wegmans.com', '*.staging.wegmans.com'), false);
});

test('inferFromDomain: first match by order wins; no match → null; empty map → null', () => {
  const map: EnvDomainMap = [
    { pattern: 'preview.commerce.wegmans.com', environment: 'staging', priority: 100 },
    { pattern: '*.staging.wegmans.com', environment: 'staging', priority: 200 },
    { pattern: 'localhost', environment: 'dev', priority: 300 },
  ];
  assert.equal(inferFromDomain('https://preview.commerce.wegmans.com/x', map), 'staging'); // exact
  assert.equal(inferFromDomain('https://api.staging.wegmans.com', map), 'staging'); // wildcard
  assert.equal(inferFromDomain('http://localhost:5000', map), 'dev');
  assert.equal(inferFromDomain('https://www.wegmans.com', map), null); // no rule
  assert.equal(inferFromDomain('https://www.wegmans.com', []), null); // empty map
  assert.equal(inferFromDomain('', map), null); // no host

  // ★ ORDERING: the FIRST (lowest-priority) matching rule wins.
  const ordered: EnvDomainMap = [
    { pattern: '*.wegmans.com', environment: 'staging', priority: 100 },
    { pattern: 'www.wegmans.com', environment: 'dev', priority: 200 },
  ];
  assert.equal(inferFromDomain('https://www.wegmans.com', ordered), 'staging'); // priority 100 wins
});

test('★ resolveEnvironment precedence: manifest > inferred > prod', () => {
  const map: EnvDomainMap = [{ pattern: '*.staging.wegmans.com', environment: 'staging', priority: 100 }];
  // (1) explicit manifest env WINS even when the host would infer something else.
  assert.equal(resolveEnvironment('prod', 'https://api.staging.wegmans.com', map), 'prod');
  assert.equal(resolveEnvironment('dev', 'https://api.staging.wegmans.com', map), 'dev');
  // (2) no manifest env → inference fills the gap.
  assert.equal(resolveEnvironment(undefined, 'https://api.staging.wegmans.com', map), 'staging');
  // (3) no manifest env + no matching rule → 'prod' (the DB default).
  assert.equal(resolveEnvironment(undefined, 'https://www.wegmans.com', map), 'prod');
});

test('★ MUST-GO-RED: WITHOUT inference (empty map) a non-declaring staging-host check stays prod; WITH it → staging', () => {
  const stagingHost = 'https://api.staging.wegmans.com';
  // The pre-PR behavior (no map): a non-declaring check on a staging host silently defaults to prod.
  assert.equal(resolveEnvironment(undefined, stagingHost, []), 'prod');
  // This PR: the map infers staging.
  const map: EnvDomainMap = [{ pattern: '*.staging.wegmans.com', environment: 'staging', priority: 100 }];
  assert.equal(resolveEnvironment(undefined, stagingHost, map), 'staging');
});

// ★ BACKFILL SAFETY: the SEEDED map (migration 0073 / schema.sql) must NOT re-tag anything currently correct.
// Every current prod host must resolve to 'prod' (no manifest env, seed only); the one staging host to
// 'staging'. Keep this list in sync with the migration's seed + the fleet's target hosts (recon 2026-07-11).
test('★ backfill-safety: the seeded map re-tags NO current prod host (35 prod / 1 staging preserved)', () => {
  const SEED: EnvDomainMap = [
    { pattern: 'preview.commerce.wegmans.com', environment: 'staging', priority: 100 },
    { pattern: '*.preview.wegmans.com', environment: 'staging', priority: 200 },
    { pattern: '*.staging.wegmans.com', environment: 'staging', priority: 200 },
    { pattern: '*.dev.wegmans.com', environment: 'dev', priority: 200 },
    { pattern: 'localhost', environment: 'dev', priority: 300 },
    { pattern: '127.0.0.1', environment: 'dev', priority: 300 },
  ];
  const CURRENT_PROD_HOSTS = [
    'httpbin.org',
    'meals2go.com',
    'qgppr19v8v-dsn.algolia.net',
    'synthwatch-api.azurewebsites.net',
    'synthwatch-dashboard.vercel.app',
    'wegapi.azure-api.net',
    'wegmansamore.com',
    'wegmans.com',
    'wegmansnextdoor.com',
    'www.meals2go.com',
    'www.wegmans.com',
    'www.wegmansnextdoor.com',
  ];
  for (const host of CURRENT_PROD_HOSTS) {
    assert.equal(
      resolveEnvironment(undefined, `https://${host}`, SEED),
      'prod',
      `seed must NOT re-tag the prod host ${host}`,
    );
  }
  // The one staging host resolves staging by the seed (and it also manifest-declares staging → same result).
  assert.equal(resolveEnvironment(undefined, 'https://preview.commerce.wegmans.com', SEED), 'staging');
});
