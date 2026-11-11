import { describe, it, expect } from "vitest";
import { buildModeReport } from "../src/reporting/report.js";
import { GradeSchema, PublicQuestionSchema, ScoringSpecSchema, TrialSchema } from "../src/shared/contracts.js";
import { scoringDigest } from "../src/grading/scoring.js";

const q1 = PublicQuestionSchema.parse({ id: "q1", version: "1", subject: "m", answerKind: "single_choice", stem: "x", options: { A: "1", B: "2" }, assets: [] });
const q2 = PublicQuestionSchema.parse({ id: "q2", version: "1", subject: "m", answerKind: "single_choice", stem: "y", options: { A: "1", B: "2" }, assets: [] });
const s1 = ScoringSpecSchema.parse({ questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 5, reference: "B", deterministicLocked: true });
const s2 = ScoringSpecSchema.parse({ questionId: "q2", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 5, reference: "B", deterministicLocked: true });
const t1 = TrialSchema.parse({ trialId: "q1__without_tool__x__0", datasetId: "d", datasetVersion: "1", questionId: "q1", questionVersion: "1", provider: "p", modelId: "m", mode: "without_tool", configDigest: "c", promptVersion: "v1", toolsVersion: "v1", executionStatus: "completed", finalAnswerSheet: "B" });
const g1 = GradeSchema.parse({ gradeId: "g1", trialId: "q1__without_tool__x__0", questionId: "q1", scoringVersion: "1", scoringDigest: scoringDigest(s1), graderKind: "rule", rawScore: 5, maxScore: 5, items: [], reviewStatus: "rule_graded", createdAt: "t" });

describe("P2-5b the report accounts for EVERY planned question", () => {
  it("a planned question with no trial (e.g. scheduling stopped) still appears as not-run", () => {
    const rep = buildModeReport({
      mode: "without_tool", trials: [t1], grades: [g1],
      questions: new Map([["q1", q1], ["q2", q2]]), scorings: new Map([["q1", s1], ["q2", s2]]),
      plannedMaxScore: 10, plannedQuestionIds: ["q1", "q2"],
    });
    const ids = rep.perQuestion.map((r) => r.questionId).sort();
    expect(ids).toEqual(["q1", "q2"]); // q2 present despite having no trial
    const q2row = rep.perQuestion.find((r) => r.questionId === "q2")!;
    expect(q2row.executionStatus).toBe("pending"); // explicit "not run"
    expect(q2row.gradingStatus).toBe("unscored");
    // q1 still graded correctly
    expect(rep.totals.confirmedRaw).toBe(5);
  });
});
