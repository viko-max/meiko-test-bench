import { describe, it, expect } from "vitest";
import {
  PublicQuestionSchema,
  ScoringSpecSchema,
  ModelsConfigSchema,
  publicRequestPayload,
  assertNoScoringLeak,
  findScoringLeaks,
  assertPublicAssetsClean,
  AnswerIsolationError,
} from "../src/shared/contracts.js";
import { deriveTrialId, deriveRunId } from "../src/shared/ids.js";
import { assertNoCredentials, scanValueShapes, scanKeyNames, CredentialInConfigError } from "../src/shared/creds.js";
import { sha256OfJsonable, requireSha256Hex } from "../src/shared/hashing.js";

const sampleQuestion = {
  id: "phy-001",
  version: "1",
  subject: "physics",
  answerKind: "numeric_unit",
  stem: "A block of mass 2 kg accelerates at $3\\,\\mathrm{m/s^2}$. Find the force.",
  assets: [],
};

describe("PublicQuestion / ScoringSpec separation", () => {
  it("parses a public question and rejects scoring fields via strict()", () => {
    const q = PublicQuestionSchema.parse(sampleQuestion);
    expect(q.id).toBe("phy-001");
    expect(() =>
      PublicQuestionSchema.parse({ ...sampleQuestion, reference_answer: "6 N" }),
    ).toThrow();
  });

  it("publicRequestPayload contains only whitelisted fields and no scoring keys", () => {
    const q = PublicQuestionSchema.parse(sampleQuestion);
    const payload = publicRequestPayload(q);
    expect(findScoringLeaks(payload)).toEqual([]);
    expect(() => assertNoScoringLeak(payload)).not.toThrow();
    expect(Object.keys(payload).sort()).toEqual(
      ["answerKind", "assets", "id", "language", "stem", "subject", "tags", "version"].sort(),
    );
  });

  it("rejects a public asset carrying a scoring role", () => {
    const q = PublicQuestionSchema.parse({
      ...sampleQuestion,
      assets: [{ ref: "ans.png", mediaType: "image/png", role: "answer_key" }],
    });
    expect(() => assertPublicAssetsClean(q)).toThrow(AnswerIsolationError);
  });

  it("scoring spec is a distinct type that can hold the answer", () => {
    const s = ScoringSpecSchema.parse({
      questionId: "phy-001",
      questionVersion: "1",
      scoringVersion: "1",
      answerKind: "numeric_unit",
      maxScore: 10,
      reference: "6 N",
      tolerance: 0.01,
      units: ["N"],
      deterministicLocked: true,
    });
    expect(s.maxScore).toBe(10);
    expect(findScoringLeaks({ scoring: s }).length).toBeGreaterThan(0); // it IS scoring material
  });
});

describe("credential scanning", () => {
  it("flags secret VALUES but not env-var NAMES", () => {
    expect(scanValueShapes("sk-abcdefghijklmnop1234").length).toBeGreaterThan(0);
    expect(scanValueShapes("cmk_1_abcdefghijklmnop").length).toBeGreaterThan(0);
    expect(scanValueShapes("PI_EXAM_STEPFUN_API_KEY")).toEqual([]);
    const cfg = { auth: { envVars: ["PI_EXAM_STEPFUN_API_KEY"] } };
    expect(scanKeyNames(cfg)).toEqual([]);
    expect(() => assertNoCredentials(cfg, "test")).not.toThrow();
  });

  it("rejects a config that embeds a real key", () => {
    const bad = { profiles: [{ auth: { envVars: ["X"] }, baseUrl: "https://x", note: "sk-abcdefghijklmnop1234" }] };
    expect(() => assertNoCredentials(bad, "models.json")).toThrow(CredentialInConfigError);
    expect(() => scanKeyNames({ api_key: "x" }).length).toBeTruthy();
  });
});

describe("models config validation", () => {
  it("accepts the example config (env-var names only)", () => {
    const cfg = ModelsConfigSchema.parse({
      version: "1",
      profiles: [
        {
          id: "stepfun",
          displayName: "StepFun",
          provider: "stepfun",
          api: "openai-completions",
          baseUrl: "https://api.stepfun.com/step_plan/v1",
          auth: { envVars: ["PI_EXAM_STEPFUN_API_KEY"] },
          models: [{ id: "step-3.7-flash", name: "Step 3.7 Flash", input: ["text", "image"], contextWindow: 256000, maxTokens: 8192 }],
        },
      ],
    });
    expect(cfg.profiles[0]!.capability.text).toBe("unverified");
  });

  it("rejects an env var name that is not an env var name", () => {
    expect(() =>
      ModelsConfigSchema.parse({
        version: "1",
        profiles: [
          {
            id: "x",
            displayName: "x",
            provider: "x",
            api: "openai-completions",
            baseUrl: "https://x.invalid",
            auth: { envVars: ["not-an-env-var"] },
            models: [{ id: "m", name: "m", input: ["text"], contextWindow: 1, maxTokens: 1 }],
          },
        ],
      }),
    ).toThrow();
  });
});

describe("identity + hashing", () => {
  it("derives stable trial/run ids and rejects bad sha", () => {
    const id = deriveTrialId(
      {
        datasetId: "d",
        datasetVersion: "1",
        questionId: "phy-001",
        questionVersion: "1",
        provider: "stepfun",
        modelId: "step-3.7-flash",
        mode: "with_tool",
        configDigest: "abc",
        promptVersion: "v1",
        toolsVersion: "v1",
      },
      0,
    );
    expect(id.startsWith("phy-001__with_tool__")).toBe(true);
    expect(deriveRunId({ datasetId: "d", datasetVersion: "1", provider: "p", modelId: "m", configDigest: "abc" })).toContain("d@1");
    expect(sha256OfJsonable({ b: 1, a: 2 })).toBe(sha256OfJsonable({ a: 2, b: 1 }));
    expect(() => requireSha256Hex("ABC")).toThrow();
  });
});
