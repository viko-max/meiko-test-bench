import { describe, it, expect } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { scheduledStreamFn } from "../src/providers/stream-fn.js";
import { RequestScheduler } from "../src/runner/request-scheduler.js";

const model = { id: "m", provider: "p", baseUrl: "https://x/v1" } as unknown as Model<Api>;
const ctx = {} as never;
function streamOf(delayMs: number): AsyncIterable<unknown> {
  return (async function* () {
    await new Promise((r) => setTimeout(r, delayMs));
    yield { type: "x" };
  })();
}
const drain = async (stream: unknown) => {
  for await (const _e of stream as AsyncIterable<unknown>) {
    /* consume */
  }
};

describe("P1-3b a queued request honours cancellation", () => {
  it("a request cancelled while queued does NOT wait for the slot and does NOT send", async () => {
    const scheduler = new RequestScheduler({ maxConcurrent: 1, minIntervalMs: 0 });
    const slow = scheduledStreamFn(() => streamOf(200) as never, scheduler, () => "ep1");
    const p1 = drain(slow(model, ctx)); // occupies the only slot ~200ms
    await new Promise((r) => setTimeout(r, 10));

    const started: number[] = [];
    const inner2: StreamFn = () => {
      started.push(Date.now());
      return streamOf(1) as never;
    };
    const wrapped2 = scheduledStreamFn(inner2, scheduler, () => "ep1");
    const ac = new AbortController();
    const p2 = drain(wrapped2(model, ctx, { signal: ac.signal } as never));
    setTimeout(() => ac.abort(), 10); // cancel ~10ms later, well before the 200ms slot frees

    const t0 = Date.now();
    await expect(p2).rejects.toThrow(); // cancelled -> rejects promptly
    expect(Date.now() - t0).toBeLessThan(150); // did NOT wait for the 200ms slot
    expect(started).toHaveLength(0); // inner never called -> no send after cancel
    await p1;
  });
});
