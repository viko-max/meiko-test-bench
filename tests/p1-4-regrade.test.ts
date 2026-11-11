import { describe, it, expect } from "vitest";
import { gradeTrial, gradeIsStale } from "../src/grading/grade.js";
import { scoringDigest } from "../src/grading/scoring.js";
import { GradeSchema, PublicQuestionSchema, ScoringSpecSchema, TrialSchema, type ScoringSpec } from "../src/shared/contracts.js";

const q = PublicQuestionSchema.parse({ id: "q", version: "1", subject: "m", answerKind: "single_choice", stem: "x", options: { A: "1", B: "2" }, assets: [] });
const spec = (scoringVersion: string, reference = "B"): ScoringSpec =>
  ScoringSpecSchema.parse({ questionId: "q", questionVersion: "1", scoringVersion, answerKind: "single_choice", maxScore: 1, reference, deterministicLocked: true });
const trial = TrialSchema.parse({
  trialId: "q__without_tool__x__0",
  datasetId: "d",
  datasetVersion: "1",
  questionId: "q",
  questionVersion: "1",
  provider: "p",
  modelId: "m",
  mode: "without_tool",
  configDigest: "c",
  promptVersion: "v1",
  toolsVersion: "v1",
  executionStatus: "completed",
  finalAnswerSheet: "the answer is B",
});
const grade = (scoringVersion: string) =>
  GradeSchema.parse({ gradeId: "x", trialId: "q__without_tool__x__0", questionId: "q", scoringVersion, scoringDigest: scoringDigest(spec(scoringVersion)), graderKind: "rule", rawScore: 1, maxScore: 1, items: [], reviewStatus: "rule_graded", createdAt: "t" });

describe("P1-4 scoring-basis change forces re-grade (never use a stale score)", () => {
  it("gradeId includes scoringVersion (re-grade under a new version is a distinct grade)", () => {
    const g1 = gradeTrial(trial, q, spec("1"), "t").grade!;
    const g2 = gradeTrial(trial, q, spec("2"), "t").grade!;
    expect(g1.gradeId).not.toBe(g2.gradeId);
  });

  it("gradeIsStale detects a changed scoring basis", () => {
    expect(gradeIsStale(grade("1"), spec("1"))).toBe(false);
    expect(gradeIsStale(grade("1"), spec("2"))).toBe(true); // scoringVersion changed
    expect(gradeIsStale(grade("1"), spec("1", "A"))).toBe(true);
  });

  it("re-grading an archived answer under the current spec gives the current-version score", () => {
    // archived answer "B"; old spec ref A (score 0), new spec ref B (score 1)
    const gOld = gradeTrial(trial, q, spec("1", "A"), "t").grade!;
    expect(gOld.rawScore).toBe(0);
    const gNew = gradeTrial(trial, q, spec("2", "B"), "t").grade!;
    expect(gNew.rawScore).toBe(1);
    expect(gNew.scoringVersion).toBe("2");
  });
});
