// sandboxUpload's GRACEFUL-SKIP contract: a missing token/account/container must NOT throw (the run still
// writes its result to stdout and exits on the spec's own status). The upload itself needs Azure and is
// exercised live by the smoke test; here we only pin that egress never crashes the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { uploadSandboxResult } from './sandboxUpload.js';

const clearEnv = (): void => {
  delete process.env.SANDBOX_STORAGE_ACCOUNT;
  delete process.env.SANDBOX_CONTAINER;
  delete process.env.AZURE_CLIENT_ID;
};

test('returns false (no throw) when the result token is missing', async () => {
  clearEnv();
  process.env.SANDBOX_STORAGE_ACCOUNT = 'acct';
  process.env.SANDBOX_CONTAINER = 'synthwatch-sandbox';
  assert.equal(await uploadSandboxResult(undefined, '{"ok":true}'), false);
});

test('returns false (no throw) when the storage account env is missing', async () => {
  clearEnv();
  process.env.SANDBOX_CONTAINER = 'synthwatch-sandbox';
  assert.equal(await uploadSandboxResult('deadbeef', '{"ok":true}'), false);
});

test('returns false (no throw) when the container env is missing', async () => {
  clearEnv();
  process.env.SANDBOX_STORAGE_ACCOUNT = 'acct';
  assert.equal(await uploadSandboxResult('deadbeef', '{"ok":true}'), false);
});
