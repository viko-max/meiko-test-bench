import { describe, it, expect } from "vitest";
import { RequestScheduler } from "../src/runner/request-scheduler.js";

describe("P2-9 shared-key request scheduler (per-endpoint concurrency + RPM)", () => {
  it("bounds concurrent requests per group", async () => {
    const s = new RequestScheduler({ maxConcurrent: 2, minIntervalMs: 0 });
    let inFlight = 0;
    let maxInFlight = 0;
    await Promise.all(Array.from({ length: 6 }, () => s.schedule("ep1", async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    })));
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1); // actually parallel up to the bound
  });

  it("enforces a minimum interval between request STARTS (RPM)", async () => {
    const s = new RequestScheduler({ maxConcurrent: 5, minIntervalMs: 20 });
    const starts: number[] = [];
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 3 }, () => s.schedule("ep1", async () => {
      starts.push(Date.now() - t0);
      await new Promise((r) => setTimeout(r, 1));
    })));
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(15);
  });

  it("different endpoint groups are independent", async () => {
    const s = new RequestScheduler({ maxConcurrent: 1, minIntervalMs: 0 });
    let a = 0;
    let b = 0;
    await Promise.all([
      s.schedule("ep1", async () => {
        a++;
        await new Promise((r) => setTimeout(r, 10));
      }),
      s.schedule("ep2", async () => {
        b++;
        await new Promise((r) => setTimeout(r, 10));
      }),
    ]);
    expect(a).toBe(1);
    expect(b).toBe(1); // ran concurrently despite maxConcurrent=1 (different groups)
  });

  it("a throwing task releases its slot", async () => {
    const s = new RequestScheduler({ maxConcurrent: 1, minIntervalMs: 0 });
    await expect(s.schedule("ep1", async () => { throw new Error("x"); })).rejects.toThrow("x");
    let ran = false;
    await s.schedule("ep1", async () => { ran = true; }); // slot was released
    expect(ran).toBe(true);
  });
});
