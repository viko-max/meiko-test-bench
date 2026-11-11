import { describe, it, expect } from "vitest";
import { computeConfigDigest } from "../src/shared/ids.js";

const base = {
  datasetId: "demo",
  datasetVersion: "1",
  provider: "longcat",
  modelId: "M",
  mode: "without_tool",
  promptVersion: "v1",
  toolsVersion: "v1",
  baseUrl: "https://a.example/v1",
  api: "openai-completions",
  model: { id: "M", contextWindow: 8192, maxTokens: 1024, input: ["text"], reasoning: false },
  limits: { requestTimeoutMs: 300000, maxOutputTokens: 8192 },
};

describe("P1-3 recovery identity includes endpoint + model config + dataset version", () => {
  it("different baseUrl -> different configDigest (same modelId)", () => {
    expect(computeConfigDigest(base)).not.toBe(computeConfigDigest({ ...base, baseUrl: "https://b.example/v1" }));
  });
  it("different api -> different digest", () => {
    expect(computeConfigDigest(base)).not.toBe(computeConfigDigest({ ...base, api: "anthropic-messages" }));
  });
  it("different model config (maxTokens) -> different digest", () => {
    expect(computeConfigDigest(base)).not.toBe(computeConfigDigest({ ...base, model: { ...base.model, maxTokens: 2048 } }));
  });
  it("different datasetVersion -> different digest", () => {
    expect(computeConfigDigest(base)).not.toBe(computeConfigDigest({ ...base, datasetVersion: "2" }));
  });
  it("identical identity -> stable digest", () => {
    expect(computeConfigDigest(base)).toBe(computeConfigDigest({ ...base }));
  });
});
