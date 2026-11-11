import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createRegistry, resolveModel } from "../src/providers/pi-adapter.js";
import { makeExamStreamFn } from "../src/providers/stream-fn.js";
import { ModelsConfigSchema } from "../src/shared/contracts.js";
import { RequestMetricsCollector } from "../src/runner/request-metrics.js";

const official = "https://maas-api.cn-huabei-1.xf-yun.com/v2";
function fixture(baseUrl = official, id = "spark-x2.6", api = "openai-completions") {
  const config = ModelsConfigSchema.parse({ version: "1", profiles: [{
    id: "spark", displayName: "Spark", provider: "spark-test", api, baseUrl,
    auth: { envVars: ["UNUSED_SPARK_TEST_KEY"] },
    models: [{ id, name: id, contextWindow: 1000000, maxTokens: 1024, reasoning: true }],
  }] });
  const registry = createRegistry(config);
  return { registry, model: resolveModel(registry, "spark", id)! };
}

describe("星火官方 Chat 协议兼容", () => {
  it.each([official, `${official}/`])("仅提供文档支持的思考开关：%s", (baseUrl) => {
    const { model } = fixture(baseUrl);
    expect(getSupportedThinkingLevels(model)).toEqual(["off", "high"]);
    expect(model.compat).toMatchObject({ supportsDeveloperRole: false, supportsReasoningEffort: false });
  });

  it.each([
    ["https://proxy.example/v2", "spark-x2.6", "openai-completions"],
    ["https://maas-api.cn-huabei-1.xf-yun.com.attacker.example/v2", "spark-x2.6", "openai-completions"],
    ["https://maas-api.cn-huabei-1.xf-yun.com/v1", "spark-x2.6", "openai-completions"],
    [official, "spark-x2.6-4b", "openai-completions"],
    [official, "spark-x2.6", "anthropic-messages"],
  ])("不向其他端点或模型继承兼容设置：%s %s %s", (baseUrl, id, api) => {
    expect(fixture(baseUrl, id, api).model.compat).toBeUndefined();
  });

  it.each([undefined, "high"] as const)("真实 Pi 编码、流事件和原生用量路径：%s", async (reasoning) => {
    const { model, registry } = fixture();
    const metrics = new RequestMetricsCollector(); metrics.setThinkingLevel(reasoning ?? "off");
    const payloads: Record<string, unknown>[] = [];
    let calls = 0;
    const options: SimpleStreamOptions = {
      apiKey: "offline-test-only", reasoning,
      onPayload: (payload) => { payloads.push(payload as Record<string, unknown>); },
      fetch: async (input, init) => {
        calls++;
        expect(String(input)).toBe(`${official}/chat/completions`);
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ max_completion_tokens: 64, thinking: { type: reasoning ? "enabled" : "disabled" }, messages: [{ role: "system" }, { role: "user" }] });
        expect(body).not.toHaveProperty("reasoning_effort"); expect(body).not.toHaveProperty("store");
        const chunk = (choices: unknown[], usage?: unknown) => `data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", created: 1, model: model.id, choices, ...(usage ? { usage } : {}) })}\n\n`;
        return new Response(chunk([{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }])
          + chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8,
            prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } })
          + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      },
    };
    const stream = metrics.wrap(makeExamStreamFn(registry.models, { maxTokens: 64, timeoutMs: 2000 }))(model,
      { systemPrompt: "Test", messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }] }, options);
    for await (const _event of await stream) { /* 由 Pi 消费标准流协议，不自行解析 SSE。 */ }
    expect((await (await stream).result()).stopReason).toBe("stop"); expect(calls).toBe(1); expect(payloads).toHaveLength(1);
    expect(metrics.snapshot().requests[0]).toMatchObject({ status: "completed", usageSource: "native",
      sentThinking: reasoning ? "enabled" : "disabled", usage: { input: 5, output: 3, reasoning: 0, cacheRead: 0, totalTokens: 8 } });
  });
});
