import { describe, it, expect, afterEach } from "vitest";
import { listProviderGroups, createMergedRegistry, synthesizeBuiltinProfile } from "../src/providers/pi-catalog.js";
import { loadModelsConfig } from "../src/providers/models-config.js";
import { resolveModel } from "../src/providers/pi-adapter.js";
import { ModelProfileSchema } from "../src/shared/contracts.js";

const cfg = loadModelsConfig("configs/models.example.json");

afterEach(() => {
  delete process.env.PI_EXAM_LONGCAT_API_KEY;
});

describe("pi-catalog: merged provider/model listing", () => {
  it("配置编号与 provider 不同仍保留明确对应关系", () => {
    const profile = ModelProfileSchema.parse({ id: "custom-config", displayName: "Custom", provider: "custom-provider", api: "openai-completions",
      baseUrl: "https://example.com/v1", auth: { envVars: ["OFFLINE_CATALOG_KEY"] }, models: [{ id: "custom-model", name: "Custom", input: ["text"], contextWindow: 32768, maxTokens: 4096 }] });
    const group = listProviderGroups({ version: "1", profiles: [profile] }).find((entry) => entry.providerId === profile.provider)!;
    expect(group.models[0]?.profileId).toBe(profile.id);
    expect(group.models[0]?.providerId).toBe(profile.provider);
    expect(resolveModel(createMergedRegistry({ version: "1", profiles: [profile] }), group.models[0]!.profileId, group.models[0]!.modelId)?.baseUrl).toBe(profile.baseUrl);
  });

  it("自定义端点覆盖内置 provider 时不显示已被注册表替换的模型", () => {
    const profile = ModelProfileSchema.parse({ id: "custom-openai", displayName: "My endpoint", provider: "openai", api: "openai-completions",
      baseUrl: "https://example.com/v1", auth: { envVars: ["OFFLINE_CATALOG_KEY"] }, models: [{ id: "endpoint-only", name: "Only", input: ["text"], contextWindow: 32768, maxTokens: 4096 }] });
    const group = listProviderGroups({ version: "1", profiles: [profile] }).find((entry) => entry.providerId === "openai")!;
    expect(group.displayName).toBe(profile.displayName);
    expect(group.models.map((entry) => entry.modelId)).toEqual(["endpoint-only"]);
    expect(group.models[0]?.profileId).toBe(profile.id);
  });

  it("includes both pi built-in providers and our custom endpoints", () => {
    const groups = listProviderGroups(cfg);
    const ids = groups.map((g) => g.providerId);
    expect(ids).toContain("openai"); // pi built-in
    expect(ids).toContain("longcat"); // our custom endpoint
    expect(groups.length).toBeGreaterThan(20); // pi's catalog is large
  });

  it("sorts custom + runnable groups before the rest", () => {
    process.env.PI_EXAM_LONGCAT_API_KEY = "test-key";
    const groups = listProviderGroups(cfg);
    const longcat = groups.findIndex((g) => g.providerId === "longcat");
    const someBuiltin = groups.findIndex((g) => g.source === "builtin" && !g.runnable);
    expect(longcat).toBeGreaterThanOrEqual(0);
    expect(longcat).toBeLessThan(someBuiltin);
  });

  it("marks a provider runnable only when its key env var is set", () => {
    delete process.env.PI_EXAM_LONGCAT_API_KEY;
    expect(listProviderGroups(cfg).find((g) => g.providerId === "longcat")?.runnable).toBe(false);
    process.env.PI_EXAM_LONGCAT_API_KEY = "test-key";
    expect(listProviderGroups(cfg).find((g) => g.providerId === "longcat")?.runnable).toBe(true);
  });
});

describe("pi-catalog: merged registry resolves custom AND built-in models", () => {
  it("resolves a custom model from the public template with its verified capability", () => {
    const reg = createMergedRegistry(cfg);
    const model = resolveModel(reg, "longcat", "LongCat-2.5-Preview");
    expect(model?.id).toBe("LongCat-2.5-Preview");
    expect(reg.profilesById.get("longcat")?.capability.imageInput).toBe("unsupported");
  });

  it("synthesizes a profile for a pi built-in model and resolves it", () => {
    const synth = synthesizeBuiltinProfile("openai", "gpt-4");
    expect(synth).toBeDefined();
    expect(synth?.provider).toBe("openai");
    expect(synth?.api).toBeTruthy();
    expect(synth?.baseUrl).toMatch(/^https?:\/\//);
    const reg = createMergedRegistry(cfg);
    reg.profilesById.set(synth!.id, synth!);
    const model = resolveModel(reg, "openai", "gpt-4");
    expect(model?.id).toBe("gpt-4");
  });

  it("returns undefined for an unknown built-in model", () => {
    expect(synthesizeBuiltinProfile("openai", "no-such-model-xyz")).toBeUndefined();
  });
});
