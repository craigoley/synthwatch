import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatCompletionBody, chatCompletionUrl, isFoundryV1ApiVersion } from './aoai.js';

test('Foundry v1 uses the chat-completions route without a deployment path', () => {
  assert.equal(isFoundryV1ApiVersion('v1'), true);
  assert.equal(
    chatCompletionUrl('https://example.openai.azure.com/', 'gpt-5.6-luna', 'v1'),
    'https://example.openai.azure.com/openai/v1/chat/completions?api-version=v1',
  );
});

test('dated Azure OpenAI versions retain the legacy deployment route', () => {
  assert.equal(isFoundryV1ApiVersion('2025-04-01-preview'), false);
  assert.equal(
    chatCompletionUrl('https://example.openai.azure.com', 'deployment/name', '2025-04-01-preview'),
    'https://example.openai.azure.com/openai/deployments/deployment%2Fname/chat/completions?api-version=2025-04-01-preview',
  );
});

test('Foundry v1 carries the deployment name as model and preserves structured output settings', () => {
  const body = buildChatCompletionBody(
    {
      system: 'system',
      user: 'user',
      maxTokens: 4000,
      reasoningEffort: 'low',
      responseFormat: { type: 'json_schema' },
    },
    'gpt-5.6-luna',
    'v1',
  );
  assert.equal(body.model, 'gpt-5.6-luna');
  assert.equal(body.max_completion_tokens, 4000);
  assert.equal(body.reasoning_effort, 'low');
  assert.deepEqual(body.response_format, { type: 'json_schema' });
});

test('shared v1 transport preserves multimodal RCA content blocks', () => {
  const body = buildChatCompletionBody(
    {
      system: 'system',
      user: [
        { type: 'text', text: 'facts' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,redacted' } },
      ],
      maxTokens: 4000,
      responseFormat: { type: 'json_schema' },
    },
    'gpt-5.6-luna',
    'v1',
  );
  const messages = body.messages as { role: string; content: unknown }[];
  assert.deepEqual(messages[1]?.content, [
    { type: 'text', text: 'facts' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,redacted' } },
  ]);
});
