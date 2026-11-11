import { describe, it, expect } from "vitest";
import { answerReusable } from "../src/runner/archive.js";
import { TrialSchema } from "../src/shared/contracts.js";

const trial = (digest?: string) =>
  TrialSchema.parse({
    trialId: "q__without_tool__x__0", datasetId: "d", datasetVersion: "1", questionId: "q", questionVersion: "1",
    provider: "p", modelId: "m", mode: "without_tool", configDigest: "c", promptVersion: "v1", toolsVersion: "v1",
    executionStatus: "completed", finalAnswerSheet: "ans", ...(digest ? { questionContentDigest: digest } : {}),
  });

describe("P1-1b resume reuses an answer only if question CONTENT is unchanged", () => {
  it("same content digest -> reusable", () => {
    expect(answerReusable(trial("abc"), "abc")).toBe(true);
  });
  it("changed content at the SAME version -> NOT reusable (block)", () => {
    expect(answerReusable(trial("abc"), "def")).toBe(false);
  });
  it("missing digest on either side -> not reusable (cannot verify)", () => {
    expect(answerReusable(trial(undefined), "abc")).toBe(false);
    expect(answerReusable(trial("abc"), undefined)).toBe(false);
  });
});
