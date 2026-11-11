import { describe, it, expect } from "vitest";
import { summarizeUsage } from "../src/reporting/transcript.js";

// events shaped like the recorder's message_end events (event.message.usage).
const msgEnd = (input: number, output: number, reasoning = 0) => ({ type: "message_end", message: { usage: { input, output, reasoning, totalTokens: input + output } } });

describe("P2-8 per-attempt usage accumulates across all replies", () => {
  it("sums input/output/reasoning/total across every message_end (not just the last)", () => {
    const events = [msgEnd(10, 20, 5), { type: "message_start" }, msgEnd(30, 40, 10), msgEnd(5, 5, 0)];
    const u = summarizeUsage(events);
    expect(u.input).toBe(45);
    expect(u.output).toBe(65);
    expect(u.reasoning).toBe(15);
    expect(u.totalTokens).toBe(110);
    expect(u.replies).toBe(3);
  });

  it("missing usage remains unknown instead of zero", () => {
    const u = summarizeUsage([{ type: "agent_start" }, { type: "turn_end" }]);
    expect(u.totalTokens).toBeNull();
    expect(u.replies).toBe(0);
  });
});
