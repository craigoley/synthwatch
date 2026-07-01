// Main-document response-header capture for the browser deploy-marker path (deploy-markers browser wiring).
//
// INPUT PARITY is the whole point. The http path hands extractDeployMarker BOTH the response headers AND the
// body; the browser path must feed the SAME curated ladder the same two inputs — the rendered DOM
// (page.content()) AND the main navigation document's response headers — so wegmans' sentry-release SHA (a
// body marker) and an etag-only host (a header marker) both land, driven by what each host exposes, with no
// per-target logic. This module supplies the header half.
//
// ★★ FALSE-POSITIVE GUARD (the main-document filter). A deploy marker is an identity of the DOCUMENT the user
// loaded — NOT of an arbitrary subresource. A changing etag on a tracking pixel / xhr / font / iframe is
// exactly the phantom-marker class the ladder refuses. So we retain headers ONLY for the response that is
// BOTH a navigation request AND on the page's MAIN frame (not an iframe document, not a subresource). This is
// NOT signal-widening: it narrows capture to the one response whose headers are a deploy-stable document
// identity, then lets the existing curated ladder decide.

import type { Page } from 'playwright';

/** The minimal response shape the main-doc filter needs — structural so it's unit-testable without a browser. */
export interface NavResponseLike {
  request(): { isNavigationRequest(): boolean };
  frame(): unknown;
  headers(): Record<string, string>;
}

/**
 * True iff `r` is the MAIN navigation document — a navigation request (not a subresource) on the page's main
 * frame (not an iframe document). The single response whose headers are a legitimate deploy fingerprint.
 */
export function isMainDocumentResponse(r: NavResponseLike, mainFrame: unknown): boolean {
  return r.request().isNavigationRequest() && r.frame() === mainFrame;
}

/**
 * Install a best-effort response listener (BEFORE the flow navigates) that retains the MAIN document's response
 * headers, and return a getter for the pass-branch marker call. Last-write-wins across redirects → the FINAL
 * document's headers. If no main-doc response is ever seen (SPA / navigation-less flow) the getter returns
 * undefined and the body rung of the ladder still runs off page.content(). Never throws.
 */
export function captureMainDocHeaders(page: Page): () => Record<string, string> | undefined {
  let headers: Record<string, string> | undefined;
  const mainFrame = page.mainFrame();
  page.on('response', (response) => {
    if (isMainDocumentResponse(response, mainFrame)) headers = response.headers();
  });
  return () => headers;
}
