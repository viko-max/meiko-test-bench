import { describe, it, expect } from "vitest";
import {
  PublicQuestionSchema,
  ScoringSpecSchema,
  TrialSchema,
  type PublicQuestion,
  type ScoringSpec,
  type Trial,
} from "../src/shared/contracts.js";
import { gradeSingleChoice, gradeNumericUnit, gradeObjective } from "../src/grading/objective.js";
import { gradeTrial } from "../src/grading/grade.js";
import { buildModeReport, reportToMarkdown } from "../src/reporting/report.js";

const choiceQ = PublicQuestionSchema.parse({
  id: "q-c",
  version: "1",
  subject: "mathematics",
  answerKind: "single_choice",
  stem: "What is 2+2?",
  options: { A: "3", B: "4", C: "5" },
  assets: [],
});
const choiceS = ScoringSpecSchema.parse({
  questionId: "q-c",
  questionVersion: "1",
  scoringVersion: "1",
  answerKind: "single_choice",
  maxScore: 5,
  reference: "B",
  deterministicLocked: true,
});

const numQ = PublicQuestionSchema.parse({ id: "q-n", version: "1", subject: "physics", answerKind: "numeric_unit", stem: "Find F.", assets: [] });
const numS = ScoringSpecSchema.parse({
  questionId: "q-n",
  questionVersion: "1",
  scoringVersion: "1",
  answerKind: "numeric_unit",
  maxScore: 10,
  reference: "6",
  tolerance: 0.01,
  units: ["N"],
  deterministicLocked: true,
});

const openQ = PublicQuestionSchema.parse({ id: "q-o", version: "1", subject: "chemistry", answerKind: "open", stem: "Explain.", assets: [] });
const openS = ScoringSpecSchema.parse({
  questionId: "q-o",
  questionVersion: "1",
  scoringVersion: "1",
  answerKind: "open",
  maxScore: 12,
  reference: "any valid explanation",
  rubric: [{ points: 12, evidence: "valid reasoning" }],
});

function trial(over: Partial<Trial>): Trial {
  return TrialSchema.parse({
    trialId: "t1",
    datasetId: "d",
    datasetVersion: "1",
    questionId: "q-c",
    questionVersion: "1",
    provider: "p",
    modelId: "m",
    mode: "without_tool",
    configDigest: "abc",
    promptVersion: "v1",
    toolsVersion: "v1",
    executionStatus: "completed",
    ...over,
  });
}

describe("objective grading", () => {
  it("single choice: correct / wrong / ambiguous / conflicting", () => {
    expect(gradeSingleChoice(choiceQ, choiceS, "The answer is B.").judgement).toBe("correct");
    expect(gradeSingleChoice(choiceQ, choiceS, "The answer is A.").judgement).toBe("incorrect");
    expect(gradeSingleChoice(choiceQ, choiceS, "B appears somewhere in the text without a selection.").judgement).toBe("pending");
    const conflict = gradeSingleChoice(choiceQ, choiceS, "Answer: A. On reflection, answer: B.");
    expect(conflict.judgement).toBe("pending");
    expect(conflict.reviewStatus).toBe("pending_human_review");
  });

  it("numeric with tolerance: correct / wrong / undeterminable", () => {
    expect(gradeNumericUnit(numS, "F = 6.0 N").judgement).toBe("correct");
    expect(gradeNumericUnit(numS, "F = 7 N").judgement).toBe("incorrect");
    expect(gradeNumericUnit(numS, "cannot determine").judgement).toBe("pending");
  });

  it("P1-1 regression: numeric never awards full marks to a wrong final answer", () => {
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
    const a = gradeNumericUnit(s, "已知数值是6，最终结果是7 N");
    expect(a.judgement).not.toBe("correct");
    expect(a.rawScore).toBe(0);
    const b = gradeNumericUnit(s, "6 kg");
    expect(b.judgement).toBe("incorrect");
    expect(b.rawScore).toBe(0);
    const c = gradeNumericUnit(s, ".6 N");
    expect(c.judgement).not.toBe("correct");
    expect(c.rawScore).toBe(0);
    expect(gradeNumericUnit(s, "因此 F = 6 N").judgement).toBe("correct");
    expect(gradeNumericUnit(s, "therefore F = 6").reviewStatus).toBe("pending_human_review");
  });

  it("open/expression are NOT deterministically graded in v1", () => {
    const r = gradeObjective(openQ, openS, "Because bonds form.");
    expect(r.judgement).toBe("pending");
    expect(r.reviewStatus).toBe("pending_human_review");
  });
});

describe("grade dispatch + re-grade", () => {
  it("grades a completed scored trial and skips unscored/non-completed", () => {
    const g = gradeTrial(trial({ finalAnswerSheet: "answer is B" }), choiceQ, choiceS, "2026-10-08T00:00:00Z");
    expect(g.grade?.rawScore).toBe(5);
    expect(g.grade?.reviewStatus).toBe("rule_graded");

    expect(gradeTrial(trial({ finalAnswerSheet: "x" }), choiceQ, undefined).skipped).toMatch(/unscored/);
    expect(gradeTrial(trial({ executionStatus: "interrupted", finalAnswerSheet: null }), choiceQ, choiceS).skipped).toMatch(/not gradable/);
    expect(gradeTrial(trial({ truncated: true, finalAnswerSheet: "answer is B" }), choiceQ, choiceS).skipped).toMatch(/truncated/);
  });

  it("re-grade is deterministic from the archived answer and versions on scoring change", () => {
    const a = gradeTrial(trial({ finalAnswerSheet: "answer is B" }), choiceQ, choiceS, "T")!.grade!;
    const b = gradeTrial(trial({ finalAnswerSheet: "answer is B" }), choiceQ, choiceS, "T")!.grade!;
    expect(b.rawScore).toBe(a.rawScore); // offline, no re-answer
    const changed = gradeTrial(trial({ finalAnswerSheet: "answer is B" }), choiceQ, { ...choiceS, scoringVersion: "2", maxScore: 8 })!.grade!;
    expect(changed.scoringVersion).toBe("2");
    expect(changed.gradeId).not.toBe(a.gradeId);
  });
});

describe("reporting: raw sum, no silent zero, coverage", () => {
  it("sums only confirmed grades; pending/unscored shown but not counted", () => {
    const questions = new Map<string, PublicQuestion>([
      ["q-c", choiceQ],
      ["q-n", numQ],
      ["q-o", openQ],
    ]);
    const scorings = new Map<string, ScoringSpec>([["q-c", choiceS], ["q-n", numS], ["q-o", openS]]);

    const tCorrect = trial({ trialId: "tc", questionId: "q-c", finalAnswerSheet: "answer is B", executionStatus: "completed" });
    const tWrong = trial({ trialId: "tw", questionId: "q-n", finalAnswerSheet: "F=7", executionStatus: "completed" });
    const tOpen = trial({ trialId: "to", questionId: "q-o", finalAnswerSheet: "because", executionStatus: "completed" });
    const tInterrupted = trial({ trialId: "ti", questionId: "q-c", finalAnswerSheet: null, executionStatus: "interrupted" });

    const grades = [
      gradeTrial(tCorrect, choiceQ, choiceS, "T")!.grade!,
      gradeTrial(tWrong, numQ, numS, "T")!.grade!,
      gradeTrial(tOpen, openQ, openS, "T")!.grade!, // pending_human_review, rawScore 0 but NOT confirmed
    ].filter(Boolean);

    const report = buildModeReport({
      mode: "without_tool",
      trials: [tCorrect, tWrong, tOpen, tInterrupted],
      grades,
      questions,
      scorings,
      plannedMaxScore: 27,
    });

    // confirmed = q-c correct (5) + q-n wrong (0) = 5 / 15; open pending excluded; interrupted excluded.
    expect(report.totals.confirmedRaw).toBe(5);
    expect(report.totals.confirmedMax).toBe(15);
    expect(report.totals.plannedMax).toBe(27);
    expect(report.bySubject["mathematics"]).toEqual({ raw: 5, max: 5, counted: 1 });
    expect(report.bySubject["physics"]).toEqual({ raw: 0, max: 10, counted: 1 });
    // coverage reflects reality
    expect(report.coverage["grade:pending_human_review"]).toBe(1);
    expect(report.coverage["exec:interrupted"]).toBe(1);

    const md = reportToMarkdown(report);
    expect(md).toContain("5 / 15");
    expect(md).toContain("mode: without_tool");
  });
});
