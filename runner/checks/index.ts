// Flow authoring + dynamic loader for browser checks.
//
// AUTHORING (see docs/AUTHORING.md): a flow module exports `flow` (built with
// defineFlow) and an optional `meta`. defineFlow gives you idiomatic Playwright
// ergonomics — `page` in scope, `step('name', async () => {...})` like
// test.step — so codegen output pastes in with near-zero ceremony:
//
//     import { defineFlow } from './index.js';
//     export const meta = { description: 'Homepage loads', entryUrlHint: 'https://example.com/' };
//     export const flow = defineFlow(async ({ page, step, baseUrl, expect }) => {
//       await step('open homepage', async () => {
//         await page.goto(baseUrl, { waitUntil: 'load' });
//       });
//     });
//
// LOADING: a check names its flow in checks.flow_name; we map that to a module
// here (e.g. 'homepage-load' -> ./homepage-load.js). The name is validated
// against a strict allowlist BEFORE import() so a malformed value can't traverse.
import { StepRecorder, type FlowContext } from '../stepRecorder.js';

export type { FlowContext };

/** A loaded flow: the runner hands it a StepRecorder; defineFlow adapts it. */
export type Flow = (rec: StepRecorder) => Promise<void>;

/** Optional per-flow metadata for the manifest (the dashboard's flow picker). */
export interface FlowMeta {
  /** One-line human description. */
  description?: string;
  /** A suggested target_url for checks using this flow (a hint, not enforced). */
  entryUrlHint?: string;
}

/**
 * Author a flow. The body is written against a FlowContext (page in scope, step,
 * baseUrl, expect); defineFlow returns the Flow the runner invokes.
 */
export function defineFlow(
  body: (ctx: FlowContext) => Promise<void>,
): Flow {
  return (rec) => body(rec.context());
}

const FLOW_NAME = /^[a-z0-9-]+$/;

export async function loadFlow(flowName: string): Promise<Flow> {
  if (!FLOW_NAME.test(flowName)) {
    throw new Error(`Invalid flow name "${flowName}" (must match /^[a-z0-9-]+$/)`);
  }

  // Resolved at runtime against compiled output; the `.js` extension is required
  // under NodeNext ESM.
  const mod: unknown = await import(`./${flowName}.js`);

  const flow = (mod as { flow?: unknown }).flow;
  if (typeof flow !== 'function') {
    throw new Error(`Flow module "${flowName}" must export a "flow" function`);
  }
  return flow as Flow;
}
