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

describe("P1-D rate limiter gates EACH model request (not the whole trial)", () => {
  it("spaces successive requests by minInterval (post-tool requests included)", async () => {
    const scheduler = new RequestScheduler({ maxConcurrent: 5, minIntervalMs: 50 });
    const starts: number[] = [];
    const inner: StreamFn = () => {
      starts.push(Date.now());
      return fakeStream() as never;
    };
    const wrapped = scheduledStreamFn(inner, scheduler, () => "ep1");
    for (let k = 0; k < 3; k++) {
      for await (const _e of wrapped(model, ctx) as AsyncIterable<unknown>) {
        /* consume */
      }
    }
    expect(starts).toHaveLength(3);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(45);
  });

  it("releases the slot when the stream ends (a later request is not blocked forever)", async () => {
    const scheduler = new RequestScheduler({ maxConcurrent: 1, minIntervalMs: 0 });
    const inner: StreamFn = () => fakeStream() as never;
    const wrapped = scheduledStreamFn(inner, scheduler, () => "ep1");
    for await (const _e of wrapped(model, ctx) as AsyncIterable<unknown>) {
      /* consume */
    }
    for await (const _e of wrapped(model, ctx) as AsyncIterable<unknown>) {
      /* consume — would hang if the slot leaked */
    }
    expect(true).toBe(true);
  });
});
