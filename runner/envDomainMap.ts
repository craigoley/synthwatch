// Domain→environment inference for reconcile-apply (env PR-2).
//
// `checks.environment` (prod|staging|dev, GIT-AUTHORITATIVE) was set ONLY from a per-monitor manifest
// declaration — 1 of 36 monitors declares it, the rest default to 'prod'. There was NO inference, so a
// future preview/dev host silently tagged prod. This is the inference: an ORDERED (pattern → environment)
// map (env_domain_map, migration 0073) resolved against a check's target host.
//
// PRECEDENCE (resolveEnvironment): manifest.environment ?? inferFromDomain(target_url, map) ?? 'prod'.
// An explicit manifest env WINS; inference fills the gap; 'prod' (the DB default) is the final fallback.
import { pool } from './db.js';

export type Environment = 'prod' | 'staging' | 'dev';

/** One ordered inference rule. `pattern` = an exact host or a `*.suffix` wildcard. */
export interface EnvDomainRule {
  pattern: string;
  environment: Environment;
  priority: number;
}
/** The rules ORDERED (priority asc, id asc) — the FIRST match wins. loadEnvDomainMap returns them ordered. */
export type EnvDomainMap = readonly EnvDomainRule[];

/** Host of a target URL — http(s) or a bare host — lowercased, no port. '' when unparseable/absent. */
export function hostOfTarget(targetUrl: string | undefined | null): string {
  if (!targetUrl) return '';
  try {
    const u = new URL(targetUrl.includes('://') ? targetUrl : `https://${targetUrl}`);
    return u.hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Match `host` against one pattern. Two forms only (NOT regex — a user-editable config must not be a footgun):
 *   • `*.suffix` → host === suffix OR host endsWith '.' + suffix (the apex AND any subdomain).
 *   • exact      → host === pattern.
 * Both compared lowercased.
 */
export function matchesPattern(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return host === suffix || host.endsWith('.' + suffix);
  }
  return host === p;
}

/**
 * The environment inferred from `targetUrl`'s host, or null when no rule matches (or the host is
 * unparseable). `map` MUST be priority-ordered (loadEnvDomainMap guarantees it) — the FIRST match wins.
 */
export function inferFromDomain(targetUrl: string | undefined | null, map: EnvDomainMap): Environment | null {
  const host = hostOfTarget(targetUrl);
  if (host.length === 0) return null;
  for (const rule of map) {
    if (matchesPattern(host, rule.pattern)) return rule.environment;
  }
  return null;
}

/**
 * The EFFECTIVE environment for a monitor at reconcile-apply: explicit manifest env WINS, else infer from
 * the target host, else 'prod' (the DB default). The single precedence used by every apply/drift path.
 */
export function resolveEnvironment(
  manifestEnv: Environment | undefined,
  targetUrl: string | undefined | null,
  map: EnvDomainMap,
): Environment {
  return manifestEnv ?? inferFromDomain(targetUrl, map) ?? 'prod';
}

/** Load the ordered rules from env_domain_map (priority asc, id asc → first match wins). */
export async function loadEnvDomainMap(): Promise<EnvDomainMap> {
  const { rows } = await pool.query<EnvDomainRule>(
    `SELECT pattern, environment, priority FROM env_domain_map ORDER BY priority ASC, id ASC`,
  );
  return rows;
}
