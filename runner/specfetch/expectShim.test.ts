// The runner's mini-expect shim value matchers — the fix for the fleet-wide "expect(...).toBe is not a
// function" TypeError (specs assert .toBe/.toBeGreaterThan on VALUE targets; the old shim only had
// toBeVisible/toHaveURL for Locator|Page). Each matcher passes silently on success and throws
// ExpectationError (the spec's message surfaced) on failure — like Playwright's real expect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from './specShim.js';
import { ExpectationError, isExpectationError } from '../errors.js';

// helper: assert a matcher call throws an ExpectationError whose message contains `needle`.
function throwsExpect(fn: () => void, needle: RegExp): void {
  try {
    fn();
  } catch (err) {
    assert.ok(isExpectationError(err), `expected an ExpectationError, got ${String(err)}`);
    assert.match((err as ExpectationError).message, needle);
    return;
  }
  assert.fail('expected the matcher to throw, but it passed');
}

test('toBe: passes on === , throws ExpectationError on mismatch', () => {
  expect(200).toBe(200); // no throw
  throwsExpect(() => expect(404).toBe(200), /expected 404 to be 200/);
});

test('★ the 2-arg message form surfaces the spec author message in the failure', () => {
  expect(200, 'GATE-E: cart-items responded HTTP 200, expected 200.').toBe(200); // pass, no throw
  throwsExpect(
    () => expect(404, 'GATE-E: cart-items responded HTTP 404, expected 200.').toBe(200),
    /GATE-E: cart-items responded HTTP 404/,
  );
});

test('toBeNull + .not.toBeNull', () => {
  expect(null).toBeNull();
  expect({ a: 1 }).not.toBeNull();
  throwsExpect(() => expect({ a: 1 }).toBeNull(), /to be null/);
  throwsExpect(() => expect(null, 'must not be null').not.toBeNull(), /must not be null — expected null not to be null/);
});

test('toBeGreaterThan / toBeGreaterThanOrEqual', () => {
  expect(3).toBeGreaterThan(0);
  expect(1).toBeGreaterThanOrEqual(1);
  throwsExpect(() => expect(0).toBeGreaterThan(0), /to be greater than 0/);
  throwsExpect(() => expect(0, 'qty < 1').toBeGreaterThanOrEqual(1), /qty < 1 — expected 0 to be >= 1/);
  // a non-number fails honestly (NaN comparison), not a TypeError:
  throwsExpect(() => expect('x').toBeGreaterThan(0), /to be greater than 0/);
});

test('toBeLessThan / toBeLessThanOrEqual / toBeTruthy / toBeFalsy / toBeDefined', () => {
  expect(1).toBeLessThan(2);
  expect(2).toBeLessThanOrEqual(2);
  expect('non-empty').toBeTruthy();
  expect(0).toBeFalsy();
  expect(0).toBeDefined();
  throwsExpect(() => expect(5).toBeLessThan(2), /to be less than 2/);
  throwsExpect(() => expect(undefined).toBeDefined(), /to be defined/);
});

test('.not negates the value matchers', () => {
  expect(5).not.toBe(6);
  expect(1).not.toBeGreaterThan(5);
  throwsExpect(() => expect(5).not.toBe(5), /expected 5 not to be 5/);
});

// ★ REGRESSION — the exact meals2go #25 GATE-E cart-API assertions (spec lines 863-871), which threw
// ".toBe is not a function" / "reading 'toBeNull'" in the runner before. They must now pass through the
// SHIM expect (not the real Playwright one), and fail with the GATE-E message when the cart is wrong.
test('★ meals2go GATE-E assertions pass through the SHIM expect (the regression)', () => {
  // success: HTTP 200, a non-empty cart, total qty >= 1
  const status = 200;
  const body = { cartItems: [{ quantity: 1 }, { quantity: 1 }] };
  const cartItems = body && Array.isArray(body.cartItems) ? body.cartItems : [];
  const totalQty = cartItems.reduce((s, it) => s + (Number(it?.quantity) || 0), 0);
  assert.doesNotThrow(() => {
    expect(status, `GATE-E: cart-items responded HTTP ${status}, expected 200.`).toBe(200);
    expect(cartItems.length, 'GATE-E: cart-items returned 200 but cartItems is EMPTY.').toBeGreaterThan(0);
    expect(totalQty, 'GATE-E: cartItems present but total quantity < 1.').toBeGreaterThanOrEqual(1);
  }, 'the GATE-E assertions must reach [CART-API VERIFIED] under the shim');
});

test('★ meals2go GATE-E fails (with the message) when the add no-ops server-side', () => {
  const cartItems: Array<{ quantity: number }> = []; // 200 but empty cart
  throwsExpect(
    () => expect(cartItems.length, 'GATE-E: cart-items returned 200 but cartItems is EMPTY.').toBeGreaterThan(0),
    /GATE-E: cart-items returned 200 but cartItems is EMPTY/,
  );
});
