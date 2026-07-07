# Merged-but-not-wired audit (2026-07-07)

**Analysis only.** Hunts the "shipped on main but not connected to runtime" drift class across all four
repos, after it bit twice this session (S2 host-rewrite #212 exported-but-uncalled until #216; the A4
marker shipping via a different deploy channel than the guard — the 23h outage). Every finding cites a
grep / `file:line`. Worktree at `synthwatch` origin/main HEAD `732649f`.

## Headline

**★ LIVE-RISK — the entire pre-prod-regression arc (S1a #213, S1b/c #188, S2 #212, S3 #216, header
#215) is PRODUCTION-INERT.** The columns it hinges on are **read but never written**: nothing at
runtime sets `checks.environment` to a non-default value or sets `checks.rewrite_from_origin` at all.
So `environment` is always `'prod'` (the S1 exclude never excludes anything) and `rewrite_from_origin`
is always `NULL` (S2 host-rewrite stays inert even after #216 wired the *read* path). Details in §2.

| # | Signature | Verdict |
|---|-----------|---------|
| 2 | `checks.environment` — read (api exclude), **never written** | **LIVE-RISK** |
| 2 | `checks.rewrite_from_origin` — read (runner #216), **never written** | **LIVE-RISK** |
| 3 | manifest can't declare `environment`/`rewrite_from_origin` (monitors ajv `additionalProperties:false`) | **LIVE-RISK** (same arc) |
| 1 | reconcile field-split APPLY engine (`buildApplyUpsert`/`buildChangedUpdate`) built+tested, **gated off** | LIVE-RISK-by-design (documented) |
| 1 | ~70 other "orphan" exports | BENIGN (internal helpers / test-surface) |
| 4 | env read-not-in-bicep | BENIGN (optionals w/ defaults; the marker-class was fixed #201/#202) |
| 5 | always-inert branch | the reconcile-apply gate (same as §1) |

---

## §2 (the crux) — schema columns read but never written

**`checks.environment`** (0059) and **`checks.rewrite_from_origin`** (0060):

- **READ.** `environment`: synthwatch-api slo/mttr/trust exclude `coalesce(c.environment,'prod')='prod'`
  (#188, `ReportsFunctions.cs`). `rewrite_from_origin`: runner `hostRewriteFor(check.rewrite_from_origin,
  check.target_url)` → `executeBrowser` (#216, `index.ts`).
- **WRITTEN — by nothing at runtime.** `grep -rE "environment|rewrite_from_origin" runner/*.ts | grep
  -iE "INSERT|UPDATE|SET|VALUES"` → only comments; the *only* write path that names these columns is
  `buildApplyUpsert`/`buildChangedUpdate` in `reconcile.ts`, and **that apply is GATED OFF**
  (`reconcileMain.ts:186-187` "NOTHING is applied to checks … buildApplyUpsert … NOT executed —
  computeApplyPlan only RENDERS their SQL"; `reconcile.ts:8` "buildApplyUpsert … NOT invoked by
  reconcileMain"). The B10 scoped sync that *does* run writes only `sensitive`/`redact_patterns`.
- **No other product surface sets them.** synthwatch-api: `CheckDtos.cs` / `ChecksFunctions.cs` have
  **no** `environment`/`rewrite_from_origin` field (grep → 0). synthwatch-dashboard: no check-form field
  (the only `environment*` hits are the unrelated RCA `environmentRegional` classification).

**Consequence (LIVE-RISK):** every check keeps the DB default — `environment='prod'`, `rewrite_from_origin=NULL`.
- The **S1 pre-prod exclude never fires** (no check is non-prod) — the slo/mttr/trust predicate is
  correct but dead until a check is non-prod.
- **S2 host-rewrite stays inert** — `hostRewriteFor` always returns `undefined` (its own inertness
  guard), so #216's wiring runs but never rewrites anything.
- The arc is only reachable via a **manual/seed direct-DB UPDATE** today. **One-line gap:** un-gate the
  reconcile field-split apply, OR add `environment`/`rewrite_from_origin` to the api create/update DTO,
  OR seed a check directly. (S3's monitors check — the intended writer via manifest — was not built
  this session, and even if built would be **detected as drift but not applied**, per the gate.)

---

## §1 — exported primitives with zero callers

A `grep` of every `export function/const` against non-test call sites surfaced ~70 "orphans", but
**~all are false positives**: internal helpers called by their module's main export **within the same
file** (which the cross-file grep can't see) and reached at runtime via the entrypoints — e.g.
`computeRollupForDay` ← `runRollup` ← `rollupMain`; `narrate`/`computeFactPack` ← `runNarratives` ←
`narrativeMain`; plus pure functions exported solely for unit tests. These are **BENIGN**.

**The one genuine capability-inert finding: the reconcile field-split APPLY engine.** `buildApplyUpsert`,
`buildChangedUpdate`, and the apply statements of `computeApplyPlan` are **built + unit-tested but never
executed against the DB** — `computeApplyPlan` only *renders* SQL into `reconcile_apply_plan` (audit),
and `reconcileMain` applies **only** the B10 sensitive/redact scoped sync (`reconcileMain.ts:186-203`,
`reconcile.ts:425` "GATED"). This is **deliberate + documented** ("a later PR enables it") →
**LIVE-RISK-by-design**: monitors-as-code cannot MATERIALIZE a new check or SYNC changed config (incl.
`environment`/`rewrite_from_origin`) — it only detects drift. This is the root of §2's write-gap and is
the largest instance of the audited class, held intentionally.

*(S2 host-rewrite — the exemplar orphan — is now READ-wired by #216; §2 shows the write side is still
open.)*

---

## §3 — manifest/spec fields declarable vs mapped

`environment` + `rewrite_from_origin` are now **mapped** in the runner reconcile (`Monitor` interface +
`validateManifest`, #216) — but **NOT declarable** via the published manifest: synthwatch-monitors
`manifest.schema.json` has `"additionalProperties": false` (`:14`) and no `environment`/`rewrite_from_origin`
property, so the monitors-repo ajv gate (#44) would **reject** a manifest that includes them. Net: the
runner would accept the fields, but they can't be committed to the manifest that feeds it. (The inverse
gap from the header recon still holds too: `request_headers`/`auth` are DB columns with **no** manifest
field — dashboard/seed-only.) **One-line gap:** add both properties to `manifest.schema.json`. **BENIGN
in isolation, but part of the §2 LIVE-RISK arc** — it's the declare side of the same dead pipe.

---

## §4 — env vars: code vs bicep

`process.env.*` read in the runner vs `name:` env declared in `infra/main.bicep`:

- **Read-but-not-in-bicep** (13): `OTEL_EXPORTER_OTLP_{,METRICS_,TRACES_}ENDPOINT`, `DASHBOARD_URL`,
  `RCA_{CACHE_TTL,MODEL_DEPLOYMENT,REASONING_EFFORT,TIMEOUT_MS}`, `ALERT_TIMEOUT_MS`, `SYNTHWATCH_ENV`,
  `SYNTHWATCH_MONITORS_MANIFEST_URL`, `SYNTHWATCH_OTEL_SERVICE_NAME`, `PATH`. **All BENIGN** — each is
  optional-with-a-default or a system var (OTEL unset ⇒ those channels simply don't deliver, documented;
  `SYNTHWATCH_ENV` defaults to `'production'` in otel.ts). No secret/marker among them.
- **The marker class itself (`SYNTHWATCH_DEPLOYED`) is HEALTHY:** in bicep on all jobs AND baked into the
  runner image (#201) AND asserted by `deploy.sh` VERIFY (#202) — the 23h-outage channel-mismatch is
  closed. No bicep-declared env is unread.

**Verdict: BENIGN.**

---

## §5 — always-true/false conditionals

No general dead-branch sweep is tractable by grep, but the load-bearing instance is already named: the
**reconcile field-split apply is inert by construction** — not a runtime flag but an uncalled code path
(`computeApplyPlan`'s apply statements are rendered, never executed). That is the "always-false branch"
of this codebase and it's §1/§2's root. **LIVE-RISK-by-design.**

---

## Method note

Signature-1 orphans via `grep` of `export`s vs non-test call sites (noisy — same-file wiring invisible;
manually vetted the capability-looking names against the entrypoints). Signatures 2–4 cross-checked
`db/schema.sql` columns against runner writes + `synthwatch-api` `ReportsFunctions.cs`/`CheckDtos.cs` +
`synthwatch-dashboard` + `synthwatch-monitors` `manifest.schema.json`. No code, schema, deploy, or
remote DB — analysis only. The single highest-value action: **decide how `environment`/`rewrite_from_origin`
get WRITTEN** (un-gate reconcile apply, or an api/dashboard field, or seed) — until then the pre-prod arc
is fully wired but never runs.
