/**
 * Bounded-concurrency scheduler (R3-1). Runs `worker` over `items` with at most
 * `limit` in flight. Default limit 1 is SERIAL (preserves order and the current
 * batch behavior exactly); limit > 1 is opt-in parallelism. Each item is handed
 * to exactly one worker; a throwing worker rejects the whole run (callers decide
 * how to record that) but never silently drops items. No shared mutable state is
 * introduced — callers keep per-item isolation (one trial = one item).
 */
export async function mapWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  const n = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1));
  if (items.length === 0) return;
  let next = 0;
  let stop = false; // P1-5: a task-level error stops picking up NEW items
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      if (stop) return; // never start new work after a failure (avoids further paid calls)
      const idx = next++;
      if (idx >= items.length) return;
      try {
        await worker(items[idx]!, idx);
      } catch (e) {
        stop = true; // signal siblings; already-started items finish (awaited via Promise.all)
        throw e;
      }
    }
  });
  // P2-E: wait for ALL already-started workers to settle (in-flight tasks finish
  // and get archived) BEFORE surfacing the error — never return while a task the
  // caller paid for is still running.
  const settled = await Promise.allSettled(runners);
  const firstReject = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (firstReject) throw firstReject.reason;
}
