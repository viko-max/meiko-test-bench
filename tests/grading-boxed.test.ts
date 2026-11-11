import { describe, it, expect } from "vitest";
import { gradeNumericUnit, gradeObjective } from "../src/grading/objective.js";
import { PublicQuestionSchema, ScoringSpecSchema } from "../src/shared/contracts.js";

const numSpec = (reference: string, units: string[] = []) =>
  ScoringSpecSchema.parse({ questionId: "q", questionVersion: "1", scoringVersion: "1", answerKind: "numeric_unit", maxScore: 5, reference, tolerance: 0.01, units, deterministicLocked: true });

const choiceQ = PublicQuestionSchema.parse({ id: "q", version: "1", subject: "math", answerKind: "single_choice", stem: "pick one", options: { A: "1", B: "2", C: "3", D: "4" }, assets: [] });
const choiceSpec = (reference: string) =>
  ScoringSpecSchema.parse({ questionId: "q", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 1, reference, deterministicLocked: true });

describe("R1+ boxed final answer is extracted with priority", () => {
  it("numeric: \\boxed{N} wins over intermediate '=' values", () => {
    // Real LongCat answer shape: several intermediate '=' numbers, boxed final 2, ref 2.
    expect(gradeNumericUnit(numSpec("2"), "we get 1/2, then = 1, and = 2, finally \\boxed{2}").judgement).toBe("correct");
    expect(gradeNumericUnit(numSpec("6", ["N"]), "steps... \\boxed{6 N}").judgement).toBe("correct");
    expect(gradeNumericUnit(numSpec("6"), "steps... \\boxed{5}").judgement).toBe("incorrect"); // boxed final is wrong
  });

  it("choice: \\boxed{X} wins over other letters mentioned in prose", () => {
    expect(gradeObjective(choiceQ, choiceSpec("B"), "A is tempting, but B is direct, \\boxed{B}").judgement).toBe("correct");
    expect(gradeObjective(choiceQ, choiceSpec("B"), "\\boxed{A}").judgement).toBe("incorrect"); // declared final A != ref B
  });

  it("no boxed -> unchanged behavior (anchored / ambiguity still handled)", () => {
    expect(gradeNumericUnit(numSpec("6", ["N"]), "因此 F = 6 N").judgement).toBe("correct");
    expect(gradeNumericUnit(numSpec("6", ["N"]), "5 或 6 N").judgement).toBe("pending");
  });
});
