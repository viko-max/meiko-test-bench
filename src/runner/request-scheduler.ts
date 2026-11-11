/**
 * Shared-key request scheduler (P2-9). Question-level concurrency
 * (mapWithConcurrency) bounds how many QUESTIONS run at once, but several
 * concurrent questions share ONE api key/endpoint. This scheduler adds a
 * PER-ENDPOINT gate: a max number of in-flight requests and a minimum interval
 * between request starts (RPM), grouped by endpoint so distinct endpoints are
 * independent. TPM/quota can be layered on the same group state later.
 *
 * Note: Pi's streamFn is synchronous, so the gate is applied around an async
 * unit of work (e.g. a trial's request phase); it is the shared-key limiter
 * that sits alongside — not instead of — question concurrency.
 */
const ABORT = (): DOMException => new DOMException("Aborted", "AbortError");
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(ABORT());
    const onAbort = () => {
      clearTimeout(t);
      reject(ABORT());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface SchedulerLimits {
  /** Max in-flight requests per endpoint group. */
  maxConcurrent: number;
  /** Minimum gap (ms) between request STARTS per group (RPM-ish). 0 = no spacing. */
  minIntervalMs: number;
}

interface GroupState {
  inFlight: number;
  lastStart: number;
}

export class RequestScheduler {
  private readonly groups = new Map<string, GroupState>();

  constructor(private readonly limits: SchedulerLimits) {}

  /** Run `fn` under the group's concurrency + rate limits; the slot is held for
   *  fn's duration and released even if fn throws. */
  async schedule<T>(group: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(group);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Acquire a slot under the group's concurrency + rate limits; returns a
   *  release fn (idempotent). For gating a unit whose lifetime is NOT a single
   *  promise — e.g. a model request held until its stream ends (P1-D). */
  async acquire(group: string, signal?: AbortSignal): Promise<() => void> {
    const g = this.groups.get(group) ?? { inFlight: 0, lastStart: 0 };
    this.groups.set(group, g);
    const mc = Math.max(1, Math.floor(this.limits.maxConcurrent || 1));
    const mi = Math.max(0, this.limits.minIntervalMs || 0);
    for (;;) {
      if (signal?.aborted) throw ABORT(); // cancelled while queued: take no slot
      const sinceLast = Date.now() - g.lastStart;
      if (g.inFlight < mc && sinceLast >= mi) break;
      await sleep(Math.min(10, Math.max(1, mi - sinceLast)), signal);
    }
    g.inFlight++;
    g.lastStart = Date.now();
    // Re-check AFTER acquiring: a cancelled request must NOT enter the send phase.
    if (signal?.aborted) {
      g.inFlight--;
      throw ABORT();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      g.inFlight--;
    };
  }
}
