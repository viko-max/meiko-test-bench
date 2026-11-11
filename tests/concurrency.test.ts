import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../src/runner/concurrency.js";

describe("R3-1 bounded concurrency scheduler", () => {
  it("serial (limit 1) never overlaps", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4], 1, async (x) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      order.push(x);
      inFlight--;
    });
    expect(maxInFlight).toBe(1);
    expect(order).toEqual([1, 2, 3, 4]); // serial preserves order
  });

  it("parallel (limit 3) bounds in-flight to the limit and processes every item exactly once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const done: number[] = [];
    const items = Array.from({ length: 9 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (x) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 4));
      done.push(x);
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3); // never exceeds the bound
    expect(maxInFlight).toBeGreaterThan(1); // actually ran in parallel
    expect(done.slice().sort((a, b) => a - b)).toEqual(items); // every item once
    expect(done).toHaveLength(items.length);
  });

  it("limit >= item count still processes all; limit < 1 is treated as 1", async () => {
    const done: number[] = [];
    await mapWithConcurrency([1, 2], 10, async (x) => {
      await Promise.resolve();
      done.push(x);
    });
    expect(done.slice().sort()).toEqual([1, 2]);

    const done2: number[] = [];
    await mapWithConcurrency([1, 2, 3], 0, async (x) => {
      await Promise.resolve();
      done2.push(x);
    });
    expect(done2.slice().sort()).toEqual([1, 2, 3]);
  });

  it("a throwing worker rejects but other items still complete", async () => {
    const done: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (x) => {
        await Promise.resolve();
        if (x === 2) throw new Error("boom");
        done.push(x);
      }),
    ).rejects.toThrow("boom");
    // items 1 and 3 (not the thrower) completed
    expect(done.slice().sort()).toEqual([1, 3]);
  });
});
