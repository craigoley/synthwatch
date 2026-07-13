// ★★★ THE STRUCTURAL NO-MUTE PROOF (B3-3 non-negotiable #2). The flake budget must have NO write path to alert
// routing / notification suppression / tag_routes / any notify surface — proven STRUCTURALLY, not by convention.
// A monitor that flaps because the SERVICE is flaky is telling the truth; muting it would mean "the flakier your
// service, the quieter your monitoring" — a safety inversion. So the machinery must be INCAPABLE of muting an
// alert, not merely currently not doing so.
//
// Runner side of the proof:
//   1. flake_status() is a READ-ONLY function — no INSERT/UPDATE/DELETE, and no reference to any alert/routing/
//      notification/mute surface. It is STRUCTURALLY a SELECT.
//   2. The runner has NO flake→alert wiring at all: flake_status / flake_target appear in NO runner source
//      module (they're read only by the API, and the runner never routes an alert off a flake signal).
// (The API side has the companion grep-assert over its alert-routing surfaces.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Repo root — resolve by walking up until db/schema.sql exists (robust to tsx-in-place runner/ AND compiled
// runner/dist/, where '..' would otherwise land inside runner/).
function repoRoot(): string {
  let d = import.meta.dirname;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(d, 'db', 'schema.sql'))) return d;
    d = join(d, '..');
  }
  throw new Error('repo root (db/schema.sql) not found');
}
const ROOT = repoRoot();

test('★★★ flake_status() is READ-ONLY — no write path, no alert/routing/mute surface', () => {
  const schema = readFileSync(join(ROOT, 'db', 'schema.sql'), 'utf8');
  const start = schema.indexOf('CREATE OR REPLACE FUNCTION flake_status');
  assert.ok(start >= 0, 'flake_status must be defined in schema.sql');
  // The function body ends at the closing `$$;` of its AS $$ ... $$ block.
  const bodyStart = schema.indexOf('AS $$', start);
  const bodyEnd = schema.indexOf('$$;', bodyStart);
  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart, 'flake_status body must be delimited');
  const body = schema.slice(bodyStart, bodyEnd).toLowerCase();

  // A mutating statement anywhere in the body would be a write path. There is none — it is a pure SELECT.
  for (const kw of ['insert ', 'update ', 'delete ', 'merge ', ' into ']) {
    assert.ok(!body.includes(kw), `flake_status body must contain no "${kw.trim()}" (it is read-only)`);
  }
  // And no reference to ANY alert/routing/notification/mute surface — the function cannot touch them.
  for (const surface of ['tag_routes', 'alert', 'notif', 'route', 'mute', 'suppress', 'silence', 'incident', 'page']) {
    assert.ok(!body.includes(surface), `flake_status must not reference "${surface}" — no path to notification`);
  }
});

test('★★★ the RUNNER has no flake→alert wiring: flake_status/flake_target appear in NO alert/routing module', () => {
  // Every runner .ts EXCEPT tests (which assert the negatives) + this file.
  const files = readdirSync(join(ROOT, 'runner'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const referencing: string[] = [];
  for (const f of files) {
    const src = readFileSync(join(ROOT, 'runner', f), 'utf8');
    if (/flake_status|flake_target|flakeStatus|flakeTarget/.test(src)) referencing.push(f);
  }
  // The runner never READS the flake budget (it's an API/dashboard concern) — so no source module references it,
  // and in particular the alert-dispatch/routing modules (alerts.ts, evaluate.ts's paging path) cannot act on it.
  const alertModules = referencing.filter((f) =>
    /alert|notif|route|dispatch|page|incident|burn/i.test(f),
  );
  assert.deepEqual(
    alertModules,
    [],
    `no runner alert/routing module may reference the flake budget — found: ${alertModules.join(', ')}`,
  );
  // Stronger: today NO runner source references it at all (the whole consequence is an API-surfaced TASK, never
  // a runner-side alert). If that ever changes, this documents where to re-audit.
  assert.deepEqual(
    referencing,
    [],
    `the runner defines flake_status (SQL) but must not READ it — found references in: ${referencing.join(', ')}`,
  );
});
