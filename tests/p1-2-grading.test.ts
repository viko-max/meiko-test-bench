import { describe, it, expect } from "vitest";
import { gradeNumericUnit, gradeObjective } from "../src/grading/objective.js";
import { PublicQuestionSchema, ScoringSpecSchema } from "../src/shared/contracts.js";

const spec = (reference: string, units: string[] = []) =>
  ScoringSpecSchema.parse({ questionId: "q", questionVersion: "1", scoringVersion: "1", answerKind: "numeric_unit", maxScore: 5, reference, tolerance: 0.01, units, deterministicLocked: true });

const notFull = (ans: string, s: ReturnType<typeof spec>) => {
  const r = gradeNumericUnit(s, ans);
  expect(r.judgement, `"${ans}" must NOT be full`).not.toBe("correct");
  expect(r.rawScore).toBe(0);
};

const choiceQ = PublicQuestionSchema.parse({ id: "q", version: "1", subject: "math", answerKind: "single_choice", stem: "pick", options: { A: "1", B: "2", C: "3", J: "10" }, assets: [] });
const choiceSpec = (reference: string) => ScoringSpecSchema.parse({ questionId: "q", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 1, reference, deterministicLocked: true });

describe("P1-2 free-form answers must NOT be over-awarded", () => {
  it("disjunction WITH units -> pending (not full)", () => {
    const s = spec("6 N", ["N"]);
    expect(gradeNumericUnit(s, "最终答案是6 N 或7 N").judgement).toBe("pending");
    expect(gradeNumericUnit(s, "the answer is 6 N or 7 N").judgement).toBe("pending");
  });

  it("boxed conflicting with a later explicit final -> review (not full), even when boxed==ref", () => {
    notFull("曾考虑 \\boxed{6 N}，但最终答案是7 N", spec("6 N", ["N"])); // boxed 6 == ref 6, but final is 7 -> NOT full
    expect(gradeNumericUnit(spec("7 N", ["N"]), "曾考虑 \\boxed{6 N}，但最终答案是7 N").judgement).toBe("pending");
  });

  it("boxed as the sole/consistent final still grades correctly", () => {
    expect(gradeNumericUnit(spec("2"), "we compute =1, =2, finally \\boxed{2}").judgement).toBe("correct");
    expect(gradeNumericUnit(spec("6", ["N"]), "steps... \\boxed{6 N}").judgement).toBe("correct");
    expect(gradeNumericUnit(spec("6"), "steps... \\boxed{5}").judgement).toBe("incorrect");
  });

  it("candidate dedup is unit case-sensitive (MPa != mPa)", () => {
    expect(gradeNumericUnit(spec("6 MPa", ["MPa"]), "答案是 6 MPa；最终是 6 mPa").judgement).toBe("pending");
  });

  it("clear single weak-anchored answer still grades", () => {
    expect(gradeNumericUnit(spec("6", ["N"]), "因此 F = 6 N").judgement).toBe("correct");
    expect(gradeNumericUnit(spec("6", ["N"]), "答案是 6 N").judgement).toBe("correct");
  });

  it("choice: boxed letter conflicting with a prose option mention -> review (not full)", () => {
    // \boxed{A} is the declared final; "matches option J" is unmarked prose -> grade A
    expect(gradeObjective(choiceQ, choiceSpec("A"), "This matches option J; \\boxed{A}").judgement).toBe("correct");
    // a SECOND final declaration ("the answer is J") DOES conflict with the boxed A -> review
    expect(gradeObjective(choiceQ, choiceSpec("A"), "The answer is J; \\boxed{A}").judgement).toBe("pending");
    // boxed as the sole final still grades
    expect(gradeObjective(choiceQ, choiceSpec("B"), "reasoning... \\boxed{B}").judgement).toBe("correct");
  });
});
