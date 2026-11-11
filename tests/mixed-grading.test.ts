import { describe, it, expect } from "vitest";
import { gradeWithModel, confirmGrade } from "../src/grading/model-grader.js";
import { buildModeReport } from "../src/reporting/report.js";
import {
  PublicQuestionSchema,
  ScoringSpecSchema,
  TrialSchema,
  type PublicQuestion,
  type ScoringSpec,
  type Trial,
} from "../src/shared/contracts.js";

const q = PublicQuestionSchema.parse({ id: "open-1", version: "1", subject: "physics", answerKind: "open", stem: "Explain why the sky is blue.", assets: [] });
const scoring = ScoringSpecSchema.parse({ questionId: "open-1", questionVersion: "1", scoringVersion: "1", answerKind: "open", maxScore: 10, deterministicLocked: false });

function trial(over: Partial<Trial> = {}): Trial {
  return TrialSchema.parse({
    trialId: "open-1__without_tool__x__0",
    datasetId: "demo",
    datasetVersion: "1",
    questionId: "open-1",
    questionVersion: "1",
    provider: "faux",
    modelId: "faux-1",
    mode: "without_tool",
    configDigest: "d",
    promptVersion: "v1",
    toolsVersion: "v1",
    executionStatus: "completed",
    finalAnswerSheet: "Rayleigh scattering scatters shorter wavelengths more.",
    ...over,
  });
}

const reportWith = (grades: Parameters<typeof buildModeReport>[0]["grades"]) =>
  buildModeReport({
    mode: "without_tool",
    trials: [trial()],
    grades,
    questions: new Map<string, PublicQuestion>([["open-1", q]]),
    scorings: new Map<string, ScoringSpec>([["open-1", scoring]]),
    plannedMaxScore: 10,
  });

describe("R4-1 mixed grading: model preliminary + human confirm", () => {
  it("model grade is model_preliminary and is NOT counted as confirmed", async () => {
    const r = await gradeWithModel({ trial: trial(), question: q, scoring, graderComplete: async () => '{"score": 7, "evidence": "mostly correct"}' });
    expect(r.grade?.reviewStatus).toBe("model_preliminary");
    expect(r.grade?.graderKind).toBe("model");
    expect(r.grade?.rawScore).toBe(7);
    expect(reportWith([r.grade!]).totals.confirmedRaw).toBe(0); // shown but not counted
  });

  it("human confirmation moves it to human_confirmed and it counts", async () => {
    const r = await gradeWithModel({ trial: trial(), question: q, scoring, graderComplete: async () => '{"score": 7, "evidence": "ok"}' });
    const confirmed = confirmGrade(r.grade!, { by: "grader-A", score: 8, note: "adjusted up" });
    expect(confirmed.reviewStatus).toBe("human_confirmed");
    expect(confirmed.graderKind).toBe("human");
    expect(confirmed.rawScore).toBe(8);
    expect(confirmed.trialId).toBe(r.grade!.trialId);
    expect(reportWith([confirmed]).totals.confirmedRaw).toBe(8);
  });

  it("confirm without an explicit score keeps the model's proposed score", async () => {
    const r = await gradeWithModel({ trial: trial(), question: q, scoring, graderComplete: async () => '{"score": 6}' });
    const confirmed = confirmGrade(r.grade!, { by: "grader-B" });
    expect(confirmed.reviewStatus).toBe("human_confirmed");
    expect(confirmed.rawScore).toBe(6);
  });

  it("unparseable grader response -> NO model_preliminary (stays for human)", async () => {
    const r = await gradeWithModel({ trial: trial(), question: q, scoring, graderComplete: async () => "It seems fine, no numbers here." });
    expect(r.grade).toBeUndefined();
    expect(r.skipped).toMatch(/parse|pending/i);
  });

  it("clamps the model score to [0, maxScore]", async () => {
    const hi = await gradeWithModel({ trial: trial(), question: q, scoring, graderComplete: async () => '{"score": 999}' });
    expect(hi.grade?.rawScore).toBe(10);
    const lo = await gradeWithModel({ trial: trial(), question: q, scoring, graderComplete: async () => '{"score": -5}' });
    expect(lo.grade?.rawScore).toBe(0);
  });

  it("never grades a non-completed / truncated trial", async () => {
    const bad = await gradeWithModel({ trial: trial({ executionStatus: "outcome_unknown", finalAnswerSheet: null }), question: q, scoring, graderComplete: async () => '{"score": 5}' });
    expect(bad.grade).toBeUndefined();
    const trunc = await gradeWithModel({ trial: trial({ truncated: true }), question: q, scoring, graderComplete: async () => '{"score": 5}' });
    expect(trunc.grade).toBeUndefined();
  });

  it("a failing grader call is surfaced, not guessed", async () => {
    const r = await gradeWithModel({
      trial: trial(),
      question: q,
      scoring,
      graderComplete: async () => {
        throw new Error("grader endpoint 500");
      },
    });
    expect(r.grade).toBeUndefined();
    expect(r.skipped).toMatch(/grader call failed/i);
  });
});
