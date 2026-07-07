// S2 primitive — runtime request-ORIGIN rewrite for Option-C specs (the pre-prod-regression arc).
//
// WHY runtime (not compile/fetch-time): a fetched spec hardcodes its prod host in page.goto(...), and
// the compiled JS is CACHED in Postgres keyed by spec_path alone + is deliberately machine/target-
// AGNOSTIC (compileSpec.ts:8-16) — one portable artifact shared across every machine AND every check.
// Baking a host into it would fork that shared cache. So re-pointing a spec at staging/dev MUST happen
// at RUN time, on the page's requests, downstream of the cache. This is that rewrite.
//
// The runner already intercepts every request via context.route('**/*') (index.ts, for header
// injection); this module supplies the pure decision it calls. route.continue({ url }) changes the
// request URL but "New URL must have same protocol as original one" (Playwright docs, class-Route), so
// we swap ONLY host+port (the origin) and preserve protocol + path + query + hash. context.route('**/*')
// covers the top-level navigation AND every subresource (Playwright network docs), so a spec that
// asserts on a rewritten origin's XHR/img is repointed too — not half-rewritten.
//
// ★ INERT BY DEFAULT: with no rewrite compiled (the caller passes nothing), resolveRewrite() always
// returns null → the route handler adds no `url` override → request URLs are byte-identical to today.
// The primitive activates ONLY when a caller (S3) supplies a from/to origin pair.

/** A caller-supplied origin pair to rewrite: requests whose origin === fromOrigin become toOrigin. */
export interface HostRewrite {
  /** The spec's DECLARED prod origin — what to rewrite FROM. Passed explicitly (see PR rationale): we
   *  do NOT sniff the spec's goto literal (fragile: multiple/dynamic gotos in a bundle), and a pre-prod
   *  check's own target_url is already the staging origin, so the prod origin isn't derivable from it. */
  fromOrigin: string;
  /** The environment origin to rewrite TO (e.g. the staging app). */
  toOrigin: string;
}

/** A validated pair. `from`/`to` are normalized origins; same protocol guaranteed by compileHostRewrite. */
export interface CompiledRewrite {
  from: URL;
  to: URL;
}

/**
 * Parse + validate an origin string to a normalized URL. FAIL-LOUD: throws on anything that is not a
 * bare http(s) origin. A silently-ignored bad target would run the spec against its HARDCODED PROD host
 * while the caller believed it was hitting staging — a false-green against prod. That must never happen,
 * so a malformed origin refuses the run instead.
 */
export function parseOrigin(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`hostRewrite: malformed origin ${JSON.stringify(raw)} — expected "scheme://host[:port]"`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`hostRewrite: origin ${JSON.stringify(raw)} must be http(s), got protocol "${u.protocol}"`);
  }
  if (!u.hostname) {
    throw new Error(`hostRewrite: origin ${JSON.stringify(raw)} has no host`);
  }
  // Reject a full URL passed as an origin (a common caller mistake — a page URL, not an origin). An
  // origin has no path/query/hash; browsers normalize the empty path to "/", which we allow.
  if ((u.pathname !== '' && u.pathname !== '/') || u.search !== '' || u.hash !== '') {
    throw new Error(
      `hostRewrite: expected an origin (scheme://host[:port]) but ${JSON.stringify(raw)} carries a path/query/hash`,
    );
  }
  return u;
}

/**
 * Validate a from/to pair. Throws (fail-loud) if either origin is malformed OR the two differ in
 * protocol — route.continue() cannot change the protocol, and a protocol-crossing rewrite is almost
 * certainly a caller error, not something to silently drop.
 */
export function compileHostRewrite(hr: HostRewrite): CompiledRewrite {
  const from = parseOrigin(hr.fromOrigin);
  const to = parseOrigin(hr.toOrigin);
  if (from.protocol !== to.protocol) {
    throw new Error(
      `hostRewrite: protocol mismatch — cannot rewrite ${from.origin} (${from.protocol}) to ${to.origin} ` +
        `(${to.protocol}); Playwright route.continue requires the same protocol`,
    );
  }
  return { from, to };
}

/**
 * PURE. Given a request URL, return the rewritten URL when its origin EXACTLY matches `from` — swapping
 * host+port to `to`, preserving protocol/path/query/hash — else null.
 *
 * The exact-origin match IS the third-party guard: a request to a DIFFERENT origin (algolia / opentable /
 * an azure-api CDN) does not equal `from`, so it returns null and is left untouched. Only the one declared
 * primary origin is ever rewritten — a staging re-point can never redirect Algolia to staging.
 */
export function rewriteRequestUrl(requestUrl: string, from: URL, to: URL): string | null {
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    return null; // an unparseable request URL is not ours to touch
  }
  if (u.origin !== from.origin) return null; // ← third-party / non-primary origin: NEVER rewritten
  u.host = to.host; // swap host+port; protocol (equal by compileHostRewrite) + path/query/hash preserved
  return u.toString();
}

/**
 * The route handler's decision. INERT when `rw` is null (no rewrite compiled) → always null, so the
 * handler adds no `url` override and behaves byte-identically to before this primitive existed.
 */
export function resolveRewrite(requestUrl: string, rw: CompiledRewrite | null): string | null {
  return rw ? rewriteRequestUrl(requestUrl, rw.from, rw.to) : null;
}

/**
 * S3 wiring glue (pure): build the rewrite pair for a check from its stored FROM origin
 * (checks.rewrite_from_origin) + its target_url (the pre-prod env). FROM null/empty → undefined (no
 * rewrite; S2 inert). TO = the origin of targetUrl; a malformed targetUrl is passed through RAW so the
 * downstream compileHostRewrite fail-louds (a bad rewrite must refuse the run, not silently hit prod).
 */
export function hostRewriteFor(fromOrigin: string | null | undefined, targetUrl: string): HostRewrite | undefined {
  if (!fromOrigin) return undefined;
  let toOrigin = targetUrl;
  try {
    toOrigin = new URL(targetUrl).origin;
  } catch {
    /* leave raw → compileHostRewrite throws (fail-loud) rather than a silent no-rewrite against prod */
  }
  return { fromOrigin, toOrigin };
}
