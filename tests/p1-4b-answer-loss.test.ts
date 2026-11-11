import { describe, it, expect } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { PublicQuestionSchema } from "../src/shared/contracts.js";
import { runTrial } from "../src/runner/run-trial.js";
import { InMemoryTrialRecorder } from "../src/storage/recorder.js";
import { setupFaux } from "./helpers/faux.js";

const question = PublicQuestionSchema.parse({ id: "phy-001", version: "1", subject: "physics", answerKind: "numeric_unit", stem: "Find F.", assets: [] });

describe("P1-4b an answer-sheet write failure must NOT lose the obtained answer", () => {
  it("setAnswerSheet throwing -> still completed with the answer + answerSheetError", async () => {
    const setup = setupFaux([fauxAssistantMessage("The net force is 6 N.")], { mode: "without_tool" });
    const recorder = new InMemoryTrialRecorder();
    recorder.setAnswerSheet = () => {
      throw new Error("answer.json write failed");
    };
    const outcome = await runTrial({ agent: setup.agent, question, guard: setup.guard, recorder });
    expect(outcome.executionStatus).toBe("completed");
    expect(outcome.finalAnswerSheet).toBe("The net force is 6 N."); // NOT null / outcome_unknown
    expect(outcome.answerSheetError).toMatch(/answer\.json write failed/);
  });

  it("a clean run has no answerSheetError", async () => {
    const setup = setupFaux([fauxAssistantMessage("The net force is 6 N.")], { mode: "without_tool" });
    const outcome = await runTrial({ agent: setup.agent, question, guard: setup.guard, recorder: setup.recorder });
    expect(outcome.executionStatus).toBe("completed");
    expect(outcome.answerSheetError).toBeUndefined();
  });
});
