import { describe, it, expect } from "vitest";
import { Type, fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { PublicQuestionSchema } from "../src/shared/contracts.js";
import { runTrial } from "../src/runner/run-trial.js";
import { setupFaux } from "./helpers/faux.js";

const question = PublicQuestionSchema.parse({ id: "phy-001", version: "1", subject: "physics", answerKind: "numeric_unit", stem: "Find F.", assets: [] });

const slowTool: AgentTool = {
  name: "slow",
  label: "Slow",
  description: "sleeps",
  parameters: Type.Object({}),
  execute: async () => {
    await new Promise((r) => setTimeout(r, 60));
    return { content: [{ type: "text", text: "done" }], details: {} };
  },
};

describe("P2-8 total-run-time deadline actively cancels", () => {
  it("a tiny totalRunTimeMs aborts an in-flight run (does not run every turn)", async () => {
    const setup = setupFaux([fauxAssistantMessage(fauxToolCall("slow", {})), fauxAssistantMessage("turn2"), fauxAssistantMessage("turn3")], { mode: "with_tool", tools: [slowTool], limits: { totalRunTimeMs: 5 } });
    const outcome = await runTrial({ agent: setup.agent, question, guard: setup.guard, recorder: setup.recorder });
    // The deadline stops the run (active abort + guard); it must NOT run every turn.
    expect(outcome.executionStatus).toBe("limit_reached");
    expect(outcome.terminationCause).toBe("total_time_limit");
    expect(setup.faux.state.callCount).toBeLessThan(3); // did NOT run all scripted turns
  });

  it("a generous totalRunTimeMs lets a normal run complete", async () => {
    const setup = setupFaux([fauxAssistantMessage("The answer is 6 N.")], { mode: "without_tool", limits: { totalRunTimeMs: 60000 } });
    const outcome = await runTrial({ agent: setup.agent, question, guard: setup.guard, recorder: setup.recorder });
    expect(outcome.executionStatus).toBe("completed");
  });
});
