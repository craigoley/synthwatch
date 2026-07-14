// ★ STATUS-TAXONOMY DOC TRIPWIRE — mirrors synthwatch-api's AuthGatesDocParityTests. Gates the STRUCTURAL
// claim ONLY: docs/STATUS-TAXONOMY.md's STATUS-ENUM block must list EXACTLY the runs.status enum — no more, no
// fewer — in BOTH directions. It does NOT gate the prose about each status (when it's emitted, what it means);
// that is semantic, unenforceable, and carries the honest stamp. A doc that UNDER-describes (a status in code
// but not the doc) or INVENTS one (in the doc but not code) reds this test BY NAME.
//
// Three sources, all must agree — so "the doc lists the enum" can't be satisfied by a code enum that has itself
// drifted from the DB constraint:
//   • RunStatus            — runner/db.ts       (the TS enum the runner reflects)
//   • runs_status_check    — db/schema.sql      (the CHECK the DB enforces)
//   • the STATUS-ENUM block — docs/STATUS-TAXONOMY.md (the doc under test)
// No DB needed (pure file parse) → runs in the unit suite, every PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function repoRoot(): string {
  let d = import.meta.dirname;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(d, 'db', 'schema.sql'))) return d;
    d = join(d, '..');
  }
  throw new Error('repo root (db/schema.sql) not found');
}
const ROOT = repoRoot();

const singleQuoted = (s: string): string[] => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);

/** RunStatus union members, reflected from runner/db.ts. */
function runStatusEnum(): string[] {
  const src = readFileSync(join(ROOT, 'runner', 'db.ts'), 'utf8');
  const m = src.match(/export type RunStatus\s*=\s*([^;]+);/);
  assert.ok(m, 'runner/db.ts: `export type RunStatus = …;` not found — the tripwire lost its source (was it renamed?)');
  return singleQuoted(m![1]);
}

/** The runs.status CHECK set from db/schema.sql — DEFAULT 'running' uniquely identifies the runs column
 *  (run_steps.status has a different, DEFAULT-less CHECK). */
function schemaRunsEnum(): string[] {
  const schema = readFileSync(join(ROOT, 'db', 'schema.sql'), 'utf8');
  const m = schema.match(/status\s+TEXT\s+NOT NULL DEFAULT 'running'\s+CHECK \(status IN \(([^)]+)\)\)/);
  assert.ok(m, "db/schema.sql: the runs.status CHECK (the one with DEFAULT 'running') not found");
  return singleQuoted(m![1]);
}

/** The doc's machine-parseable STATUS-ENUM block (backtick tokens between the sentinels). */
function docEnum(): string[] {
  const doc = readFileSync(join(ROOT, 'docs', 'STATUS-TAXONOMY.md'), 'utf8');
  const m = doc.match(/<!-- STATUS-ENUM:START -->([\s\S]*?)<!-- STATUS-ENUM:END -->/);
  assert.ok(m, 'docs/STATUS-TAXONOMY.md: the STATUS-ENUM:START/END markers are missing');
  return [...m![1].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
}

function symmetricDiff(a: string[], b: string[]) {
  const A = new Set(a), B = new Set(b);
  return { onlyA: [...A].filter((x) => !B.has(x)), onlyB: [...B].filter((x) => !A.has(x)) };
}

test('status taxonomy: RunStatus (db.ts) === runs_status_check (schema.sql) — the reflected code enum matches the DB', () => {
  const code = runStatusEnum(), db = schemaRunsEnum();
  assert.ok(code.length >= 2 && db.length >= 2, 'parsed too few members — a source parser broke');
  const { onlyA, onlyB } = symmetricDiff(code, db);
  assert.deepEqual(
    { inDbTsOnly: onlyA, inSchemaOnly: onlyB },
    { inDbTsOnly: [], inSchemaOnly: [] },
    `RunStatus (db.ts) vs runs_status_check (schema.sql) DRIFT — reflecting db.ts would lie: fix so they agree.`,
  );
});

test('status taxonomy: docs/STATUS-TAXONOMY.md lists EXACTLY the RunStatus enum (no more, no fewer)', () => {
  const code = runStatusEnum(), doc = docEnum();
  assert.ok(doc.length >= 2, 'the doc STATUS-ENUM block parsed too few tokens — markers/format broke');
  const { onlyA, onlyB } = symmetricDiff(code, doc);
  assert.deepEqual(
    { inCodeNotDoc: onlyA, inDocNotCode: onlyB },
    { inCodeNotDoc: [], inDocNotCode: [] },
    `STATUS-TAXONOMY.md DRIFT — status in CODE but MISSING from the doc: [${onlyA}] (doc under-describes); ` +
      `status in the DOC but NOT in code: [${onlyB}] (doc invents one). Update the STATUS-ENUM block to match.`,
  );
});
