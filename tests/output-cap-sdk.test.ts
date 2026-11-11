import { expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { fauxProvider, type Models } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { makeExamStreamFn } from "../src/providers/stream-fn.js";
import { runOneTrial } from "../src/runner/trial-service.js";
import { PublicQuestionSchema, RunSpecSchema } from "../src/shared/contracts.js";
import { InMemoryTrialRecorder } from "../src/storage/recorder.js";

it("真实 Anthropic SDK + Agent 将扩大的 thinking 输出重新限制，记录参数与本地服务器收到的一致", async () => {
  mkdirSync(resolve(".work"), { recursive: true });
  const root = mkdtempSync(resolve(".work", "output-cap-sdk-"));
  let calls = 0;
  let received: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    calls++;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (value: Record<string, unknown>) => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
      event({ type: "message_start", message: { id: "offline", type: "message", role: "assistant", content: [], model: "claude-3-7-sonnet-20250219", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "离线答卷" } });
      event({ type: "content_block_stop", index: 0 });
      event({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
      event({ type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local TCP address");
    const model = { ...fauxProvider().getModel(), id: "claude-3-7-sonnet-20250219", provider: "offline-local", api: "anthropic-messages" as const,
      baseUrl: `http://127.0.0.1:${address.port}`, reasoning: true, contextWindow: 128000, maxTokens: 32768 };
    const inner = makeExamStreamFn({ streamSimple } as unknown as Models, { maxTokens: 8192, timeoutMs: 3000 });
    const result = await runOneTrial({
      runSpec: RunSpecSchema.parse({ datasetId: "demo", datasetVersion: "1", questionId: "q1", questionVersion: "1", provider: model.provider, modelId: model.id, mode: "without_tool", thinkingLevel: "high", promptVersion: "v1", toolsVersion: "v1", limits: { maxOutputTokens: 8192 } }),
      question: PublicQuestionSchema.parse({ id: "q1", version: "1", subject: "math", answerKind: "open", stem: "离线测试题。", assets: [] }), index: 0,
      model, streamFn: (m, c, options) => inner(m, c, { ...options, apiKey: "offline-placeholder" }),
      tools: [], toolsVersion: "v1", runsRoot: join(root, "runs"), workRoot: join(root, "work"), recorder: new InMemoryTrialRecorder(),
    });
    expect(result.trial.executionStatus).toBe("completed");
    expect(calls).toBe(1);
    expect(received?.max_tokens).toBe(8192);
    const thinking = received?.thinking as { type: string; budget_tokens: number };
    expect(thinking.type).toBe("enabled");
    expect(thinking.budget_tokens).toBeLessThan(8192);
    expect(result.trial.metrics!.requests[0]!.sentThinking).toBe(`enabled / budget=${thinking.budget_tokens}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
});
