#!/usr/bin/env node
// Playwright pairing gate — assert runner/Dockerfile's base-image version == the `playwright` version in
// runner/package-lock.json. Turns the Dockerfile's "bump BOTH together" COMMENT into an enforced CHECK.
//
// THE OUTAGE IT PREVENTS (2026-07-25): #368 (a Dependabot group-bump) moved npm `playwright` 1.61.1→1.62.0
// but not the Dockerfile, which stayed on base image v1.61.0-noble. The base image bundles the browsers
// (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1), and a MINOR drift bumps the chrome-headless-shell revision, so every
// browser check died at runtime: "browserType.launch: Executable doesn't exist at
// .../chromium_headless_shell-<rev>/...". Nothing caught it — the rule to bump both was a comment, and
// Dependabot can't read comments. This static check would have RED-ed #368's CI and prevented the outage.
//
// This is the FAST, pre-build sibling of browser-smoke.yml: the smoke PROVES the pairing by launching a
// browser in the built image (~minutes, path-filtered); this asserts the versions match by static parse
// (~milliseconds, every PR) and names the exact fix. Same spirit as check-libflow-parity / schema-parity.
//
// Usage:  node scripts/check-playwright-pairing.mjs [--self-test]
//   (default)     parse the REAL runner/Dockerfile + runner/package-lock.json, assert they match.
//   --self-test   reconstruct #368's exact drift (Dockerfile 1.61.0 / lock 1.62.0) → must RED, and a
//                 matched pair → must GREEN. Proves the engine actually fails on drift (prove-can-fail).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCKERFILE = join(ROOT, 'runner', 'Dockerfile');
const LOCKFILE = join(ROOT, 'runner', 'package-lock.json');

// ── pure core (exported for --self-test) ───────────────────────────────────────────────────────────────

/** The Playwright version in `FROM mcr.microsoft.com/playwright:vX.Y.Z-<variant>` (noble/jammy/…), or null.
 *  Anchors on the mcr playwright image specifically so an unrelated FROM (a multi-stage build) can't match. */
export function dockerfilePlaywrightVersion(dockerfileText) {
  const m = dockerfileText.match(/^FROM\s+mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-[a-z0-9]+/m);
  return m ? m[1] : null;
}

/** The resolved `playwright` version from a package-lock.json (npm lockfile v2/v3 `packages` map), or null.
 *  Uses the LOCK (the version actually installed), not package.json's range — that's what the image runs. */
export function lockPlaywrightVersion(lockText) {
  let lock;
  try {
    lock = JSON.parse(lockText);
  } catch {
    return null;
  }
  return lock?.packages?.['node_modules/playwright']?.version ?? null;
}

/**
 * Compare the two. Returns { dockerVersion, lockVersion, match, error }.
 *   error (a string) when EITHER side can't be parsed — treated as a FAILURE by the CLI (fail-closed: a check
 *   that can't read one side must not pass silently, the vacuous-green class the fleet's guards ban).
 *   match=true only when both parsed AND are equal.
 */
export function comparePairing(dockerfileText, lockText) {
  const dockerVersion = dockerfilePlaywrightVersion(dockerfileText);
  const lockVersion = lockPlaywrightVersion(lockText);
  if (dockerVersion == null) return { dockerVersion, lockVersion, match: false, error: 'could not parse the playwright base-image version from runner/Dockerfile' };
  if (lockVersion == null) return { dockerVersion, lockVersion, match: false, error: 'could not parse the playwright version from runner/package-lock.json' };
  return { dockerVersion, lockVersion, match: dockerVersion === lockVersion, error: null };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────

const fail = (msg) => { console.error(`::error::Playwright pairing: ${msg}`); process.exit(1); };
const pass = (msg) => { console.log(`Playwright pairing: ${msg}`); process.exit(0); };

function runSelfTest() {
  let fails = 0;
  const check = (desc, actual, expected) => {
    if (actual === expected) { console.log(`  PASS  ${desc}`); }
    else { console.log(`  FAIL  ${desc}\n          expected: ${expected}\n          actual:   ${actual}`); fails++; }
  };

  // ★ #368 RECONSTRUCTION (the prove-can-fail): the exact drift that took prod down — npm 1.62.0, Dockerfile
  //   1.61.0 — MUST be flagged as a mismatch. This is the case that would have red-ed #368's CI.
  const drifted = comparePairing(
    'FROM mcr.microsoft.com/playwright:v1.61.0-noble\nWORKDIR /app\n',
    JSON.stringify({ packages: { 'node_modules/playwright': { version: '1.62.0' } } }),
  );
  check('1 #368 drift (Dockerfile 1.61.0 / lock 1.62.0) is a MISMATCH', drifted.match, false);
  check('1 #368 drift names the Dockerfile version', drifted.dockerVersion, '1.61.0');
  check('1 #368 drift names the lock version', drifted.lockVersion, '1.62.0');

  // A matched pair (the fixed 1.61.1 state) must PASS.
  const matched = comparePairing(
    'FROM mcr.microsoft.com/playwright:v1.61.1-noble\nWORKDIR /app\n',
    JSON.stringify({ packages: { 'node_modules/playwright': { version: '1.61.1' } } }),
  );
  check('2 matched pair (1.61.1 / 1.61.1) MATCHES', matched.match, true);

  // A -jammy / other variant must still parse (only the version must match, not the OS variant).
  const jammy = comparePairing(
    'FROM mcr.microsoft.com/playwright:v1.61.1-jammy\n',
    JSON.stringify({ packages: { 'node_modules/playwright': { version: '1.61.1' } } }),
  );
  check('3 non-noble variant still compares by VERSION', jammy.match, true);

  // FAIL-CLOSED: an unparseable side is an error (never a silent pass).
  check('4 unparseable Dockerfile → error (fail-closed)', comparePairing('FROM node:22\n', '{"packages":{"node_modules/playwright":{"version":"1.61.1"}}}').error != null, true);
  check('4 unparseable lock → error (fail-closed)', comparePairing('FROM mcr.microsoft.com/playwright:v1.61.1-noble\n', 'not json').error != null, true);

  console.log('');
  if (fails === 0) { console.log('check-playwright-pairing self-test: ALL PASSED (drift REDS, matched GREENS, fail-closed)'); process.exit(0); }
  console.log(`check-playwright-pairing self-test: ${fails} FAILED`); process.exit(1);
}

function main() {
  if (process.argv[2] === '--self-test') return runSelfTest();

  if (!existsSync(DOCKERFILE)) fail(`runner/Dockerfile not found at ${DOCKERFILE} (run from the repo root).`);
  if (!existsSync(LOCKFILE)) fail(`runner/package-lock.json not found at ${LOCKFILE}.`);

  const { dockerVersion, lockVersion, match, error } = comparePairing(
    readFileSync(DOCKERFILE, 'utf8'),
    readFileSync(LOCKFILE, 'utf8'),
  );
  if (error) fail(`${error} — cannot verify the base-image ⇄ npm Playwright pairing.`);
  if (!match) {
    fail(
      `base-image ⇄ npm Playwright version DRIFT — runner/Dockerfile is on v${dockerVersion}-* but ` +
      `runner/package-lock.json has playwright ${lockVersion}. The base image bundles the browsers, so a ` +
      `mismatch ships a runtime "chromium.launch(): Executable doesn't exist" outage through a green build ` +
      `(the 2026-07-25 / #368 incident). FIX: set runner/Dockerfile FROM ...playwright:v${lockVersion}-noble ` +
      `to match the npm version (and confirm that vX.Y.Z-noble tag EXISTS on mcr — 1.62.0 did not), OR pin ` +
      `npm playwright back to ${dockerVersion}. Bump BOTH together.`,
    );
  }
  pass(`OK — runner/Dockerfile base image and package-lock playwright both at ${lockVersion} (matched).`);
}

// Run as CLI only when invoked directly, so a test can import the pure helpers (comparePairing, …) without
// triggering the CLI / process.exit — the same guard check-enum-coverage.mjs uses.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
