#!/usr/bin/env node
// Parity guard — fail CI when the runner's EXECUTED lib/flow copy drifts from the authoring one.
//
// THE DRIFT (cost 3 wasted traces this session): the runner esbuild-aliases every spec's `lib/flow`
// import to runner/specfetch/specShim.ts and marks it external (compileSpec.ts), so specShim.ts is the
// copy the runner EXECUTES. monitors/lib/flow.ts is the LOCAL-DEV/authoring copy — DEAD AT RUNTIME. They
// are "vendored verbatim" with nothing keeping them in sync, so a fix to lib/flow.ts (e.g. #10's
// flow-modal exclusion) is dead at runtime until hand-mirrored into specShim.ts — and CI was silent.
//
// MECHANISM (option c — a checked-in vendor hash; chosen over a byte-compare because the two copies
// legitimately differ in TYPE imports — `import('@playwright/test').Locator` vs `Locator` — so raw text
// never matches): specShim.ts carries `LIBFLOW-VENDOR-SHA: <sha256>` = the sha256 of lib/flow.ts's
// SHARED block (delimited by `>>> / <<< SHARED-WITH-RUNNER-SPECSHIM` markers). This script extracts that
// block from lib/flow.ts, hashes it, and compares.
//   • match            -> pass (in sync).
//   • mismatch         -> FAIL CLOSED (a lib/flow change is dead at runtime until mirrored here).
//   • source missing   -> SKIP, exit 0 (a monitors-checkout blip must NOT red-CI the whole fleet —
//                         distinct from a real divergence; the check resumes next run).
//   • markers absent   -> FAIL (config error: lib/flow.ts lost its markers — fix the guard/markers).
//
// Source: env LIBFLOW_SRC (a path to monitors/lib/flow.ts — the CI workflow checks out monitors@main and
// points here; locally, point it at your monitors clone). Reading a checked-out file (not raw.github)
// is deterministic — no CDN propagation lag (the exact staleness class we diagnosed for spec fetches).
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SHIM = 'runner/specfetch/specShim.ts';
const SRC = process.env.LIBFLOW_SRC; // path to monitors/lib/flow.ts
const BEGIN = '// >>> SHARED-WITH-RUNNER-SPECSHIM';
const END = '// <<< SHARED-WITH-RUNNER-SPECSHIM';
const SHA_RE = /LIBFLOW-VENDOR-SHA:\s*([0-9a-f]{64})/;

const fail = (msg) => { console.error(`::error::Lib-flow parity: ${msg}`); process.exit(1); };
const skip = (msg) => { console.log(`Lib-flow parity: ${msg}`); process.exit(0); };
const pass = (msg) => { console.log(`Lib-flow parity: ${msg}`); process.exit(0); };

// sha256 of the marked block (content between the markers, trimmed — marker lines excluded).
function blockSha(text) {
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b === -1 || e === -1 || e < b) return null;
  return createHash('sha256').update(text.slice(b + BEGIN.length, e).trim()).digest('hex');
}

// 1) expected sha, from specShim.ts (the executed copy).
if (!existsSync(SHIM)) fail(`${SHIM} not found (run from the runner repo root).`);
const shimMatch = readFileSync(SHIM, 'utf8').match(SHA_RE);
if (!shimMatch) {
  fail(`${SHIM} is missing its "LIBFLOW-VENDOR-SHA: <sha256>" line — add it (the sha of lib/flow.ts's shared block).`);
}
const expected = shimMatch[1];

// 2) the source lib/flow.ts (checked out by CI). Missing => SKIP (fetch blip, not a divergence).
if (!SRC || !existsSync(SRC)) {
  skip(`monitors lib/flow.ts not available at LIBFLOW_SRC="${SRC ?? '(unset)'}" — SKIPPING (could not fetch; NOT a divergence).`);
}
const actual = blockSha(readFileSync(SRC, 'utf8'));
if (actual === null) {
  fail(`${SRC} is missing the ${BEGIN} … ${END} markers — add them around the shared helpers (the block the runner vendors).`);
}

// 3) compare.
if (actual !== expected) {
  fail(
    `specShim.ts is OUT OF SYNC with lib/flow.ts — a lib/flow change is DEAD AT RUNTIME until mirrored here; ` +
    `update ${SHIM} (the executed copy) to match, then set its LIBFLOW-VENDOR-SHA to ${actual}. ` +
    `(expected ${expected}, got ${actual})`,
  );
}
pass(`specShim.ts is in sync with lib/flow.ts (sha ${actual.slice(0, 12)}…).`);
