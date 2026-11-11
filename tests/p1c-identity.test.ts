import { describe, it, expect } from "vitest";
import { deriveTrialId } from "../src/shared/ids.js";
import { regradeApplicable } from "../src/grading/grade.js";
import { ScoringSpecSchema, TrialSchema } from "../src/shared/contracts.js";

const base = {
  datasetId: "demo",
  datasetVersion: "1",
  questionId: "q",
  questionVersion: "1",
  provider: "p",
  modelId: "m",
  mode: "without_tool" as const,
  configDigest: "c",
  promptVersion: "v1",
  toolsVersion: "v1",
  questionContentDigest: "hashA",
};

describe("P1-C question CONTENT is part of the trial identity", () => {
  it("same version but different content digest -> different trialId (no stale reuse)", () => {
    expect(deriveTrialId(base, 0)).not.toBe(deriveTrialId({ ...base, questionContentDigest: "hashB" }, 0));
  });
  it("same content -> stable trialId", () => {
    expect(deriveTrialId(base, 0)).toBe(deriveTrialId({ ...base }, 0));
  });
});

describe("P1-C offline regrade binds to the matching question version", () => {
  const trial = TrialSchema.parse({ trialId: "q__without_tool__x__0", datasetId: "d", datasetVersion: "1", questionId: "q", questionVersion: "1", provider: "p", modelId: "m", mode: "without_tool", configDigest: "c", promptVersion: "v1", toolsVersion: "v1", executionStatus: "completed", finalAnswerSheet: "B" });
  const spec = (questionVersion: string) => ScoringSpecSchema.parse({ questionId: "q", questionVersion, scoringVersion: "1", answerKind: "single_choice", maxScore: 5, reference: "B", deterministicLocked: true });

  it("only re-grades when the archived answer's question version matches the current scoring", () => {
    expect(regradeApplicable(trial, spec("1"))).toBe(true);
    expect(regradeApplicable(trial, spec("2"))).toBe(false); // old-version answer must NOT be graded by the new standard
  });
});
