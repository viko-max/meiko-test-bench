import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type, fauxAssistantMessage, fauxToolCall, createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { boundedUtf8 } from "../src/shared/utf8.js";
import { runCommand } from "../src/tools/subprocess.js";
import { readFileTool } from "../src/tools/read-file.js";
import { makeToolContext } from "../src/tools/index.js";
import { contextBudget } from "../src/runner/context-budget.js";
import { runTrial } from "../src/runner/run-trial.js";
import { setupFaux } from "./helpers/faux.js";
import { ModelProfileSchema, PublicQuestionSchema } from "../src/shared/contracts.js";
import { runBatch } from "../src/runner/batch.js";
import { readManifest, writeManifest } from "../src/runner/answer-source.js";
import { TaskControlService } from "../src/service/task-service.js";
import { taskTelemetry } from "../src/service/task-metrics.js";
import { buildUserContent } from "../src/runner/prompt.js";
import { EXECUTION_POLICY_VERSION } from "../src/shared/execution-policy.js";
import { capOutputPayload } from "../src/providers/output-cap.js";
import type { TaskEvent } from "../src/runner/task-events.js";

const question = PublicQuestionSchema.parse({ id: "q1", version: "1", subject: "math", answerKind: "open", stem: "给出完整解答。", assets: [] });
function folder() {
  mkdirSync(resolve(".work"), { recursive: true });
  return mkdtempSync(resolve(".work", "runtime-hardening-"));
}
function batchFixture() {
  const root = folder();
  const datasetDir = join(root, "dataset");
  mkdirSync(join(datasetDir, "public"), { recursive: true });
  mkdirSync(join(datasetDir, "scoring"));
  writeFileSync(join(datasetDir, "public", "q1.md"), '---\nid: q1\nversion: "1"\nsubject: math\nanswer_kind: open\n---\n\n题目。\n');
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("完整答卷")]);
  const models = createModels(); models.setProvider(faux.provider);
  const profile = ModelProfileSchema.parse({ id: "faux", provider: "faux", displayName: "Faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] }, models: [{ id: "faux-1", name: "Faux", input: ["text"], contextWindow: 128000, maxTokens: 8192 }] });
  const params = { datasetDir, datasetId: "demo", modes: ["without_tool"] as Array<"without_tool" | "with_tool">, profileId: "faux", modelId: "faux-1", limit: 1, runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: "v1", pythonInterpreter: "python", modelsConfigPath: "unused", registryOverride: { models, profilesById: new Map([["faux", profile]]) } };
  return { root, faux, params };
}
const slow: AgentTool = { name: "slow", label: "Slow", description: "offline wait", parameters: Type.Object({}), execute: async (_id, _args, signal) => {
  await new Promise<void>((done) => { const timer = setTimeout(done, 100); signal?.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true }); });
  return { content: [{ type: "text", text: "工具结束" }], details: {} };
} };

describe("UTF-8 输出与文件读取边界", () => {
  it("中文、Emoji 按真实字节计数且保留完整字符", () => {
    for (let cap = 0; cap <= 16; cap++) {
      const value = boundedUtf8("甲🙂乙ab", cap);
      expect(Buffer.byteLength(value.text)).toBeLessThanOrEqual(cap);
      expect(value.text).not.toContain("�");
      expect(value.bytes).toBe(Buffer.byteLength(value.text));
    }
    expect(boundedUtf8("甲🙂乙", 7).text).toBe("甲🙂");
  });
  it("真实 Node 子进程跨块输出不会破坏 UTF-8；stdout/stderr 共享字节限制", async () => {
    const root = folder();
    const result = await runCommand({ cmd: process.execPath, args: ["-e", "const b=Buffer.from('甲🙂乙');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),10)"], cwd: root, timeoutMs: 5000, maxOutputBytes: 7 });
    expect(result.stdout).toBe("甲🙂"); expect(result.outputTruncated).toBe(true);
    const shared = await runCommand({ cmd: process.execPath, args: ["-e", "process.stdout.write('甲乙');process.stderr.write('丙丁')"], cwd: root, timeoutMs: 5000, maxOutputBytes: 8 });
    expect(Buffer.byteLength(shared.stdout) + Buffer.byteLength(shared.stderr)).toBeLessThanOrEqual(8);
    expect(shared.stdout + shared.stderr).not.toContain("�"); expect(shared.outputTruncated).toBe(true);
  });
  it("无效 UTF-8 的替代字符也不能突破最终文本字节限制", async () => {
    const result = await runCommand({ cmd: process.execPath, args: ["-e", "process.stdout.write(Buffer.from([255,255,255,255]))"], cwd: folder(), timeoutMs: 5000, maxOutputBytes: 4 });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4);
    expect(result.outputTruncated).toBe(true);
  });
  it("负数、零、小数、非有限及不安全的 maxBytes 被拒绝；大文件只返回受限内容", async () => {
    const root = folder();
    writeFileSync(join(root, "large.txt"), Buffer.alloc(2_000_000, 97));
    const tool = readFileTool(makeToolContext({ workDir: root, publicDir: root, questionFiles: [], pythonInterpreter: "python", limits: { perToolTimeoutMs: 1000, maxOutputBytes: 128, maxImagePixels: 1024 } }));
    for (const maxBytes of [-1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect((await tool.execute("bad", { path: "large.txt", maxBytes })).isError).toBe(true);
    const result = await tool.execute("ok", { path: "large.txt", maxBytes: 64 });
    expect(result.details).toMatchObject({ bytes: 64, totalBytes: 2_000_000, truncated: true });
    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("truncated"); expect(Buffer.byteLength(text)).toBeLessThanOrEqual(128);
    writeFileSync(join(root, "unicode.txt"), "甲🙂乙");
    const unicode = await tool.execute("unicode", { path: "unicode.txt", maxBytes: 5 });
    expect((unicode.content[0] as { text: string }).text).not.toContain("�");
  });
});

describe("上下文与实际 Agent loop", () => {
  it("估算包含图片、系统提示和工具声明，预留实际输出空间，并明确为估算", () => {
    const model = fauxProvider().getModel();
    const text = { role: "user" as const, content: "题目", timestamp: Date.now() };
    const plain = contextBudget(model, [text], 1000);
    const enriched = contextBudget(model, [{ role: "system", content: "system text", toolsAdded: [{ name: "calc", description: "long tool description", parameters: Type.Object({ code: Type.String() }) }], timestamp: Date.now() }, { ...text, content: [{ type: "text", text: "题目" }, { type: "image", data: "", mimeType: "image/png" }] }], 1000);
    expect(enriched.estimatedInputTokens).toBeGreaterThan(plain.estimatedInputTokens + 1000);
    expect(enriched).toMatchObject({ estimated: true, method: "pi-estimate", outputReserve: 1000, policyVersion: EXECUTION_POLICY_VERSION });
  });
  it("首请求超限时不发请求、不生成摘要，保存 context_check 事件", async () => {
    const setup = setupFaux([fauxAssistantMessage("不应被调用")], { mode: "without_tool", limits: { maxOutputTokens: 64 } });
    setup.agent.state.model = { ...setup.model, contextWindow: 512, maxTokens: 64 };
    const outcome = await runTrial({ agent: setup.agent, question: { ...question, stem: "x".repeat(6000) }, guard: setup.guard, recorder: setup.recorder });
    expect(outcome).toMatchObject({ executionStatus: "limit_reached", terminationCause: "context_limit" });
    expect(setup.faux.state.callCount).toBe(0);
    expect(setup.recorder.events.some((event) => (event as { type: string }).type === "context_check")).toBe(true);
    expect(setup.agent.state.messages.some((message) => message.role === "user" && JSON.stringify(message).includes("x".repeat(6000)))).toBe(true);
  });
  it("工具结果撑满上下文后拒绝第二次请求，不修改或删除已取得的工具结果", async () => {
    const largeTool: AgentTool = { name: "large", label: "Large", description: "offline", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "t".repeat(20000) }], details: {} }) };
    const setup = setupFaux([fauxAssistantMessage(fauxToolCall("large", {})), fauxAssistantMessage("不能第二次调用")], { mode: "with_tool", tools: [largeTool], limits: { maxOutputTokens: 64 } });
    setup.agent.state.model = { ...setup.model, contextWindow: 4096, maxTokens: 64 };
    const outcome = await runTrial({ agent: setup.agent, question, guard: setup.guard, recorder: setup.recorder });
    expect(outcome.terminationCause).toBe("context_limit"); expect(setup.faux.state.callCount).toBe(1);
    expect(JSON.stringify(setup.agent.state.messages)).toContain("t".repeat(20000));
  });
  it("整题 deadline 与用户停止分别归档；预先取消不会启动模型", async () => {
    const deadline = setupFaux([fauxAssistantMessage(fauxToolCall("slow", {})), fauxAssistantMessage("不应续答")], { mode: "with_tool", tools: [slow], limits: { totalRunTimeMs: 20 } });
    const time = await runTrial({ agent: deadline.agent, question, guard: deadline.guard, recorder: deadline.recorder });
    expect(time).toMatchObject({ executionStatus: "limit_reached", terminationCause: "total_time_limit" });
    const user = setupFaux([fauxAssistantMessage(fauxToolCall("slow", {})), fauxAssistantMessage("不应续答")], { mode: "with_tool", tools: [slow] });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    const stopped = await runTrial({ agent: user.agent, question, guard: user.guard, recorder: user.recorder, signal: controller.signal });
    clearTimeout(timer);
    expect(stopped).toMatchObject({ executionStatus: "interrupted", terminationCause: "user_stop" });
    const early = setupFaux([fauxAssistantMessage("不能发送")], { mode: "without_tool" });
    const cancelled = await runTrial({ agent: early.agent, question, guard: early.guard, recorder: early.recorder, signal: AbortSignal.abort() });
    expect(cancelled.terminationCause).toBe("user_stop"); expect(early.faux.state.callCount).toBe(0);
  });
  it("最后允许轮次自主提交仍为 completed；工具循环到上限明确记为 turn_limit", async () => {
    const natural = setupFaux([fauxAssistantMessage("完整答卷")], { mode: "without_tool", limits: { maxTurns: 1 } });
    expect(await runTrial({ agent: natural.agent, question, guard: natural.guard, recorder: natural.recorder })).toMatchObject({ executionStatus: "completed", terminationCause: "completed" });
    const loop = setupFaux([fauxAssistantMessage(fauxToolCall("slow", {})), fauxAssistantMessage("不能续答")], { mode: "with_tool", tools: [slow], limits: { maxTurns: 1 } });
    expect(await runTrial({ agent: loop.agent, question, guard: loop.guard, recorder: loop.recorder })).toMatchObject({ executionStatus: "limit_reached", terminationCause: "turn_limit" });
    expect(loop.faux.state.callCount).toBe(1);
  });
  it("接口错误不会因为恰好达到 maxTurns 被误记为轮数超限", async () => {
    const setup = setupFaux([fauxAssistantMessage([], { stopReason: "error", errorMessage: "offline connection error" })], { mode: "without_tool", limits: { maxTurns: 1 } });
    expect(await runTrial({ agent: setup.agent, question, guard: setup.guard, recorder: setup.recorder })).toMatchObject({ executionStatus: "outcome_unknown", terminationCause: "provider_error" });
  });
});

describe("隔离检查、策略身份和配置失败", () => {
  it("最终 payload 限制总输出及 thinking budget，保留 SDK 适配后的其他字段", () => {
    const payload = { model: "offline", max_tokens: 40000, thinking: { type: "enabled", budget_tokens: 32000 }, messages: [] };
    const bounded = capOutputPayload(payload, 8192) as typeof payload;
    expect(bounded.max_tokens).toBe(8192);
    expect(bounded.thinking.budget_tokens).toBeLessThan(bounded.max_tokens);
    expect(bounded.messages).toBe(payload.messages);
    expect(payload.max_tokens).toBe(40000);
    expect(capOutputPayload({ max_completion_tokens: 32000 }, 1000)).toMatchObject({ max_completion_tokens: 1000 });
    expect(capOutputPayload({ generationConfig: { maxOutputTokens: 32000 } }, 1000)).toMatchObject({ generationConfig: { maxOutputTokens: 1000 } });
    expect(() => capOutputPayload(payload, 512)).toThrow("输出上限不足");
  });
  it("真实消息构建拒绝评分字段，合法题目和模型自己的答案不会误触发", async () => {
    expect(() => buildUserContent({ ...question, reference: "private" } as never)).toThrow("Answer-isolation");
    const setup = setupFaux([fauxAssistantMessage("不能调用")], { mode: "without_tool" });
    const refused = await runTrial({ agent: setup.agent, question: { ...question, scoring: { reference: "private" } } as never, guard: setup.guard, recorder: setup.recorder });
    expect(refused).toMatchObject({ executionStatus: "unsupported_input", terminationCause: "input_rejected" }); expect(setup.faux.state.callCount).toBe(0);
    const legal = setupFaux([fauxAssistantMessage("答案：42")], { mode: "without_tool" });
    expect((await runTrial({ agent: legal.agent, question, guard: legal.guard, recorder: legal.recorder })).executionStatus).toBe("completed");
  });
  it("缺失、损坏及拼写错误的保护配置全部在发送前拒绝", async () => {
    const s = batchFixture();
    const path = join(s.root, "limits.json");
    await expect(runBatch({ ...s.params, limitsPath: path })).rejects.toThrow("不会回退");
    for (const text of ["{bad", JSON.stringify({ perTrail: { maxTurns: 1 } }), JSON.stringify({ request: "bad" })]) {
      writeFileSync(path, text);
      await expect(runBatch({ ...s.params, limitsPath: path })).rejects.toThrow("不会回退");
    }
    expect(s.faux.state.callCount).toBe(0);
  });
  it("新策略写入 manifest；旧策略只读可查看，但不允许按新策略续跑", async () => {
    const s = batchFixture();
    const result = await runBatch(s.params);
    const runId = result.byMode.without_tool!.runId;
    const manifest = readManifest(s.params.runsRoot, runId)!;
    expect(manifest.executionPolicyVersion).toBe(EXECUTION_POLICY_VERSION);
    const service = new TaskControlService();
    const detail = await service.getValidatedTaskDetail(s.params.runsRoot, runId, s.params.datasetDir, "demo", "without_tool");
    expect(detail.questions[0]!.terminationCause).toBe("completed");
    writeManifest(s.params.runsRoot, runId, { ...manifest, executionPolicyVersion: "previous-policy" });
    await expect(runBatch({ ...s.params, runId })).rejects.toThrow("策略已变化");
    await expect(service.prepareResume(s.params.runsRoot, runId, s.params.datasetDir, "demo")).rejects.toThrow("策略已变化");
    expect(s.faux.state.callCount).toBe(1);
    expect(service.getTaskDetail(s.params.runsRoot, runId).questions).toHaveLength(1);
  });
  it("停止原因经过实时服务视图，旧事件仍能读取", () => {
    const events: TaskEvent[] = [{ type: "task_started", runId: "r", mode: "without_tool", datasetId: "demo", provider: "p", modelId: "m", plannedQuestionIds: ["q1"] }, { type: "question_done", runId: "r", mode: "without_tool", questionId: "q1", executionStatus: "limit_reached", terminationCause: "context_limit", truncated: false }];
    expect(taskTelemetry(events)!.questions[0]).toMatchObject({ state: "limit_reached", terminationCause: "context_limit" });
  });
});
