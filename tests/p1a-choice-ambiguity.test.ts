import { describe, it, expect } from "vitest";
import { gradeObjective } from "../src/grading/objective.js";
import { PublicQuestionSchema, ScoringSpecSchema } from "../src/shared/contracts.js";

const q = PublicQuestionSchema.parse({ id: "q", version: "1", subject: "m", answerKind: "single_choice", stem: "pick", options: { A: "1", B: "2", C: "3", D: "4" }, assets: [] });
const spec = (reference: string) => ScoringSpecSchema.parse({ questionId: "q", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 5, reference, deterministicLocked: true });

const pending = (ans: string) => {
  const r = gradeObjective(q, spec("B"), ans);
  expect(r.judgement, `"${ans}" must be pending (ref B)`).toBe("pending");
  expect(r.reviewStatus).toBe("pending_human_review");
};

describe("P1-A single-choice ambiguous answers must NOT get full marks", () => {
  it("a disjunction of options -> pending", () => {
    pending("答案是 B 或 C");
    pending("the answer is B or C");
    pending("B/C");
    pending("选 B、C");
  });

  it("explicit uncertainty -> pending", () => {
    pending("答案是 B，但我不能确定");
    pending("B，不确定");
    pending("可能是 B，无法确定");
  });

  it("a clear single submission still grades", () => {
    expect(gradeObjective(q, spec("B"), "答案是 B").judgement).toBe("correct");
    expect(gradeObjective(q, spec("B"), "因此选 B").judgement).toBe("correct");
    expect(gradeObjective(q, spec("B"), "答案是 A").judgement).toBe("incorrect");
  });
});
