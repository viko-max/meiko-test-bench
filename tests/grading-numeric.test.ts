import { describe, it, expect } from "vitest";
import { ScoringSpecSchema } from "../src/shared/contracts.js";
import { gradeNumericUnit } from "../src/grading/objective.js";

// ref = "6 N", accepted unit N (case-sensitive), tolerance 0.01.
const s = ScoringSpecSchema.parse({
  questionId: "q",
  questionVersion: "1",
  scoringVersion: "1",
  answerKind: "numeric_unit",
  maxScore: 5,
  reference: "6 N",
  tolerance: 0.01,
  units: ["N"],
  deterministicLocked: true,
});

const notFull = (ans: string) => {
  const r = gradeNumericUnit(s, ans);
  expect(r.judgement, `"${ans}" must not be a full mark`).not.toBe("correct");
  expect(r.rawScore, `"${ans}" rawScore must be 0`).toBe(0);
};
const pending = (ans: string) => {
  const r = gradeNumericUnit(s, ans);
  expect(r.judgement, `"${ans}" should be pending`).toBe("pending");
  expect(r.reviewStatus, `"${ans}" reviewStatus`).toBe("pending_human_review");
};

describe("R1-1 numeric: candidate/comparison split + ambiguity", () => {
  it("final value wins over an annotated/conditional reference (no full mark)", () => {
    notFull("最终 7 N，附注 6 N"); // final is 7, ref is 6
    notFull("已知条件为 6 N，但最终算得 7 N"); // 6 is a given, 7 is the answer
  });

  it("disjunction ('或'/'or') between values -> pending", () => {
    pending("答案是 5 或 6 N");
    pending("结果为 6 或 7 N");
    pending("the answer is 5 or 6 N");
  });

  it("explicit uncertainty -> pending (never a full mark)", () => {
    pending("答案是无法确定，但计算中得到 6 N");
    pending("无法确定");
  });

  it("a clear single final answer still grades correctly", () => {
    expect(gradeNumericUnit(s, "因此 F = 6 N").judgement).toBe("correct");
    expect(gradeNumericUnit(s, "答案是 6 N").judgement).toBe("correct");
  });

  it("明确框出的单变量常数是提交值，中间推导的数字不作为冲突答案", () => {
    const scalar = ScoringSpecSchema.parse({ ...s, reference: "2", units: [] });
    expect(gradeNumericUnit(scalar, "Given 1-t/2=0, then t=2. \\boxed{t=2}").judgement).toBe("correct");
    expect(gradeNumericUnit(scalar, "Given 1-t/2=0. \\boxed{t=3}").judgement).toBe("incorrect");
    expect(gradeNumericUnit(s, "\\boxed{F=6 N}").judgement).toBe("correct");
  });

  it("多个框出数值、无法确定或非有限值仍需复核", () => {
    pending("\\boxed{F=5 N} and \\boxed{F=6 N}");
    pending("\\boxed{F=6 N}, but I am not certain");
    pending("\\boxed{F=1e999 N}");
    pending("\\boxed{F=2+4 N}");
    pending("\\boxed{\\frac{12}{2} N}");
  });
});
