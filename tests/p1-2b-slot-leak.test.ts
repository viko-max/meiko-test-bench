import { describe, it, expect } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { scheduledStreamFn } from "../src/providers/stream-fn.js";
import { RequestScheduler } from "../src/runner/request-scheduler.js";

const model = { id: "m", provider: "p", baseUrl: "https://x/v1" } as unknown as Model<Api>;
const ctx = {} as never;
function fakeStream(): AsyncIterable<unknown> {
  return (async function* () {
    yield { type: "x" };
  })();
}
const drain = async (stream: unknown) => {
  for await (const _e of stream as AsyncIterable<unknown>) {
    /* consume */
  }
};

describe("P1-2b a synchronous init error must NOT leak the concurrency slot", () => {
  it("after inner() throws, the slot is released (a later request proceeds, no hang)", async () => {
    const scheduler = new RequestScheduler({ maxConcurrent: 1, minIntervalMs: 0 });
    let calls = 0;
    const badInner: StreamFn = () => {
      calls++;
      throw new Error("init boom");
    };
    const bad = scheduledStreamFn(badInner, scheduler, () => "ep1");
    await expect(drain(bad(model, ctx))).rejects.toThrow("init boom");

    // If the slot leaked (maxConcurrent=1), this second request would hang forever.
    const good = scheduledStreamFn(() => fakeStream() as never, scheduler, () => "ep1");
    await Promise.race([
      drain(good(model, ctx)),
      new Promise((_, rej) => setTimeout(() => rej(new Error("HUNG: slot leaked")), 1000)),
    ]);
    expect(calls).toBe(1);
  });

  it("a throwing result() also releases the slot", async () => {
    const scheduler = new RequestScheduler({ maxConcurrent: 1, minIntervalMs: 0 });
    const bad = scheduledStreamFn((() => {
      throw new Error("boom2");
    }) as unknown as StreamFn, scheduler, () => "ep1");
    await expect((bad(model, ctx) as unknown as { result: () => Promise<unknown> }).result()).rejects.toThrow("boom2");
    const good = scheduledStreamFn(() => fakeStream() as never, scheduler, () => "ep1");
    await Promise.race([drain(good(model, ctx)), new Promise((_, rej) => setTimeout(() => rej(new Error("HUNG")), 1000))]);
    expect(true).toBe(true);
  });
});
