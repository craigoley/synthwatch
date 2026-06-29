#!/usr/bin/env node
// Matcher-coverage guard — fail CI when a monitors spec uses an expect() matcher the runner's mini-expect
// shim does NOT implement (which would throw a TypeError in a LIVE run while passing local `playwright
// test`, since lib/flow re-exports the REAL Playwright expect). This is the meta-lesson-D parity guard
// extended from the lib/flow VENDORED block to the expect MATCHER SURFACE — the gap that took down
// meals2go (.toBe(200)/.toBeGreaterThan(0) on value targets → ".toBe is not a function").
//
//   • a used matcher missing from the shim -> FAIL CLOSED (add it to specShim's expect + SUPPORTED_MATCHERS).
//   • monitors source missing (a checkout blip) -> SKIP exit 0 (not a divergence; resumes next run).
//
// SUPPORTED_MATCHERS in specShim.ts is the single source of truth. Source: env MONITORS_SRC (the CI
// workflow checks out monitors@main and points here). Reads a checked-out dir (not raw.github) — no CDN.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SHIM = 'runner/specfetch/specShim.ts';
const MON = process.env.MONITORS_SRC; // a checked-out synthwatch-monitors dir

const fail = (msg) => { console.error(`::error::expect-matcher coverage: ${msg}`); process.exit(1); };
const skip = (msg) => { console.log(`expect-matcher coverage: ${msg}`); process.exit(0); };
const pass = (msg) => { console.log(`expect-matcher coverage: ${msg}`); process.exit(0); };

// `to*` methods that are plain JS (NOT Playwright matchers) — excluded from the "used matcher" scan.
const JS_TO_METHODS = new Set([
  'toString', 'toLowerCase', 'toUpperCase', 'toFixed', 'toLocaleString', 'toLocaleLowerCase',
  'toLocaleUpperCase', 'toJSON', 'toISOString', 'toDateString', 'toTimeString', 'toPrecision',
  'toExponential', 'toLocaleDateString', 'toLocaleTimeString',
]);

// 1) the matchers the shim implements (SUPPORTED_MATCHERS in specShim.ts).
if (!existsSync(SHIM)) fail(`${SHIM} not found (run from the runner repo root).`);
const shimSrc = readFileSync(SHIM, 'utf8');
const block = shimSrc.match(/SUPPORTED_MATCHERS\s*=\s*\[([^\]]*)\]/s);
if (!block) fail(`${SHIM} has no SUPPORTED_MATCHERS array — the coverage guard can't read the shim's surface.`);
const supported = new Set([...block[1].matchAll(/['"]([a-zA-Z0-9]+)['"]/g)].map((m) => m[1]));

// 2) the matchers the specs use (monitors@main checked out by CI). Missing source => SKIP (blip).
if (!MON || !existsSync(join(MON, 'monitors'))) {
  skip(`monitors specs not available at MONITORS_SRC="${MON ?? '(unset)'}" — SKIPPING (could not fetch; NOT a divergence).`);
}
function specFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...specFiles(p));
    else if (p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}
const used = new Map();
for (const f of specFiles(join(MON, 'monitors'))) {
  const text = readFileSync(f, 'utf8');
  // `.toX(` where X starts uppercase = a matcher-shaped call (catches multi-line expect chains too).
  for (const m of text.matchAll(/\.(to[A-Z][A-Za-z0-9]*)\s*\(/g)) {
    if (!JS_TO_METHODS.has(m[1])) used.set(m[1], (used.get(m[1]) ?? 0) + 1);
  }
}

// 3) any used matcher the shim doesn't implement -> FAIL CLOSED.
const missing = [...used.keys()].filter((m) => !supported.has(m)).sort();
if (missing.length) {
  fail(
    `monitors specs use expect matcher(s) the runner shim does NOT implement: ${missing.join(', ')}. ` +
    `They pass local \`playwright test\` (real expect) but throw a TypeError in the runner (mini-shim). ` +
    `Implement each in ${SHIM} expect() and add it to SUPPORTED_MATCHERS — or, if it's not a matcher, ` +
    `add it to JS_TO_METHODS in this script.`,
  );
}
pass(`all ${used.size} expect matcher(s) used by specs are implemented by the shim (${[...used.keys()].sort().join(', ')}).`);
