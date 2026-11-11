import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChatService } from "../src/service/chat-service.js";
import { ChatConfigSchema } from "../src/shared/chat.js";
import { ModelsConfigSchema } from "../src/shared/contracts.js";
import { createRegistry } from "../src/providers/pi-adapter.js";
import { sha256OfJsonable } from "../src/shared/hashing.js";

describe("聊天的真实 SDK 本地接口集成", () => {
  it("HTTP/SSE 两轮消息、原生用量和预算完整贯通，没有外部付费请求", async () => {
    const requests: Array<{ messages: Array<{ role: string; content: unknown }>; stream: boolean }> = [];
    const server = createServer((request, response) => {
      request.setEncoding("utf8"); let input = "";
      request.on("data", (chunk: string) => { input += chunk; });
      request.on("end", () => {
        requests.push(JSON.parse(input));
        response.writeHead(200, { "content-type": "text/event-stream" });
        const event = (choices: unknown[], usage?: unknown) => response.write(`data: ${JSON.stringify({ id: "offline-chat", object: "chat.completion.chunk", created: 1, model: "local-text", choices, ...(usage ? { usage } : {}) })}\n\n`);
        event([{ index: 0, delta: { role: "assistant", content: "本地 SDK 流式回答" }, finish_reason: null }]);
        event([{ index: 0, delta: {}, finish_reason: "stop" }]);
        event([], { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108, prompt_tokens_details: { cached_tokens: 40 } });
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    vi.stubEnv("OFFLINE_CHAT_HTTP_KEY", "local-transport-fixture-only");
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server port");
      mkdirSync(resolve(".work"), { recursive: true }); const root = mkdtempSync(resolve(".work", "chat-http-"));
      const registry = createRegistry(ModelsConfigSchema.parse({ version: "1", profiles: [{ id: "local-chat", provider: "local-chat", displayName: "本地传输验证", api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, auth: { envVars: ["OFFLINE_CHAT_HTTP_KEY"] }, models: [{ id: "local-text", name: "Local text", input: ["text"], contextWindow: 32768, maxTokens: 4096 }] }] }));
      const config = ChatConfigSchema.parse({ profileId: "local-chat", modelId: "local-text", maxOutputTokens: 128, maxTotalTokens: 10000, requestTimeoutMs: 5000 });
      const service = new ChatService(join(root, "chats")), session = service.create(config.maxTotalTokens);
      for (const input of ["中文请求一", "继续上一条对话"]) {
        const result = await service.respond(session.id, input, config, registry, { authorisePaid: true, modelIdentity: service.selection(config, registry).snapshot.identity, historyDigest: sha256OfJsonable(service.get(session.id)) });
        expect(result.turns.at(-1)?.status).toBe("completed"); expect(result.turns.at(-1)?.response?.content[0]?.text).toBe("本地 SDK 流式回答");
      }
      expect(requests).toHaveLength(2); expect(requests.every((request) => request.stream)).toBe(true);
      expect(JSON.stringify(requests[1]?.messages)).toContain("中文请求一"); expect(JSON.stringify(requests[1]?.messages)).toContain("本地 SDK 流式回答");
      const result = service.get(session.id), metrics = service.metrics(result);
      expect(metrics.tokens.totalTokens.value).toBe(216); expect(metrics.cacheHitRate).toBe(0.4); expect(metrics.requestTps).toBeGreaterThan(0);
      expect(result.turns[0]?.metrics?.requests[0]?.usageSource).toBe("native"); expect(result.turns[0]?.metrics?.requests[0]?.usage.reasoning).toBeNull();
      expect(service.budget(session.id)?.knownTokens).toBe(216); expect(service.budget(session.id)?.entries).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    }
  }, 15000);
});
