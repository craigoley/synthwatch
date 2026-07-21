// ── ★ GOLDEN PARITY: buildResultPayload ───────────────────────────────────────────────────────────────────
// The result payload is produced HERE and reaches the dashboard inside PreviewStatusDto.Trace, an OPAQUE
// STRING — synthwatch-api has no hasScreenshot field, so the dashboard's captured-fixture harness cannot
// anchor this shape (see that repo's contract/README.md, "Known-uncapturable seams"). The anchor lives at
// the producer, and this is it.
//
// ★ SCOPE AND LIMIT, stated so nobody over-trusts it: trace-signals-golden feeds a CAPTURED artifact in and
//   records the output. This golden's inputs are CONSTRUCTED, so it is inputs-chosen + outputs-recorded. It
//   reds on DRIFT — a field added, dropped, renamed, re-ordered or silently re-derived — but it does not
//   prove the inputs resemble reality, and it cannot catch a change in what runSandboxPreview PRODUCES that
//   this builder faithfully passes through. Fiction risk is reduced (not eliminated) by capturing each arm's
//   `result` from a REAL runSandboxPreview run and normalising only non-deterministic VALUES — see
//   test-fixtures/preview-result-golden/README.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildResultPayload } from './sandboxResult.js';
import type { PreviewResult } from './runSandboxPreview.js';

interface Arm {
  name: string;
  provenance: string;
  result: PreviewResult;
  artifacts: { hasTrace: boolean; hasScreenshot: boolean };
  expected: Record<string, unknown>;
}

// Resolve across both run modes — tsx in-place (runner/) and compiled (runner/dist/) — exactly as
// traceSignals.test.ts's goldenDir() does.
function goldenDir(): string {
  const candidates = [
    join(import.meta.dirname, '..', 'test-fixtures', 'preview-result-golden'),
    join(import.meta.dirname, '..', '..', 'test-fixtures', 'preview-result-golden'),
  ];
  for (const c of candidates) if (existsSync(join(c, 'arms.json'))) return c;
  throw new Error(`golden fixture dir not found (tried: ${candidates.join(', ')})`);
}

const golden = JSON.parse(readFileSync(join(goldenDir(), 'arms.json'), 'utf8')) as { arms: Arm[] };

test('★ golden parity: buildResultPayload(arm) === expected, for every arm', () => {
  // All THREE arms are required. A two-arm golden (pass/fail) would encode "failing ⇒ screenshot", which is
  // a rule the code does NOT make: the flags mean captured AND within cap AND uploaded.
  assert.equal(golden.arms.length, 3, 'the golden must cover pass, fail-under-cap and fail-OVER-cap');

  for (const arm of golden.arms) {
    const actual = JSON.parse(JSON.stringify(buildResultPayload(arm.result, arm.artifacts)));
    assert.deepEqual(actual, arm.expected, `golden arm "${arm.name}"`);
  }
});

test('★ the OVER-CAP arm is what a naive implementation loses', () => {
  // The two failing arms share the SAME PreviewResult and differ ONLY in the artifacts argument. So an
  // implementation that derived hasScreenshot from the result (e.g. `!!result.screenshot`) instead of taking
  // it as a parameter would return the SAME payload for both — and this assertion is what catches it.
  const fails = golden.arms.filter((a) => a.result.status === 'fail');
  assert.equal(fails.length, 2, 'two failing arms — under cap and over cap');
  assert.deepEqual(fails[0].result, fails[1].result, 'same real PreviewResult in both');
  assert.notDeepEqual(
    buildResultPayload(fails[0].result, fails[0].artifacts),
    buildResultPayload(fails[1].result, fails[1].artifacts),
    'the payloads MUST differ — if they do not, hasScreenshot is being derived rather than passed in, and ' +
      'the over-cap (captured-but-DROPPED) case has been silently collapsed into the uploaded case',
  );
});

test('the payload is exactly the 13 fields the dashboard parses — no more, no less', () => {
  // A field ADDED without updating the golden would slip past a per-field check; deepEqual above catches it,
  // and this states the count explicitly so the intent is legible.
  for (const arm of golden.arms) {
    assert.equal(Object.keys(arm.expected).length, 13, `arm "${arm.name}" must emit 13 fields`);
  }
});
