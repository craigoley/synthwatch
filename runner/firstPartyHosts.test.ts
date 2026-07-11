// Parity tests for the Wegmans first-party allowlist (Error-diff P1). Mirrors the API's
// SynthWatch.Api.Tests/FirstPartyHostsTests.cs — a regression on either side is caught by the shared
// trace-signals golden AND these unit cases. The ★ cases are the must-go-reds the classifier fix exists for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWegmansHost, isFirstParty } from './firstPartyHosts.js';

const TARGET = 'www.wegmans.com';

test('isWegmansHost: Wegmans-owned domains (apex + subdomains) are first-party', () => {
  for (const h of [
    'wegmans.com',
    'www.wegmans.com',
    'images.wegmans.com', // ★ sibling subdomain of the usual target — the old exact-host rule missed it
    'preview.commerce.wegmans.com',
    'wegmans.cloud', // ★ the headline bug: *.wegmans.cloud was marked third-party
    'api.wegmans.cloud',
    'anything.deeper.wegmans.cloud',
  ]) {
    assert.equal(isWegmansHost(h), true, `${h} should be first-party`);
  }
});

test('★ isWegmansHost: Azure APIM gateway + wegapi/kitting backends are first-party', () => {
  assert.equal(isWegmansHost('wegmans-prod.azure-api.net'), true); // APIM gateway (*.azure-api.net)
  assert.equal(isWegmansHost('foo.azure-api.net'), true);
  assert.equal(isWegmansHost('wegapi.prod.example'), true); // wegapi storefront backend (substring)
  assert.equal(isWegmansHost('kitting-catering-api.example.net'), true); // kitting/catering backend (substring)
});

test('isWegmansHost: genuine third parties + edge cases are NOT first-party', () => {
  for (const h of [
    'di.rlcdn.com', // CSP third-party
    'bot.emplifi.io',
    'realtime-c.astutebot.com',
    'connect.facebook.net',
    'notwegmans.com', // must not match on a bare "wegmans" substring — it's a suffix rule, not a contains
    'wegmans.com.evil.example', // apex must be a SUFFIX boundary, not anywhere in the host
    'azure-api.net', // the bare apex is never a real gateway host; only *.azure-api.net matches
    '', // empty host (blob:/data:) → third-party
  ]) {
    assert.equal(isWegmansHost(h), false, `${h} should NOT be first-party`);
  }
});

test('isWegmansHost is case-insensitive', () => {
  assert.equal(isWegmansHost('IMAGES.WEGMANS.COM'), true);
  assert.equal(isWegmansHost('API.Wegmans.Cloud'), true);
});

test('isFirstParty: allowlist OR the check target host / its subdomains', () => {
  // Allowlist hosts are first-party regardless of the target.
  assert.equal(isFirstParty('images.wegmans.com', TARGET), true);
  assert.equal(isFirstParty('api.wegmans.cloud', TARGET), true);
  // The check's own target + subdomains are first-party even when NOT in the static allowlist (legacy/
  // hand-made checks, or a future domain).
  assert.equal(isFirstParty('www.meals2go.com', 'www.meals2go.com'), true); // target host itself
  assert.equal(isFirstParty('cdn.meals2go.com', 'meals2go.com'), true); // subdomain of the target
  assert.equal(isFirstParty('meals2go.com', TARGET), false); // NOT the target here, NOT in the allowlist
  // Genuine third parties stay third-party.
  assert.equal(isFirstParty('di.rlcdn.com', TARGET), false);
  assert.equal(isFirstParty('', TARGET), false); // no host
  assert.equal(isFirstParty('www.wegmans.com', null), true); // allowlist works with no target
});
