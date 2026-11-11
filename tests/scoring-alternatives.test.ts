import { describe, expect, it } from "vitest";
import { gradeObjective } from "../src/grading/objective.js";
import { assertScoring } from "../src/grading/scoring.js";
import { PublicQuestionSchema, ScoringSpecSchema } from "../src/shared/contracts.js";

const q = PublicQuestionSchema.parse({ id: "aliases", version: "1", subject: "math", answerKind: "single_choice", stem: "Choose one.",
  options: { A: "one half", B: "two quarters", C: "three quarters" }, assets: [] });
const scoring = ScoringSpecSchema.parse({ questionId: q.id, questionVersion: "1", scoringVersion: "2", answerKind: "single_choice",
  maxScore: 1, reference: "B", acceptableAlternatives: ["A"], deterministicLocked: true });

describe("单选题可接受答案", () => {
  it.each(["A", "B"])("唯一明确选择 %s 按当前评分依据计分", (label) => {
    const result = gradeObjective(q, scoring, `Answer: ${label}`);
    expect(result.judgement).toBe("correct");
    expect(result.rawScore).toBe(1);
    expect(result.items[0]?.note).toContain(label);
  });
  it("其他选项仍判错，旧依据没有自动新增别名", () => {
    expect(gradeObjective(q, scoring, "Answer: C").judgement).toBe("incorrect");
    expect(gradeObjective(q, { ...scoring, acceptableAlternatives: [] }, "Answer: A").judgement).toBe("incorrect");
  });
  it.each(["Answer: A or B", "This matches option A; option B is equivalent.", "Answer: A, but I am not certain"])("可接受答案不能消除提交歧义：%s", (answer) => {
    expect(gradeObjective(q, scoring, answer).reviewStatus).toBe("pending_human_review");
  });
  it("无法按选项标签处理的其他答案不被忽略后直接判错", () => {
    expect(gradeObjective(q, { ...scoring, acceptableAlternatives: ["three quarters"] }, "Answer: C").reviewStatus).toBe("pending_human_review");
  });
  it("不存在的选项标签不能成为评分依据", () => {
    expect(() => assertScoring({ ...scoring, acceptableAlternatives: ["Z"] }, q)).toThrow("不存在");
  });
});
