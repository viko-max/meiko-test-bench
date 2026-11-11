import { describe, it, expect } from "vitest";
import { buildModeReport } from "../src/reporting/report.js";
import { GradeSchema, PublicQuestionSchema, ScoringSpecSchema, TrialSchema } from "../src/shared/contracts.js";
import { scoringDigest } from "../src/grading/scoring.js";

const q = PublicQuestionSchema.parse({ id: "q", version: "1", subject: "m", answerKind: "single_choice", stem: "x", options: { A: "1", B: "2" }, assets: [] });
const trial = TrialSchema.parse({ trialId: "q__without_tool__x__0", datasetId: "d", datasetVersion: "1", questionId: "q", questionVersion: "1", provider: "p", modelId: "m", mode: "without_tool", configDigest: "c", promptVersion: "v1", toolsVersion: "v1", executionStatus: "completed", finalAnswerSheet: "B" });
const grade = (scoringVersion: string, reviewStatus: GradeReviewStatus = "rule_graded", raw = 5) =>
  GradeSchema.parse({ gradeId: `g-${scoringVersion}-${reviewStatus}`, trialId: "q__without_tool__x__0", questionId: "q", scoringVersion, scoringDigest: scoringDigest(ScoringSpecSchema.parse({ questionId: "q", questionVersion: "1", scoringVersion, answerKind: "single_choice", maxScore: 5, reference: "B", deterministicLocked: true })), graderKind: reviewStatus === "human_confirmed" ? "human" : "rule", rawScore: raw, maxScore: 5, items: [], reviewStatus, createdAt: "t" });
type GradeReviewStatus = "rule_graded" | "human_confirmed";

const report = (grades: Parameters<typeof buildModeReport>[0]["grades"], scoringVersion = "2") =>
  buildModeReport({
    mode: "without_tool",
    trials: [trial],
    grades,
    questions: new Map([["q", q]]),
    scorings: new Map([["q", ScoringSpecSchema.parse({ questionId: "q", questionVersion: "1", scoringVersion, answerKind: "single_choice", maxScore: 5, reference: "B", deterministicLocked: true })]]),
    plannedMaxScore: 5,
  });

describe("P1-B report only counts grades matching the CURRENT scoring basis", () => {
  it("a grade with a stale scoringVersion is NOT counted (even rule_graded / human_confirmed)", () => {
    const rRule = report([grade("1", "rule_graded")]); // current basis is v2
    expect(rRule.totals.confirmedRaw).toBe(0);
    const rHuman = report([grade("1", "human_confirmed")]);
    expect(rHuman.totals.confirmedRaw).toBe(0); // stale human grade must NOT slip into the total
  });

  it("a grade matching the current scoringVersion IS counted", () => {
    expect(report([grade("2", "rule_graded")]).totals.confirmedRaw).toBe(5);
    expect(report([grade("2", "human_confirmed")]).totals.confirmedRaw).toBe(5);
  });
});
