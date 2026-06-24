// Shared Azure OpenAI transport — the AAD credential (with the #90 user-assigned-MI pin),
// the chat-completions call, and JSON extraction. Used by the report-narrative job
// (narrative.ts). Opt-in on AZURE_OPENAI_* (absent => callers gate their feature off).
//
// NOTE: rca.ts predates this module and keeps its own inline transport — it was just
// stabilized in #90, so it is NOT refactored here (one concern per PR). credentialOptions()
// below MIRRORS rca.ts's #90 pin; a follow-up should migrate rca.ts onto this module to
// dedupe the credential + fetch. Keep the two in sync until then.
import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';

const ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const API_VERSION = process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21';
const SCOPE = 'https://cognitiveservices.azure.com/.default';

/** The default deployment (gpt-5-mini), shared with RCA. */
export const DEFAULT_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT;

/** AOAI usable? endpoint + a deployment present. Callers gate their feature on this. */
export function aoaiConfigured(deployment?: string): boolean {
  return Boolean(ENDPOINT && (deployment ?? DEFAULT_DEPLOYMENT));
}

/**
 * Managed-identity options for DefaultAzureCredential — MIRRORS rca.ts's #90 pin. The
 * runner has a USER-ASSIGNED-only MI; a bare DefaultAzureCredential can't resolve it ->
 * token failure. Pin the client id from AZURE_CLIENT_ID; unset (local) -> bare. Exported
 * so a test can assert the pinning decision without a live token.
 */
export function credentialOptions(): { managedIdentityClientId: string } | undefined {
  const clientId = process.env.AZURE_CLIENT_ID;
  return clientId ? { managedIdentityClientId: clientId } : undefined;
}

let credential: TokenCredential | null = null;
async function getAadToken(): Promise<string> {
  if (!credential) {
    const opts = credentialOptions();
    credential = opts ? new DefaultAzureCredential(opts) : new DefaultAzureCredential();
  }
  const token = await credential.getToken(SCOPE);
  if (!token?.token) throw new Error('no AAD token for cognitive-services scope');
  return token.token;
}

/** Outermost {...} slice — tolerant of markdown fences / leading-trailing prose. */
export function extractJson(content: string): string {
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return s;
}

export interface ChatRequest {
  deployment?: string; // default DEFAULT_DEPLOYMENT
  system: string;
  user: string; // compact JSON / text
  maxTokens: number;
  reasoningEffort?: string; // minimal|low|medium|high
  timeoutMs?: number;
  logPrefix?: string; // e.g. '[narrative]'
}

/**
 * Run a chat-completion (response_format json_object) and return the raw text content, or
 * null on ANY failure (logged). NEVER throws — a model/token failure must not break the
 * calling job (the caller falls back). Every exit path is logged for observability.
 */
export async function chatCompletionContent(req: ChatRequest): Promise<string | null> {
  const deployment = req.deployment ?? DEFAULT_DEPLOYMENT;
  const log = req.logPrefix ?? '[aoai]';
  if (!ENDPOINT || !deployment) {
    console.warn(`${log} not configured (AZURE_OPENAI_* absent) — skipped`);
    return null;
  }
  try {
    const token = await getAadToken();
    const url = `${ENDPOINT.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${API_VERSION}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 30000);
    const body: Record<string, unknown> = {
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      max_completion_tokens: req.maxTokens,
      response_format: { type: 'json_object' },
    };
    if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    console.log(`${log} model HTTP ${res.status}`);
    if (!res.ok) {
      console.warn(`${log} model returned ${res.status} ${res.statusText} (non-fatal)`);
      return null;
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    const finishReason = choice?.finish_reason ?? 'unknown';
    console.log(`${log} finish_reason=${finishReason} content_len=${content?.length ?? 0}`);
    if (!content) {
      console.warn(`${log} empty model content (finish_reason=${finishReason}) — fallback`);
      return null;
    }
    return content;
  } catch (err) {
    console.warn(`${log} failed (non-fatal):`, err instanceof Error ? err.message : err);
    return null;
  }
}
