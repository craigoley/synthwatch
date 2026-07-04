// Whole-flow wall-clock deadline — the browser-family mirror of multistep's MAX_CHAIN_MS.
//
// page.setDefaultTimeout bounds each ACTION; nothing bounded the FLOW, so a spec of k
// slow-but-under-timeout actions could run ~k × timeout_ms and blow past the ACA replicaTimeout
// (240s) — killed mid-tick with no honest verdict, the in-flight run stranded 'running' until the
// 30-min reaper, and every not-yet-reached due check silently deferred. Multistep fixed this exact
// class (multistep.ts MAX_CHAIN_MS); this helper gives executeBrowser the same ceiling.
//
// The deadline REJECTS with a plain Error (NOT ExpectationError), so the existing classification
// records an honest 'error' (infra/budget), never a monitor 'fail'.

/**
 * Await `work`, but reject with `message` after `ms` if it hasn't settled. The losing work promise
 * is marked handled (a late rejection after the deadline — e.g. Playwright actions aborted by the
 * subsequent context.close() — must not become an unhandledRejection and kill the tick).
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  // Mark late failures handled WITHOUT altering what await sees below (a .catch chain is a new
  // promise; the original still rejects the race normally when it loses in time).
  work.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer); // never hold the event loop open after the work settles
  }
}
