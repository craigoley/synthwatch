# preview-result-golden

Anchors **`buildResultPayload`** (`runner/sandbox/sandboxResult.ts`) — the 13-field result payload the
sandbox job writes to `<token>.json`, which the api serves **verbatim** as `PreviewStatusDto.Trace`, an
**opaque string**, for the dashboard to `JSON.parse`.

## Why the anchor is here and not in the dashboard

`git grep hasScreenshot` in `synthwatch-api` returns nothing — the field is produced *here* and only
travels through the api inside that opaque string. The dashboard's captured-fixture contract harness
therefore **structurally cannot** anchor it; see that repo's `contract/README.md`, *"Known-uncapturable
seams"*. The anchor has to live at the producer.

## ★ What this golden gives you — and what it does not

`trace-signals-golden` takes a **captured artifact** as input: reality in, expected output recorded. This
golden's input is a **constructed object**, so it is *inputs-chosen plus outputs-recorded*.

- **It catches drift.** A field added, removed, renamed, re-ordered, or silently re-derived reds the test.
- **It does not prove the inputs resemble reality.** That is the honest limit. Do not cite it as evidence
  that the payload matches what a real preview emits.
- **It cannot catch** a change in what `runSandboxPreview` *produces* which `buildResultPayload` faithfully
  passes through — the builder is a projection, and a golden over a projection sees only the projection.

### How the fiction risk was reduced

Each arm's `result` was **captured from a real `runSandboxPreview` run** against live chromium (the same
`browserFlow.runTracedFlow` a real check uses) — not hand-written. Values that cannot be deterministic were
then normalised:

| normalised | why |
|---|---|
| `stdout` | the child echoes the payload including absolute `/var/folders/…` temp paths |
| `steps[].durationMs` → `0` | wall-clock, varies per run |
| `traceSignals.network.{slowest,largest}[].timeMs/waitMs` → `0` | same |

**Shape, field set and population are real and untouched — only values are scrubbed.** Each arm records its
own `provenance` string.

## The three arms — all required

The flags mean *captured **and** within cap **and** upload succeeded*, because in `sandboxMain` they are the
return values of `uploadSandboxArtifact`:

| arm | `hasScreenshot` | why |
|---|---|---|
| pass | `false` | no screenshot captured — a passing run never produces one |
| fail, under cap | `true` | captured (observed: 16577 B, well under the 4 MiB cap) and uploaded |
| fail, **over cap** | `false` | captured but **dropped** — `sandboxMain` skips the upload |

A two-arm golden would encode "failing ⇒ screenshot", a rule the code does **not** make. The over-cap arm
reuses the *same real failing `PreviewResult`* as the middle arm — only the `artifacts` argument differs,
which is exactly how that path presents. No hand-shaped result object anywhere.

## Regenerating

There is **no regeneration script**, matching `trace-signals-golden`. To refresh: run `runSandboxPreview`
on a passing and a failing spec, apply the normalisation above, and re-record `expected` by calling
`buildResultPayload`. Re-recording `expected` without re-reading the diff defeats the point — if a value
changed, understand why before committing it.
