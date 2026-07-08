# Sensitive-monitor trace visibility — recon + safe-visibility design (2026-07-08)

**Analysis only. No code changed.** Goal: give Craig trace-level visibility into `b2c-login-test`
(`sensitive=true`, #52) **without** breaking the protection that skips its trace zip/screenshot. Evidence
is `file:line` + live prod DB (read-only). OBSERVED = code/DB seen; INFERRED = reasoned.

## TL;DR

- **It is NOT all-or-nothing today.** A sensitive run skips 4 durable artifacts (zip, success baseline,
  failure screenshot, RCA baseline) but **still captures** a redacted `trace_signals` (network + console),
  a per-step `run_steps` timeline, and `run_metrics` web-vitals. **OBSERVED** on check 353: `has_zip=false,
  has_shot=false` on every run, but `has_signals=true` (5/6), `steps=5`, `metrics=1` — **including the green run**.
- **Craig sees "no traces" because the dashboard only knows how to render the raw zip.** With `trace_url=null`,
  `RunArtifacts` returns `null` (renders nothing) and `trace_signals` is surfaced **nowhere** in the UI. The
  safe data exists in the DB (behind API auth) but has no view.
- **Recommendation: Option (a) → (d).** Surface the **already-captured, already-redacted** signals as a
  structural per-step timeline. Zero new capture, so the #219 invariants hold **by construction** — it only
  displays data that already passed the redaction gate and is already persisted. Do **not** pursue a redacted
  screenshot (b) or ephemeral raw trace (c).

---

## 1. What's captured vs skipped today

**The capture gate** — `tracePersistPlan(sensitive, status)` (`runner/redact.ts:65-72`): for `sensitive` it
returns **all four false** regardless of status:
```
{ failureTrace:false, successBaseline:false, failureScreenshot:false, baselineScreenshot:false }
```
Wired at the persist site (`runner/index.ts:581` `const persist = tracePersistPlan(sensitive, status)`),
gating the screenshot (`:586`) and the trace zip (`:612-615`). **OBSERVED.**

**What is STILL captured for a sensitive run** — the zip is written locally by Playwright, signals are
extracted **while it's in hand**, then the zip is discarded (never uploaded):
- `runner/index.ts:602-608` — `extractTraceSignals(outcome.tracePath, target, redact)` runs with the
  monitor's **redactor** (built-in token denylist + declared `redact_patterns`), scrubbing network URLs +
  console text **before** persist. Written to `runs.trace_signals` (`:659,:672`). schema: "Written for any
  traced run (success + failure)" (`db/schema.sql:266`).
- `runner/index.ts:1005-1007` — `run_steps` rows written with a **scrubbed** per-step `error_message`
  (`stepRedact` = the same redactor). Per-step timeline: `step_index, name, status(pass|fail|error),
  duration_ms, error_message` (`db/schema.sql:313-325`).
- `run_metrics` — passive web-vitals (ttfb/dcl/load/fcp/lcp), no page content (`db/schema.sql:333-345`).

**`trace_signals` shape** (`runner/traceSignals.ts:56-60`, a faithful port of the API `TraceExtractor.cs`):
- `targetHost`
- `network`: `totalRequests, wireKb, thirdPartyCount, failed[], slowest[], largest[], uncompressed[],
  topThirdParties[]`, and **`mutations[]` = {method, url, status}** — "the action under test" (the login
  POST + its response code). `traceSignals.ts:29-33`.
- `console`: `messages[] {level, origin, text}` (extension-noise filtered, scrubbed), `droppedInfoLog`,
  `droppedExtensionNoise`.

**OBSERVED — live, check 353 (`sensitive=true`, `redact_patterns` present):**

| run | status | sandbox | zip | screenshot | trace_signals | run_steps | run_metrics |
|---|---|---|---|---|---|---|---|
| 916583 | **pass** | t | ✗ | ✗ | ✓ | 5 | 1 |
| 916314 | error | t | ✗ | ✗ | ✓ | 5 | 1 |
| 915902 | error | t | ✗ | ✗ | ✗* | 5 | 1 |

\*one run's extraction returned null (bad/locked zip) — non-fatal by design (`traceSignals.ts:110-119`).

**So the answer to "is there any structural/redacted capture today?": yes, substantial** — network summary
(incl. the login mutation's method/url/status), a 5-step timeline with scrubbed errors, and web-vitals — on
**both** green and failed runs. What's lost is only the raw zip + screenshots + baseline diff.

## 2. What the dashboard shows for a sensitive (no-zip) run

- **`RunArtifacts`** (`synthwatch-dashboard/src/components/run-history.tsx:28-83`): `screenshot =
  run.screenshot_url ? … : null` and `traceProxy = run.trace_url ? … : null`. For a sensitive run both are
  null, so **line 37 `if (!screenshot && !traceProxy) return null;` → the whole artifacts section renders
  nothing** (no message, no fallback). **OBSERVED.**
- `RunArtifacts` is itself only mounted on **failed** runs (`run-history.tsx:187` `{failed && <RunArtifacts>}`).
- The **AI-insights** and **baseline-diff** panels are nested *inside* the `traceProxy &&` block
  (`run-history.tsx:76,78`) — so they're hidden for sensitive runs too.
- `TraceViewer` (`trace-viewer.tsx`) is **only** the zip-fed iframe embed; it's never reached without a
  `trace_url`.
- **`trace_signals` is surfaced NOWHERE in the dashboard** (grep of `src/` for `trace_signals|mutations|
  networkSummary` → only the server-side AI-insights consumes signals, and that panel is itself hidden).

**INFERRED:** Craig's "no traces" = the UI's only trace affordance is the raw-zip viewer, which is correctly
absent for sensitive. The safe redacted data is captured and API-reachable but has **no read-view**. On a
green sensitive run he sees the `FunnelBar` step timeline (from `run_steps`) and nothing else.

## 3. The security line — what a RAW trace would leak (why the current behavior exists)

A full Playwright trace of a login flow is a durable, replayable capture of the authenticated session. For
`b2c-login-test` a raw `trace.zip` / screenshot would leak, concretely:

- **Credentials** — the `B2C_TEST_USER` / `B2C_TEST_PASS` typed into the login form (trace records input
  values + DOM snapshots of the fields).
- **Session tokens / cookies** — post-auth `Set-Cookie`, bearer/JWT in response bodies, auth redirects with
  `?code=`/`?token=` — captured in the trace's network + storage state.
- **Authenticated DOM** — account name, address, order history, cart contents rendered on the landing page
  (DOM snapshots + the screenshot).
- **Replayability** — a trace zip is downloadable (the viewer streams it via `/trace-proxy`); anyone with
  dashboard access could scrub through the logged-in session frame by frame.

**The #219 invariants that MUST hold** (`docs/recon/2026-07-07-security-invariants.md`): #1 secret never
logged; **#2 capture gate — no trace zip / screenshot / baseline for sensitive** (`redact.ts:66-68`); #3
`trace_signals` never captures **request** headers (response-side method/url/status only — `traceSignals.ts`
never reads `req.headers`). Any proposal must keep all three. The line is about **durable persistence of
credential/session/DOM content** — not about displaying already-redacted, already-persisted structural data.

## 4. Ranked safe-visibility options

### ★ (a) Surface the already-captured redacted signals as a structural timeline — RECOMMENDED (do first)
- **Captures:** nothing new. It *displays* `run_steps` (step name/status/duration/scrubbed error) +
  `trace_signals.network` (the login **mutation** method/url/status, failed/slow requests, third-parties) +
  `trace_signals.console` (scrubbed) + `run_metrics` (web-vitals) as a "what happened when" timeline.
- **Cannot leak:** no DOM, no screenshot, no cookies, no input values, no request headers. Everything shown
  already passed the redactor + the #219 gate and is **already in the DB behind API auth** — surfacing it
  adds **zero** new persisted data and crosses **no** new line (it's a view over safe data).
- **Cost:** an API projection of `runs.trace_signals` onto the run-detail DTO (it isn't projected today —
  same shape as the `runs.sandbox → RunDto` chain), plus a dashboard panel that renders it when `trace_url`
  is null. No runner change.
- **Security posture: strongest** — safe by construction, satisfies #219 trivially.

### (d) A purpose-built "structural" trace artifact — RECOMMENDED end-state (evolve (a) into this)
- **Captures:** (a) + spec-emitted **structural booleans** — did the login form render, was the OTP gate
  reached, was an Akamai/bot block detected (the `b2c` classifier verdict COMPLETED / OTP_GATED /
  BOT_BLOCKED), the red-test anchor state (`checks.redtest_anchor`, `schema.sql:179`). No page content.
- **Cannot leak:** structural/boolean only — by construction no DOM/creds.
- **Cost:** (a) + the spec emits the booleans (a small `trace_signals` extension or a new `structural`
  JSONB) and the runner persists them (already-safe shape). More work than (a); it's the richer target.
- **Why after (a):** (a) ships value from data that already exists; (d) adds the classifier signal Craig
  most wants for a login monitor. (a) is the MVP subset of (d).

### (b) A redacted screenshot (masked inputs / DOM scrub) — NOT recommended
- **Captures:** a rendered screenshot with input fields masked / sensitive nodes scrubbed.
- **Leak risk: HIGH and not trustworthy.** A logged-in page renders account PII, cart contents, and
  session-reflected data; masking is **heuristic and best-effort** — one missed selector leaks, and you
  cannot *prove* completeness. It re-introduces exactly the durable page-content capture #2 exists to
  prevent. **Flag:** the redaction is not trustworthy enough for a login flow; do not adopt.

### (c) Trace captured but not persisted (ephemeral / short-TTL) — NOT recommended (infeasible / still leaks)
- **Reality check:** the runner **already** captures the zip locally and discards it after extraction
  (`index.ts:607` → not uploaded). So an ephemeral raw trace *transiently exists* — but:
  - The runner is a fire-and-**exit** ACA cron replica (`infra/main.bicep` `parallelism:1`, exits per tick);
    there is **no live session to attach to** and no persistent host to serve a TTL blob.
  - Serving it would mean **uploading the raw (creds/DOM) trace to durable blob** with a TTL — which
    **violates the #2 capture gate** even if short-lived, and the content leaked is identical, just for a
    shorter window. It changes *how long* it leaks, not *what*.
- **Verdict:** architecturally infeasible for live attach, and the TTL-blob variant crosses the #219 line.

---

## Recommendation & "what Craig wants to SEE on a green run"

For a **green** `b2c-login-test` run Craig's real question is *"did the login actually work, and how?"* — not
"show me the DOM." That is answered **safely and completely** by data already captured:

1. **Step timeline** (`run_steps`): open login page → fill credentials → submit → landed on account — with
   per-step pass/duration.
2. **The auth mutation** (`trace_signals.network.mutations`): the login `POST …/authorize` returned `200`
   (or the redirect chain) — the single most important "it worked" signal, already redacted.
3. **Web-vitals + console-clean** (`run_metrics` + `trace_signals.console`): the page rendered healthily,
   no site console errors.
4. **(via (d)) the classifier verdict**: `COMPLETED` vs `OTP_GATED` vs `BOT_BLOCKED` — the InfoSec-facing
   "did allowlist+header clear Akamai" answer.

**Adopt (a) now** (surface the existing redacted signals + step timeline; API projection + a dashboard panel
shown when `trace_url` is null), **evolve to (d)** (add the structural classifier booleans). Both keep the
#219 invariants intact by construction — no zip, no screenshot, no DOM, no creds ever persisted or shown.
**Reject (b)** (untrustworthy masking) and **(c)** (infeasible / TTL-blob still leaks). Do **not** enable raw
sensitive tracing.

---
### Appendix — evidence index
- Capture gate: `runner/redact.ts:65-72`; wired `runner/index.ts:581,586,612-615`.
- Still-captured signals: `runner/index.ts:602-608,659,672,1005-1007`; shape `runner/traceSignals.ts:14-60`.
- Schema: `db/schema.sql:88-93` (sensitive), `:259-267` (runs trace cols), `:313-325` (run_steps), `:179` (redtest_anchor).
- Dashboard: `run-history.tsx:28-83` (RunArtifacts, line 37 null-return), `:187` (failed-only), `trace-viewer.tsx` (zip-only embed).
- Invariants: `docs/recon/2026-07-07-security-invariants.md` (#1/#2/#3).
- Live DB (read-only): check 353 runs 916583/916314/915902/915736 — zip/shot null, signals+steps+metrics present.
