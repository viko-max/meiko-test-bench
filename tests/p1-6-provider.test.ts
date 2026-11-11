import { describe, it, expect } from "vitest";
import { createRegistry } from "../src/providers/pi-adapter.js";
import { ModelsConfigSchema } from "../src/shared/contracts.js";

const profile = (id: string, provider: string, baseUrl: string) => ({
  id,
  displayName: id,
  provider,
  api: "openai-completions",
  baseUrl,
  auth: { envVars: ["SOME_KEY"] },
  models: [{ id: "m", name: "m", input: ["text"], reasoning: false, contextWindow: 8192, maxTokens: 1024 }],
  capability: {},
});

describe("P1-6 duplicate provider ids must not silently cross-wire endpoints", () => {
  it("rejects two profiles sharing a provider id (later would overwrite earlier)", () => {
    const cfg = ModelsConfigSchema.parse({ version: "1", profiles: [profile("a", "longcat", "https://a.example/v1"), profile("b", "longcat", "https://b.example/v1")] });
    expect(() => createRegistry(cfg)).toThrow(/duplicate provider/i);
  });

  it("distinct provider ids register independently", () => {
    const cfg = ModelsConfigSchema.parse({ version: "1", profiles: [profile("a", "longcat-a", "https://a.example/v1"), profile("b", "longcat-b", "https://b.example/v1")] });
    expect(() => createRegistry(cfg)).not.toThrow();
  });
});
