import { describe, it, expect } from "vitest";
import { Type, fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { PublicQuestionSchema, findScoringLeaks } from "../src/shared/contracts.js";
import { runTrial } from "../src/runner/run-trial.js";
import { buildUserContent } from "../src/runner/prompt.js";
import { setupFaux } from "./helpers/faux.js";

const question = PublicQuestionSchema.parse({
  id: "phy-001",
  version: "1",
  subject: "physics",
  answerKind: "numeric_unit",
  stem: "A 2 kg block accelerates at $3\\,\\mathrm{m/s^2}$. Find the net force.",
  assets: [],
});

const echoPython: AgentTool = {
  name: "execute_python",
  label: "Execute Python",
  description: "Run Python code and return stdout.",
  parameters: Type.Object({ code: Type.String() }),
  execute: async (_id, args) => {
    const code = (args as { code: string }).code;
    return { content: [{ type: "text", text: `executed:${code}` }], details: {} };
  },
};

function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b as { type?: string }).type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
  }
  return "";
}

describe("offline end-to-end (faux provider, no network)", () => {
  it("without_tool: single answer, completed, exactly one provider call, maxRetries forced to 0", async () => {
    const setup = setupFaux([fauxAssistantMessage("The net force is 6 N.")], { mode: "without_tool" });
    const outcome = await runTrial({ agent: setup.agent, question, guard: setup.guard, recorder: setup.recorder });

    expect(outcome.executionStatus).toBe("completed");
    expect(outcome.finalAnswerSheet).toBe("The net force is 6 N.");
    expect(setup.faux.state.callCount).toBe(1); // single answer, no auto-retry
    expect(setup.capturedOptions()?.maxRetries).toBe(0); // retry structurally disabled
    expect(outcome.truncated).toBe(false);
  });

  it("with_tool: model calls a tool, gets the result, then submits (two provider calls)", async () => {
    const setup = setupFaux(
      [
        fauxAssistantMessage(fauxToolCall("execute_python", { code: "print(2*3)" })),
        fauxAssistantMessage("Using the tool, F = 6 N."),
      ],
      { mode: "with_tool", tools: [echoPython] },
    );
    const outcome = await runTrial({ agent: setup.agent, question, guard: setup.guard, recorder: setup.recorder });

    expect(outcome.executionStatus).toBe("completed");
    expect(outcome.finalAnswerSheet).toBe("Using the tool, F = 6 N.");
    expect(setup.faux.state.callCount).toBe(2); // one call that requested the tool, one final answer
    const toolEnd = setup.recorder.events.find((e) => (e as { type?: string }).type === "tool_execution_end") as
      | { result?: { content?: Array<{ text?: string }> } }
      | undefined;
    expect(toolEnd).toBeTruthy();
    expect(toolEnd?.result?.content?.[0]?.text).toContain("executed:print(2*3)");
  });

  it("answer isolation: only public content reaches the transcript, no scoring keys", async () => {
    const setup = setupFaux([fauxAssistantMessage("6 N")], { mode: "without_tool" });
    await runTrial({ agent: setup.agent, question, guard: setup.guard, recorder: setup.recorder });

    const messages = setup.agent.state.messages as Array<{ role?: string }>;
    const firstUser = messages.find((m) => m.role === "user");
    expect(textOf(firstUser)).toBe(buildUserContent(question)); // faithful, no extra hints
    expect(textOf(firstUser)).toContain("2 kg");
    const req = setup.recorder.requests[0] as { messageCount: number };
    expect(req.messageCount).toBeGreaterThanOrEqual(1);
    expect(findScoringLeaks(messages)).toEqual([]);
  });

  it("protection limit: maxTurns=1 stops a tool-using run after the first turn (limit_reached)", async () => {
    const setup = setupFaux(
      [
        fauxAssistantMessage(fauxToolCall("execute_python", { code: "x=1" })),
        fauxAssistantMessage("would-be-final"),
        fauxAssistantMessage("extra-should-not-run"),
      ],
      { mode: "with_tool", tools: [echoPython], limits: { maxTurns: 1 } },
    );
    const outcome = await runTrial({ agent: setup.agent, question, guard: setup.guard, recorder: setup.recorder });
    expect(outcome.executionStatus).toBe("limit_reached");
    expect(setup.faux.state.callCount).toBe(1); // the follow-up was not sent
  });
});
