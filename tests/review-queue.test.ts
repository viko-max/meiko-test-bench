import { describe, it, expect } from "vitest";
import { reviewQueue } from "../src/tui/review.js";
import { GradeSchema, TrialSchema, type Grade, type Trial } from "../src/shared/contracts.js";

function trial(id: string, over: Partial<Trial> = {}): Trial {
  return TrialSchema.parse({
    trialId: `${id}__without_tool__x__0`,
    datasetId: "demo",
    datasetVersion: "1",
    questionId: id,
    questionVersion: "1",
    provider: "faux",
    modelId: "faux-1",
    mode: "without_tool",
    configDigest: "d",
    promptVersion: "v1",
    toolsVersion: "v1",
    executionStatus: "completed",
    finalAnswerSheet: "some answer",
    ...over,
  });
}

function grade(trialId: string, reviewStatus: Grade["reviewStatus"]): Grade {
  return GradeSchema.parse({
    gradeId: `${trialId}__${reviewStatus}__x`,
    trialId,
    questionId: trialId.split("__")[0]!,
    scoringVersion: "1",
    graderKind: reviewStatus === "human_confirmed" ? "human" : reviewStatus === "model_preliminary" ? "model" : "rule",
    rawScore: reviewStatus === "rule_graded" || reviewStatus === "human_confirmed" ? 5 : 0,
    maxScore: 10,
    items: [],
    reviewStatus,
    createdAt: "2026-10-09T00:00:00Z",
  });
}

describe("R4-2 review queue (what a human must look at)", () => {
  it("queues pending_human_review and model_preliminary; skips confirmed/rule/non-completed", () => {
    const trials = [trial("a"), trial("b"), trial("c"), trial("d"), trial("e", { executionStatus: "outcome_unknown", finalAnswerSheet: null })];
    const grades = [grade("a__without_tool__x__0", "rule_graded"), grade("b__without_tool__x__0", "model_preliminary"), grade("c__without_tool__x__0", "pending_human_review"), grade("d__without_tool__x__0", "human_confirmed")];
    const q = reviewQueue(trials, grades);
    const ids = q.map((r) => r.trial.questionId).sort();
    expect(ids).toEqual(["b", "c"]); // model_preliminary + pending; a(rule)/d(human) done; e not answerable
    expect(q.find((r) => r.trial.questionId === "b")?.reason).toMatch(/model_preliminary/);
  });

  it("a completed trial with NO grade is queued as ungraded", () => {
    const q = reviewQueue([trial("z")], []);
    expect(q).toHaveLength(1);
    expect(q[0]!.reason).toBe("ungraded");
  });
});
