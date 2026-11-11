import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../src/runner/concurrency.js";

describe("P2-E on failure, wait for already-started tasks before returning", () => {
  it("when it rejects, all already-started tasks have finished (none complete after return)", async () => {
    const finished: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4], 2, async (x) => {
        await new Promise((r) => setTimeout(r, x === 2 ? 1 : 25)); // item 2 fails fast, item 1 slow
        if (x === 2) throw new Error("boom");
        finished.push(x);
      }),
    ).rejects.toThrow("boom");
    const snapshot = [...finished];
    await new Promise((r) => setTimeout(r, 50)); // if a task leaked, it finishes now
    expect(finished).toEqual(snapshot); // nothing finished AFTER the function returned
    expect(finished).toContain(1); // the slow in-flight task DID finish before return
  });
});
