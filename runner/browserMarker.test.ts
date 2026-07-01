import test from 'node:test';
import assert from 'node:assert/strict';

import { isMainDocumentResponse, type NavResponseLike } from './browserMarker.js';

const mainFrame = { id: 'main' };
const iframe = { id: 'iframe' };

/** A structural stand-in for a Playwright Response — no browser needed to test the main-doc filter. */
const resp = (isNav: boolean, frame: unknown, etag = '"x"'): NavResponseLike => ({
  request: () => ({ isNavigationRequest: () => isNav }),
  frame: () => frame,
  headers: () => ({ etag }),
});

test('the MAIN navigation document (nav request on the main frame) IS the deploy-marker source', () => {
  assert.equal(isMainDocumentResponse(resp(true, mainFrame), mainFrame), true);
});

// ★★ FALSE-POSITIVE GUARD: a subresource etag is NOT a deploy marker. A tracking pixel / xhr / font whose
// etag changes per-request is exactly the phantom-marker class we refuse — it must never be captured.
test('★ a subresource response (not a navigation request) is NOT captured', () => {
  assert.equal(isMainDocumentResponse(resp(false, mainFrame), mainFrame), false);
});

// ★ an iframe DOCUMENT is a navigation request but on a CHILD frame — its headers are not THIS page's deploy id.
test('★ an iframe document (navigation request, but not the main frame) is NOT captured', () => {
  assert.equal(isMainDocumentResponse(resp(true, iframe), mainFrame), false);
});
