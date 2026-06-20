// Dynamic flow loader for browser checks.
//
// A check row names its flow in checks.flow_name; we map that to a module under
// this directory (e.g. 'homepage-search' -> ./homepage-search.js). The name is
// validated against a strict allowlist pattern BEFORE it touches import() so a
// malicious or malformed value can never be used for path traversal.
import type { StepRecorder } from '../stepRecorder.js';

/**
 * A browser flow. Receives ONLY the StepRecorder — the Playwright Page is
 * reachable solely through rec.step(), which guarantees instrumentation.
 */
export type Flow = (rec: StepRecorder) => Promise<void>;

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
