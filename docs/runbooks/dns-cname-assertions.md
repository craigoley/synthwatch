# Runbook — DNS checks 346–349: CNAME assertions (what resolves, not just *that* something resolves)

> _Verified 2026-07-14 — prose with **no automated check**; if the code disagrees, the code is authoritative. This doc CAN rot._

**Context:** the 2026-07-12 Fleet Assertion Audit. The four apex/`www` DNS checks (346 wegmans, 347 meals2go, 348 amore, 349 nextdoor) were 100% green on 30d — but asserted only *"resolves ≥1 A record"* with **no `expectedValue`**. So a **repoint to a wrong-but-live IP** (hijack, botched CDN cutover, failover to a stale-but-answering origin) would resolve fine and stay **green**. *"DNS answers" ≠ "DNS answers correctly."*

**Owner:** Craig applies the `net_config` change (SQL below). Recon prepared + verified it; no code change (these are DB-only checks, and `net_config` is not a reconcile-authoritative column, so the change survives).

---

## What each check now asserts

The runner's `dns` check (`runner/netChecks.ts`) supports `recordType` (incl. **CNAME**) plus a **substring** `expectedValue` — the match is `values.some(v => v === want || v.includes(want))`, i.e. *any resolved record contains the string*. That containment is deliberate: it lets one `expectedValue` match a per-host CNAME prefix.

| id | host | `recordType` | `expectedValue` | fronting | why it's the *stable* layer |
|---|---|---|---|---|---|
| 346 | www.wegmans.com | CNAME | `wegmans.com.edgekey.net` | Akamai | edge A-IPs rotate (`23.202.x`); the CNAME `www.wegmans.com.edgekey.net` does not |
| 347 | www.meals2go.com | CNAME | `meals2go.com.edgekey.net` | Akamai | same — origin-specific Akamai edge hostname is fixed |
| 349 | www.wegmansnextdoor.com | CNAME | `ckatfl0sflhq.wpeproxy.com` | WP Engine | the install proxy hostname is fixed for the environment |
| 348 | wegmansamore.com | **A only** | *(none — deliberate)* | Webflow | **apex — no CNAME exists to assert** (see below) |

**Why CNAME, not A:** these hosts are CDN-fronted, so the A records are **rotating edge IPs**. Pinning an A record would produce **constant false reds** on normal edge rotation — which is worse than the gap, because a monitor that cries wolf gets ignored, and then it's useless when it's right. The CNAME target is the strong-*and*-stable layer: a wrong repoint changes it; an edge rotation does not. The `expectedValue` is the **origin-specific** substring (`wegmans.com.edgekey.net`, not the bare shared zone `edgekey.net`) so it catches even a same-CDN, different-property repoint (an attacker's own Akamai/WP Engine account → `attacker.com.edgekey.net` fails the substring).

## What would *legitimately* break 346/347/349 — and the tell

Only a **deliberate CDN migration** (Wegmans moves www.wegmans.com/meals2go off Akamai, or nextdoor off WP Engine) changes the CNAME target. That is a planned, announced event — and it is **distinguishable from a real repoint**:

> ★ **The false-red tell:** when a DNS check reddens, look at the **browser check for the same host**.
> - **DNS red + browser GREEN** → the site still serves the *right content* from a *new edge* → a **CDN migration** (false red). Update the `expectedValue` to the new CNAME target.
> - **DNS red + browser RED** → wrong content **and** wrong DNS target → a **real repoint** (hijack / bad cutover). Escalate.

Host → browser check: www.wegmans.com → **2** (wegmans-homepage); meals2go → **80/221**; amore → **192** (amore-menu); nextdoor → **194** (nextdoor-homepage).

## 348 (wegmansamore.com) — deliberate liveness-only gap

`wegmansamore.com` is an **apex** — an apex cannot have a CNAME (RFC), so `dig CNAME wegmansamore.com` returns nothing and the runner has **no stable non-A anchor to assert**. The only "strong" option is pinning the A-prefix `141.193.213.` (Webflow's current ingress /24) — but Webflow **has migrated its ingress IPs before** (that's *why* it's `141.193.213.x`), so an A-pin trades narrow value for a **real false-red risk on a vendor IP migration**.

**Decision: leave 348 as a deliberate liveness-only check** (`{"recordType":"A"}`, no `expectedValue` — asserts DNS answers at all). Rationale:
- Check **192 (amore-menu, browser)** already covers wegmansamore.com **functionally** — a wrong repoint serving wrong content makes **192 go red**. So 348's marginal value is narrow: catch a DNS-layer break *before* 192 does, and catch a repoint that still serves *plausible* content.
- An A-prefix pin buys that narrow value at the cost of a noisy false signal on a Webflow IP change. **A named, deliberate gap beats a noisy false signal** — same posture as leaving blob storage out of `/api/health`.

If Webflow (or Wegmans) ever fronts amore with a stable `www` CNAME, revisit 348 with the CNAME gate.

---

## Apply (Craig runs; verified against live `dig` on 2026-07-12)

Each `expectedValue` matches the live CNAME **today**, so applying reddens nothing:

```sql
UPDATE checks SET net_config = '{"recordType":"CNAME","expectedValue":"wegmans.com.edgekey.net"}'::jsonb  WHERE id = 346;
UPDATE checks SET net_config = '{"recordType":"CNAME","expectedValue":"meals2go.com.edgekey.net"}'::jsonb  WHERE id = 347;
UPDATE checks SET net_config = '{"recordType":"CNAME","expectedValue":"ckatfl0sflhq.wpeproxy.com"}'::jsonb WHERE id = 349;
-- 348 wegmansamore.com: intentionally unchanged (apex → liveness-only; see above).
```

After applying, confirm the next scheduled run of 346/347/349 still **passes** (the CNAME resolves + contains the substring). A red on the very next run means a typo in `expectedValue` vs the live CNAME — re-check with `dig +short <host> CNAME`.
