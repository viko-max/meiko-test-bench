import { describe, expect, it } from "vitest";
import { gradeObjective } from "../src/grading/objective.js";
import { gradeTrial } from "../src/grading/grade.js";
import { confirmGrade } from "../src/grading/model-grader.js";
import { GradeSchema, PublicQuestionSchema, ScoringSpecSchema, TrialSchema } from "../src/shared/contracts.js";

const q = PublicQuestionSchema.parse({ id: "choice", version: "1", subject: "science", answerKind: "single_choice",
  stem: "Select an option.", assets: [], options: { A: "Reduced mobility", B: "Increased mobility", C: "No change", D: "Rise", E: "2", F: "3", G: "4", H: "5", I: "Exothermic", J: "1" } });
const spec = (reference: string) => ScoringSpecSchema.parse({ questionId: q.id, questionVersion: q.version,
  scoringVersion: "1", answerKind: q.answerKind, maxScore: 1, reference, deterministicLocked: true });
const judge = (answer: string, reference = "A") => gradeObjective(q, spec(reference), answer);

describe("自由答卷选项识别的真实误判回归", () => {
  it.each([
    "Before solving, compare the terms. This corresponds to option **A**.",
    "For a particular solution, substitute a constant. This corresponds to option **A**.",
    "The calculation is straightforward. This corresponds to option **A**.",
    "Therefore, the correct option is:\n\n\\boxed{\\text{A}}",
    "Take the derivative d/dt. This corresponds to option **A**.",
  ])("英文词语和公式中的字母不作为多个选项：%s", (answer) => {
    expect(judge(answer).judgement).toBe("correct");
    expect(judge(answer, "B").judgement).toBe("incorrect");
  });

  it("框出的变量等式不作为选项 E", () => {
    expect(judge("We obtain \\boxed{E=1}. Correct option: **J. 1**", "J").judgement).toBe("correct");
    expect(judge("We obtain \\boxed{E=1}. Correct option: **J. 1**", "E").judgement).toBe("incorrect");
  });

  it.each([
    ["**A. Reduced mobility**\n\nThe chains are restricted.", "A"],
    ["A. **Reduced mobility**\n\nThe chains are restricted.", "A"],
    ["The measured value increases.\n\n**D. Rise**", "D"],
    ["I. **Exothermic**\n\nThe sample releases heat.", "I"],
  ])("根据公开选项识别首尾完整选项行：%s", (answer, reference) => {
    expect(judge(answer, reference).judgement).toBe("correct");
    expect(judge(answer, "B").judgement).toBe("incorrect");
  });

  it.each([
    "This matches option A. Option J is equivalent.",
    "Answer: A or B",
    "选 A、B",
    "\\boxed{A} and \\boxed{B}",
    "A. Reduced mobility\n\nB. Increased mobility",
    "A. Some unlisted explanation",
    "> A. Reduced mobility",
    "```text\nA. Reduced mobility\n```",
    "I. Exothermic\n\nI am not certain.",
  ])("真实冲突、引文或不足的证据仍需复核：%s", (answer) => {
    expect(judge(answer).reviewStatus).toBe("pending_human_review");
  });

  it("保存待复核的实际原因，兼容旧记录，人工确认后清除当前原因", () => {
    const t = TrialSchema.parse({ trialId: "choice__test", datasetId: "demo", datasetVersion: "1", questionId: q.id,
      questionVersion: q.version, provider: "test", modelId: "test", mode: "without_tool", configDigest: "test",
      promptVersion: "v2", toolsVersion: "v1", executionStatus: "completed", finalAnswerSheet: "Answer: A or B" });
    const pending = gradeTrial(t, q, spec("A")).grade!;
    expect(pending.reviewReason).toBeTruthy();
    expect(pending.reviewReason).toMatch(/multiple|conflict/);
    const { reviewReason: _reason, ...legacy } = pending;
    expect(GradeSchema.parse(legacy).reviewReason).toBeUndefined();
    const confirmed = confirmGrade(pending, { by: "reviewer", score: 0, note: "明确确认存在冲突" });
    expect(confirmed.reviewReason).toBeUndefined();
    expect(confirmed.reviewStatus).toBe("human_confirmed");
  });
});
