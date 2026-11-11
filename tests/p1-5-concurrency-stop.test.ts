import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../src/runner/concurrency.js";

describe("P1-5 a worker error stops picking up NEW items", () => {
  it("starts no new items after a throw (in-flight finish, no further picks)", async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5], 2, async (x) => {
        started.push(x);
        if (x === 2) throw new Error("boom"); // thrower: immediate
        await new Promise((r) => setTimeout(r, 20)); // others: delayed (still in flight)
      }),
    ).rejects.toThrow("boom");
    await new Promise((r) => setTimeout(r, 50)); // let any (wrongly) started items settle
    // limit 2: items 1 & 2 start together; 2 throws -> STOP; 3/4/5 must NEVER start.
    expect(started.slice().sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("no error -> every item still runs (stop flag does not over-trigger)", async () => {
    const done: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (x) => {
      await new Promise((r) => setTimeout(r, 3));
      done.push(x);
    });
    expect(done.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});
