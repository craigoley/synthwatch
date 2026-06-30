// Egress-IP capture (static-egress-IP Phase 0, ANALYSIS-static-egress-ip-2026-06-30.md). Records the
// PUBLIC egress IP each run left from, so the real monitors — running their normal cron across all 3
// regions — become the measurement: over a day, query distinct egress IPs per region (runs.egress_ip +
// runs.location) to decide if egress is a stable allowlistable IP per region or a rotating SNAT pool.
//
// ★ FAIL-SOFT, telemetry-only: a monitor's job is to monitor. This reflector call must NEVER break or
//   materially slow a run — it's wrapped in a timeout, swallows ALL errors → null, and is captured ONCE
//   per process (the runner is a one-shot job: one invocation = one replica = one SNAT IP, so one capture
//   covers every run in the tick; a later tick re-captures, catching rotation).
// ★ NOT sensitive: the egress IP is our OWN infra's public IP — the value we WANT to read. It is stamped
//   directly on the run, NEVER routed through the sensitive-monitor redactor.
// Reflectors mirror #159's phase0-egress-probe.sh (plain IP-reflectors, no creds, no sensitive data).

const REFLECTORS = ['https://checkip.amazonaws.com', 'https://api.ipify.org'] as const;
const REFLECT_TIMEOUT_MS = 3000;

// Strict IPv4 (octet-bounded) or a permissive IPv6 — guards against a reflector returning HTML / an error
// page instead of a bare IP.
const IP_RE =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$|^[0-9a-fA-F:]{3,45}$/;

/**
 * Reflect the container's public egress IP off plain IP-reflectors (first that returns a valid IP wins).
 * Each attempt is timeout-bounded; ANY failure (timeout / network / DNS / non-200 / garbage body) falls
 * through to the next reflector, then to null. Never throws. fetchImpl is injectable for tests.
 */
export async function reflectEgressIp(
  timeoutMs = REFLECT_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  for (const url of REFLECTORS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) continue;
      const ip = (await res.text()).trim();
      if (IP_RE.test(ip)) return ip;
    } catch {
      // timeout / network / DNS — swallow and try the next reflector.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// Once-per-process cache. The runner job is short-lived (processes due checks, exits), so caching the
// first attempt (success OR failure) for the process lifetime is exactly "once per process" — non-hammering,
// and the next cron invocation is a fresh process that re-captures.
let cached: string | null | undefined; // undefined = not yet attempted
let inflight: Promise<string | null> | null = null;

/**
 * The public egress IP for THIS runner process, or null if it couldn't be determined (fail-soft). Captured
 * once and reused for every run in the invocation. Safe to call eagerly to WARM the value (it overlaps with
 * monitor work, so the per-run stamp reads the cache with no added latency).
 */
export function captureEgressIp(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (cached !== undefined) return Promise.resolve(cached);
  if (!inflight) {
    inflight = reflectEgressIp(REFLECT_TIMEOUT_MS, fetchImpl)
      .then((ip) => {
        cached = ip;
        return ip;
      })
      .catch(() => {
        cached = null;
        return null;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Test-only: clear the per-process cache so each test starts fresh. */
export function __resetEgressCacheForTest(): void {
  cached = undefined;
  inflight = null;
}
