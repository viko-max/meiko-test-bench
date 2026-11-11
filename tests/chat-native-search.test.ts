import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ChatService } from "../src/service/chat-service.js";
import { ChatConfigSchema } from "../src/shared/chat.js";
import { ModelProfileSchema, ModelsConfigSchema } from "../src/shared/contracts.js";
import { createRegistry } from "../src/providers/pi-adapter.js";
import { injectSparkNativeSearch, sparkNativeSearchSupport } from "../src/providers/spark-native-search.js";
import { sha256OfJsonable } from "../src/shared/hashing.js";
import { assertNoCredentials } from "../src/shared/creds.js";

// 讯飞星火官方档案：能力以官方文档核对为准，未核实即未验证（AGENTS.md §6/§10）。
const SPARK_PROFILE = {
  id: "spark",
  displayName: "Spark X2.6",
  provider: "xfyun-spark",
  api: "openai-completions",
  baseUrl: "https://maas-api.cn-huabei-1.xf-yun.com/v2",
  auth: { envVars: ["PI_EXAM_SPARK_API_KEY"] },
  models: [{ id: "spark-x2.6", name: "Spark X2.6", input: ["text"], reasoning: true, contextWindow: 1000000, maxTokens: 8192 }],
  capability: { nativeWebSearch: "verified" },
};

/** 模板里 $ 开头键只是文档说明，不属于模型档案字段。 */
function stripDocKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDocKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (!key.startsWith("$")) out[key] = stripDocKeys(item);
    return out;
  }
  return value;
}

function systemText(context: { messages: ReadonlyArray<{ role: string; content: unknown }> }): string {
  const message = context.messages.find((item) => item.role === "system");
  if (!message) return "";
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

describe("供应商原生网络搜索（星火）", () => {
  it("聊天配置未声明时关闭原生网络搜索", () => {
    expect(ChatConfigSchema.parse({ profileId: "unselected", modelId: "unselected" }).nativeSearch).toBe(false);
  });

  it("模型档案未声明原生搜索时按未核实处理", () => {
    const profile = ModelProfileSchema.parse({
      id: "plain", displayName: "普通档案", provider: "plain", api: "openai-completions",
      baseUrl: "https://example.invalid/v1", auth: { envVars: ["PI_EXAM_PLAIN_API_KEY"] },
      models: [{ id: "plain-1", name: "plain-1", contextWindow: 128000, maxTokens: 8192 }],
    });
    expect(profile.capability.nativeWebSearch).toBe("unverified");
  });

  it.each([
    "https://maas-api.cn-huabei-1.xf-yun.com/v2",
    "https://maas-api.cn-huabei-1.xf-yun.com/v2/",
  ])("星火官方地址允许原生搜索：%s", (baseUrl) => {
    const support = sparkNativeSearchSupport(ModelProfileSchema.parse({ ...SPARK_PROFILE, baseUrl }), "spark-x2.6");
    expect(support.supported).toBe(true);
    expect(support.reason).toBeNull();
  });

  it.each([
    ["档案 id 不是 spark", { ...SPARK_PROFILE, id: "spark-other" }, "spark-x2.6"],
    ["provider 不是 xfyun-spark", { ...SPARK_PROFILE, provider: "other-provider" }, "spark-x2.6"],
    ["api 不是 openai-completions", { ...SPARK_PROFILE, api: "anthropic-messages" }, "spark-x2.6"],
    ["模型不是 spark-x2.6", SPARK_PROFILE, "spark-x2.5"],
    ["接口地址不是官方域名", { ...SPARK_PROFILE, baseUrl: "https://maas-api.cn-huabei-1.xf-yun.com.attacker.example/v2" }, "spark-x2.6"],
    ["接口路径不是 /v2", { ...SPARK_PROFILE, baseUrl: "https://maas-api.cn-huabei-1.xf-yun.com/v1" }, "spark-x2.6"],
    ["接口地址带查询参数", { ...SPARK_PROFILE, baseUrl: "https://maas-api.cn-huabei-1.xf-yun.com/v2?a=1" }, "spark-x2.6"],
    ["接口地址带片段", { ...SPARK_PROFILE, baseUrl: "https://maas-api.cn-huabei-1.xf-yun.com/v2#f" }, "spark-x2.6"],
    ["接口地址带用户名密码", { ...SPARK_PROFILE, baseUrl: "https://user:pass@maas-api.cn-huabei-1.xf-yun.com/v2" }, "spark-x2.6"],
    ["原生搜索能力未核实", { ...SPARK_PROFILE, capability: { nativeWebSearch: "unverified" } }, "spark-x2.6"],
  ] as Array<[string, Record<string, unknown>, string]>)("拒绝原生搜索：%s", (_name, raw, modelId) => {
    const support = sparkNativeSearchSupport(ModelProfileSchema.parse(raw), modelId);
    expect(support.supported).toBe(false);
    expect(support.reason).toBeTruthy();
  });

  it("注入原生搜索参数时保留原字段并精确设置 tools 与 tool_choice", () => {
    const payload = { model: "spark-x2.6", max_completion_tokens: 4096, thinking: { type: "enabled" }, tools: [] };
    const result = injectSparkNativeSearch(payload);
    expect(result.model).toBe("spark-x2.6");
    expect(result.max_completion_tokens).toBe(4096);
    expect(result.thinking).toEqual({ type: "enabled" });
    expect(result.tools).toEqual([{ type: "web_search", web_search: { enable: true } }]);
    expect(result.tool_choice).toBe("auto");
    expect(result).not.toHaveProperty("search_mode");
    expect(payload.tools).toEqual([]);
  });

  it("拒绝非普通对象载荷以及已带工具的载荷", () => {
    expect(() => injectSparkNativeSearch(null)).toThrow();
    expect(() => injectSparkNativeSearch([])).toThrow();
    expect(() => injectSparkNativeSearch({ tools: "not-an-array" })).toThrow();
    expect(() => injectSparkNativeSearch({ tools: [{ type: "custom" }] })).toThrow();
    expect(() => injectSparkNativeSearch({ tools: [{ type: "FunctionCall", name: "run" }] })).toThrow();
  });

  it("公开配置模板记录星火原生搜索为已核实且区分文档与实测证据", () => {
    const raw = JSON.parse(readFileSync(resolve("configs/models.example.json"), "utf8"));
    const config = ModelsConfigSchema.parse(stripDocKeys(raw));
    const spark = config.profiles.find((profile) => profile.id === "spark");
    expect(spark?.capability.nativeWebSearch).toBe("verified");
    expect(spark?.capability.verificationEvidence).toContain("https://maas.xfyun.cn/doc/guide/");
    expect(spark?.capability.verificationEvidence).toContain("不是本 Harness 的真实请求验证");
    expect(() => assertNoCredentials(config, "configs/models.example.json")).not.toThrow();
  });

  it("聊天开启原生搜索时注入供应商 web_search 并换用原生搜索系统提示", async () => {
    vi.stubEnv("PI_EXAM_SPARK_API_KEY", "offline-native-search-placeholder");
    try {
      const config = ChatConfigSchema.parse({
        profileId: "spark", modelId: "spark-x2.6", nativeSearch: true, maxTotalTokens: 10000, maxOutputTokens: 128,
      });
      const registry = createRegistry(ModelsConfigSchema.parse({ version: "1", profiles: [ModelProfileSchema.parse(SPARK_PROFILE)] }));
      mkdirSync(resolve(".work"), { recursive: true });
      const root = mkdtempSync(resolve(".work", "chat-native-search-"));
      const service = new ChatService(join(root, "chats"));
      const session = service.create(config.maxTotalTokens);
      const authorization = {
        authorisePaid: true as const,
        modelIdentity: service.selection(config, registry).snapshot.identity,
        historyDigest: sha256OfJsonable(service.get(session.id)),
      };

      const message = fauxAssistantMessage("离线原生搜索");
      message.usage = { ...message.usage, input: 8, output: 4, totalTokens: 12 };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      let capturedOptions: { maxRetries?: number; signal?: AbortSignal; onPayload?: (payload: unknown, model: unknown) => unknown } | undefined;
      let capturedContext: { messages: ReadonlyArray<{ role: string; content: unknown }> } | undefined;
      let injected: Promise<unknown> | undefined;
      const spy = vi.spyOn(registry.models, "streamSimple").mockImplementation((model, context, options) => {
        capturedOptions = options;
        capturedContext = context;
        injected = Promise.resolve(options?.onPayload?.(
          { model: "spark-x2.6", messages: [], max_completion_tokens: 4096, thinking: { type: "disabled" } }, model,
        ));
        return stream;
      });

      const result = await service.respond(session.id, "请用原生搜索回答", config, registry, authorization);

      expect(spy).toHaveBeenCalledOnce();
      expect(result.turns[0]?.status).toBe("completed");
      expect(result.turns[0]?.config.nativeSearch).toBe(true);
      expect(capturedOptions?.maxRetries).toBe(0);
      expect(capturedOptions?.signal).toBeInstanceOf(AbortSignal);
      const payload = (await injected) as Record<string, unknown>;
      expect(payload.max_completion_tokens).toBe(128);
      expect(payload.thinking).toEqual({ type: "disabled" });
      expect(payload.tools).toEqual([{ type: "web_search", web_search: { enable: true } }]);
      expect(payload.tool_choice).toBe("auto");
      expect(payload).not.toHaveProperty("search_mode");
      expect(systemText(capturedContext ?? { messages: [] })).toContain("供应商提供的原生网络搜索");
      expect(systemText(capturedContext ?? { messages: [] })).not.toContain("没有搜索、文件读取或代码执行工具");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("换用其他模型仍开启原生搜索时选择被拒绝且不发起请求", () => {
    vi.stubEnv("PI_EXAM_SPARK_API_KEY", "offline-native-search-placeholder");
    try {
      const registry = createRegistry(ModelsConfigSchema.parse({ version: "1", profiles: [ModelProfileSchema.parse(SPARK_PROFILE)] }));
      const config = ChatConfigSchema.parse({
        profileId: "spark", modelId: "spark-x2.5", nativeSearch: true, maxTotalTokens: 10000, maxOutputTokens: 128,
      });
      mkdirSync(resolve(".work"), { recursive: true });
      const root = mkdtempSync(resolve(".work", "chat-native-search-"));
      const service = new ChatService(join(root, "chats"));
      const spy = vi.spyOn(registry.models, "streamSimple").mockImplementation(() => {
        throw new Error("不应发起真实请求");
      });
      expect(() => service.selection(config, registry)).toThrow(/不可用|不支持/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
