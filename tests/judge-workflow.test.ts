import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, type SimpleStreamOptions, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ModelProfileSchema, ProtectionLimitsSchema } from "../src/shared/contracts.js";
import { JudgeConfigSchema, readJudgeConfig, saveJudgeConfig } from "../src/grading/judge-config.js";
import { JudgeService } from "../src/service/judge-service.js";
import { ReviewService } from "../src/service/review-service.js";
import { TaskControlService } from "../src/service/task-service.js";
import { runBatch } from "../src/runner/batch.js";
import { readManifest } from "../src/runner/answer-source.js";
import { writeGradeFile } from "../src/runner/archive.js";
import { ExamTui } from "../src/tui/controller.js";
import { ExamApp } from "../src/tui/app.js";

const answer = "第一步正确。第二步缺少单位。";
const reply = (score = 3) => JSON.stringify({ score, items: [{ rubricIndex: 0, points: 3, evidence: "第一步正确", note: "第一项满足" }, { rubricIndex: 1, points: score - 3, evidence: "第二步缺少单位", note: "第二项需核查" }] });
async function fixture(options: { dataAttachment?: boolean } = {}) {
  mkdirSync(resolve(".work"), { recursive: true }); const root = mkdtempSync(resolve(".work", "judge-workflow-"));
  const datasetDir = join(root, "datasets", "demo"); mkdirSync(join(datasetDir, "public"), { recursive: true }); mkdirSync(join(datasetDir, "scoring"));
  const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: "#389acd" } }).png().toBuffer();
  writeFileSync(join(datasetDir, "public", "figure.png"), png);
  if (options.dataAttachment) writeFileSync(join(datasetDir, "public", "data.txt"), "公开测试数据");
  for (const id of ["q1", "q2"]) {
    const figure = id === "q2" ? '\n\n![原图](figure.png)' : "";
    const metadata = id === "q1" && options.dataAttachment ? '\nassets: [{ref: data.txt, mediaType: text/plain, role: data}]' : "";
    writeFileSync(join(datasetDir, "public", `${id}.md`), `---\nid: ${id}\nversion: "1"\nsubject: ${id === "q1" ? "math" : "physics"}\nanswer_kind: open${metadata}\n---\n完整共享条件。证明 $a+b=2$。${figure}\n`);
    writeFileSync(join(datasetDir, "scoring", `${id}.json`), JSON.stringify({ questionId: id, questionVersion: "1", scoringVersion: "1", answerKind: "open", maxScore: 5,
      reference: "PRIVATE-REFERENCE", rubric: [{ points: 3, evidence: "PRIVATE-RUBRIC-ONE" }, { points: 2, evidence: "PRIVATE-RUBRIC-TWO" }] }));
  }
  const model = (id: string) => ({ id, name: id, input: ["text", "image"], reasoning: false, contextWindow: 16384, maxTokens: 2048 });
  const answerProfile = ModelProfileSchema.parse({ id: "answer-profile", displayName: "离线作答", provider: "answer-hidden", api: "faux", baseUrl: "https://answer.invalid/v1", auth: { envVars: ["OFFLINE_ANSWER_KEY"] }, models: [model("candidate-hidden")], capability: { imageInput: "unverified" } });
  const judgeProfile = ModelProfileSchema.parse({ id: "judge-profile", displayName: "离线裁判", provider: "judge-test", api: "faux", baseUrl: "https://judge.invalid/v1", auth: { envVars: ["OFFLINE_JUDGE_KEY"] }, models: [model("judge-model")], capability: { imageInput: "unverified" } });
  const answering = fauxProvider({ provider: "answer-hidden", models: [{ ...model("candidate-hidden"), input: ["text", "image"] }] });
  const judging = fauxProvider({ provider: "judge-test", models: [{ ...model("judge-model"), input: ["text", "image"] }] });
  const models = createModels(); models.setProvider(answering.provider); models.setProvider(judging.provider);
  answering.setResponses([fauxAssistantMessage(answer), fauxAssistantMessage(answer)]);
  judging.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage(reply())));
  const registry = { models, profilesById: new Map([[answerProfile.id, answerProfile], [judgeProfile.id, judgeProfile]]) };
  const cfg = { datasetsRoot: join(root, "datasets"), modelsConfigPath: join(root, "models.json"), judgeConfigPath: join(root, "judge.json"), runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: "v1", pythonInterpreter: "python", registryOverride: registry, animation: false };
  writeFileSync(cfg.modelsConfigPath, JSON.stringify({ version: "1", profiles: [answerProfile, judgeProfile] }));
  const batch = await runBatch({ ...cfg, datasetId: "demo", datasetDir, modes: ["without_tool"], profileId: answerProfile.id, modelId: "candidate-hidden", limit: 2 });
  const runId = batch.byMode.without_tool!.runId;
  const review = new ReviewService(cfg.runsRoot, datasetDir, "demo"); const queue = await review.getQueue(runId, "without_tool");
  expect(queue).toHaveLength(2);
  const judge = new JudgeService(cfg.runsRoot), tasks = new TaskControlService(), tui = new ExamTui(cfg, tasks);
  const config = JudgeConfigSchema.parse({ version: 1, profileId: judgeProfile.id, modelId: "judge-model", thinkingLevel: "off", maxTotalTokens: 50000, limits: ProtectionLimitsSchema.parse({ maxOutputTokens: 1024, requestTimeoutMs: 500, totalRunTimeMs: 2000 }) });
  const plan = (ids = [queue[0]!.trialId], purpose: "preliminary" | "calibration" = "preliminary", configValue = config) => judge.prepare(runId, datasetDir, "demo", purpose, ids, configValue, registry);
  const gradePath = (index = 0) => join(cfg.runsRoot, queue[index]!.sourceRunId, "trials", queue[index]!.trialId, "grade.json");
  const attempts = (index = 0) => readdirSync(join(cfg.runsRoot, queue[index]!.sourceRunId, "trials", queue[index]!.trialId)).filter((name) => name.startsWith("judge-"));
  const human = async (index: number, score: number) => review.submitHuman(runId, queue[index]!.trialId, { score, confirmer: "HUMAN-ONLY", reason: "HUMAN-ONLY-REASON" }, "without_tool");
  return { root, cfg, datasetDir, png, registry, answering, judging, config, judge, review, tasks, tui, queue, runId, plan, gradePath, attempts, human };
}
afterEach(() => vi.restoreAllMocks());

describe("独立裁判与人工样本校准", () => {
  it("真实 Pi Agent 接收原图、完整细则和完整答卷；隐藏身份、无工具、无重试、初评不计分", async () => {
    const s = await fixture(); let context = ""; let sent: SimpleStreamOptions | undefined;
    s.judging.setResponses([(value, options) => { context = JSON.stringify(value); sent = options; return fauxAssistantMessage(reply()); }]);
    const p = await s.plan([s.queue[1]!.trialId]); const status = await s.judge.whenDone(s.judge.start(p, true));
    expect(status).toMatchObject({ state: "done", items: [{ state: "completed", score: 3 }] });
    expect(s.judging.state.callCount).toBe(1); expect(s.answering.state.callCount).toBe(2);
    for (const text of ["PRIVATE-RUBRIC-ONE", "PRIVATE-RUBRIC-TWO", "PRIVATE-REFERENCE", answer, s.png.toString("base64")]) expect(context).toContain(text);
    for (const hidden of ["candidate-hidden", "answer-hidden", "without_tool", "HUMAN-ONLY"]) expect(context).not.toContain(hidden);
    expect(context).not.toMatch(/toolsAdded":\[\{/); expect(sent?.maxRetries).toBe(0); expect(sent?.maxTokens).toBe(1024); expect(sent?.signal).toBeDefined();
    const grade = JSON.parse(readFileSync(s.gradePath(1), "utf8")); expect(grade).toMatchObject({ reviewStatus: "model_preliminary", rawScore: 3 }); expect(grade.items.map((item: { points: number }) => item.points)).toEqual([3, 0]);
    expect((await s.tasks.rebuildReport(s.cfg.runsRoot, s.runId, s.datasetDir, "demo", "without_tool")).totals.confirmedRaw).toBe(0);
    expect(s.attempts(1)).toHaveLength(1); expect(status?.budget?.knownTokens).toBeGreaterThan(0);
  });

  it("重复计划不复用授权；同材料同配置完成的初评离线复用，不再计费", async () => {
    const s = await fixture(); const p = await s.plan(); await s.judge.whenDone(s.judge.start(p, true));
    expect(() => s.judge.start(p, true)).toThrow("已使用");
    const repeat = await s.plan(); expect(repeat.items[0]!.disposition).toBe("reuse");
    await s.judge.whenDone(s.judge.start(repeat, true)); expect(s.judging.state.callCount).toBe(1);
    const denied = await s.plan(); expect(() => s.judge.start(denied, false)).toThrow("付费授权"); expect(s.judging.state.callCount).toBe(1);
  });

  it("断流不自动重发；历史 started 记录也阻止再次发送", async () => {
    const s = await fixture(); s.judging.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "离线断流" })]);
    const status = await s.judge.whenDone(s.judge.start(await s.plan(), true)); expect(status?.items[0]!.state).toBe("outcome_unknown");
    const repeat = await s.plan(); expect(repeat.items[0]!.disposition).toBe("blocked"); await s.judge.whenDone(s.judge.start(repeat, true));
    expect(s.judging.state.callCount).toBe(1);
    const path = join(s.cfg.runsRoot, s.queue[0]!.sourceRunId, "trials", s.queue[0]!.trialId, s.attempts()[0]!);
    const record = JSON.parse(readFileSync(path, "utf8")); writeFileSync(path, JSON.stringify({ ...record, status: "started" }));
    expect((await s.plan()).items[0]!.disposition).toBe("blocked");
  });

  it("错误分项、越界、伪造证据、无效 JSON 和截断均不覆盖原评分", async () => {
    const invalid = ["not json", '```json\n' + reply() + '\n```', reply(8), JSON.stringify({ score: 3, items: [{ rubricIndex: 0, points: 3, evidence: "第一步正确" }] }),
      reply().replace("第一步正确", "伪造引用"), reply().replace('"rubricIndex":1', '"rubricIndex":0'), reply().replace('"score":3', '"score":2')];
    for (const raw of invalid) {
      const s = await fixture(); const before = readFileSync(s.gradePath(), "utf8"); s.judging.setResponses([fauxAssistantMessage(raw)]);
      expect((await s.judge.whenDone(s.judge.start(await s.plan(), true)))?.items[0]!.state).toBe("invalid");
      expect(readFileSync(s.gradePath(), "utf8")).toBe(before);
    }
    const s = await fixture(); s.judging.setResponses([fauxAssistantMessage(reply(), { stopReason: "length" })]);
    expect((await s.judge.whenDone(s.judge.start(await s.plan(), true)))?.items[0]!.state).toBe("outcome_unknown");
  }, 20000);

  it("预算不足在请求前停止；不支持原图或确认成绩时拒绝初评", async () => {
    const s = await fixture(); const p = await s.plan(undefined, "preliminary", { ...s.config, maxTotalTokens: 1 });
    expect((await s.judge.whenDone(s.judge.start(p, true)))?.state).toBe("budget_paused"); expect(s.judging.state.callCount).toBe(0);
    await s.human(0, 4); await expect(s.plan()).rejects.toThrow("已确认");
    s.registry.profilesById.set("judge-profile", { ...s.registry.profilesById.get("judge-profile")!, capability: { ...s.registry.profilesById.get("judge-profile")!.capability, imageInput: "unsupported" } });
    await expect(s.plan([s.queue[1]!.trialId])).rejects.toThrow("原图");
  });

  it("初评期间人工评分优先；计划后端点或材料变化不发请求", async () => {
    const s = await fixture(); s.judging.setResponses([async () => { await s.human(0, 5); return fauxAssistantMessage(reply()); }]);
    expect((await s.judge.whenDone(s.judge.start(await s.plan(), true)))?.items[0]!.state).toBe("stale");
    expect(JSON.parse(readFileSync(s.gradePath(), "utf8"))).toMatchObject({ reviewStatus: "human_confirmed", rawScore: 5 });
    const p = await s.plan([s.queue[1]!.trialId]); s.registry.profilesById.set("judge-profile", { ...s.registry.profilesById.get("judge-profile")!, baseUrl: "https://changed.invalid/v1" });
    expect((await s.judge.whenDone(s.judge.start(p, true)))?.state).toBe("error"); expect(s.judging.state.callCount).toBe(1);
  });

  it("校准隐藏人工分数、保留原成绩，完整比较失败覆盖并人工保存样本范围", async () => {
    const s = await fixture(); await s.human(0, 4); await s.human(1, 3); const originals = [s.gradePath(0), s.gradePath(1)].map((path) => readFileSync(path, "utf8"));
    let input = ""; s.judging.setResponses([(ctx) => { input += JSON.stringify(ctx); return fauxAssistantMessage(reply()); }, (ctx) => { input += JSON.stringify(ctx); return fauxAssistantMessage(reply()); }]);
    const ids = s.queue.map((item) => item.trialId); await s.judge.whenDone(s.judge.start(await s.plan(ids, "calibration"), true));
    expect(input).not.toContain("HUMAN-ONLY"); const report = await s.judge.calibrationReport(s.runId, s.datasetDir, "demo", ids, s.config, s.registry);
    expect(report.summary).toEqual({ total: 2, compared: 2, meanAbsoluteError: 0.5, bias: -0.5, maxAbsoluteError: 1, exact: 1 });
    expect(report.bySubject.math?.compared).toBe(1); expect(report.bySubject.physics?.compared).toBe(1);
    const checked = await s.judge.confirmCalibration(s.runId, s.datasetDir, "demo", ids, s.config, s.registry, report.digest, "meiko", "仅确认这组样本，分差已逐题检查");
    expect(checked.status).toBe("human_reviewed_samples"); expect(checked.scope).toContain("仅限");
    expect([s.gradePath(0), s.gradePath(1)].map((path) => readFileSync(path, "utf8"))).toEqual(originals);
    await expect(s.judge.confirmCalibration(s.runId, s.datasetDir, "demo", ids, s.config, s.registry, report.digest, "meiko", "重复")).rejects.toThrow("不能覆盖");
    await s.human(0, 5); await expect(s.judge.confirmCalibration(s.runId, s.datasetDir, "demo", ids, s.config, s.registry, report.digest, "meiko", "旧材料")).rejects.toThrow("已变化");
    await expect(s.judge.calibrationReport(s.runId, s.datasetDir, "demo", [ids[0]!, ids[0]!], s.config, s.registry)).rejects.toThrow("不重复");
  });

  it("校准有失败时仍保留分母，不允许把部分结果确认成完整校准", async () => {
    const s = await fixture(); await s.human(0, 4); await s.human(1, 3);
    s.judging.setResponses([fauxAssistantMessage(reply()), fauxAssistantMessage("invalid")]);
    const ids = s.queue.map((item) => item.trialId); await s.judge.whenDone(s.judge.start(await s.plan(ids, "calibration"), true));
    const report = await s.judge.calibrationReport(s.runId, s.datasetDir, "demo", ids, s.config, s.registry);
    expect(report.summary).toMatchObject({ total: 2, compared: 1 }); expect(report.rows[1]?.state).toBe("invalid");
    await expect(s.judge.confirmCalibration(s.runId, s.datasetDir, "demo", ids, s.config, s.registry, report.digest, "meiko", "不完整")).rejects.toThrow("未完成");
  });

  it("TUI 独立配置、初评确认、返回草稿和 80×24 按钮可用", async () => {
    const s = await fixture(); s.tui.openJudge();
    s.tui.judgePicker(); const screen = s.tui.getState().screen; if (screen.kind !== "judge") throw new Error("wrong screen");
    const providerIndex = screen.groups.findIndex((group) => group.models.some((model) => model.modelId === "judge-model"));
    s.tui.chooseJudge(providerIndex); s.tui.chooseJudge(0); s.tui.setJudgeField("budget", "50000"); s.tui.setJudgeField("output", "1024"); s.tui.saveJudge();
    expect(readJudgeConfig(s.cfg.judgeConfigPath)?.profileId).toBe("judge-profile"); expect(s.judging.state.callCount).toBe(0);
    await s.tui.openReview(s.runId); s.tui.setReviewField("score", "2"); s.tui.setReviewField("confirmer", "草稿确认人"); s.tui.setReviewField("reason", "草稿理由"); await s.tui.prepareJudge();
    const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows"), app = new ExamApp(s.tui);
    try {
      Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
      const rendered = app.render(80); expect(rendered).toHaveLength(24); expect(rendered.every((line) => visibleWidth(line) <= 80)).toBe(true);
      expect(stripTerminalSequences(rendered.join("\n"))).toContain("明确开始裁判（新请求可能计费）");
      app.handleInput("\x1b"); expect(s.tui.getState().screen).toMatchObject({ kind: "review", confirmer: "草稿确认人", reason: "草稿理由" });
      await s.tui.prepareJudge(); const id = s.tui.startJudge(); await s.tui.getJudgeService().whenDone(id); await s.tui.finishJudge();
      expect(s.tui.getState().screen).toMatchObject({ kind: "review", score: 2, confirmer: "草稿确认人", reason: "草稿理由" });
      expect(s.judging.state.callCount).toBe(1);
    } finally { app.dispose(); if (rows) Object.defineProperty(process.stdout, "rows", rows); else Reflect.deleteProperty(process.stdout, "rows"); }
  });

  it("裁判停止会结束流并等待存档；第二任务受同一执行锁阻止", async () => {
    const s = await fixture(); let entered = false;
    s.judging.setResponses([async (_context, options) => { entered = true; await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("offline abort")), { once: true })); return fauxAssistantMessage(reply()); }]);
    const p = await s.plan(); const id = s.judge.start(p, true); await vi.waitFor(() => expect(entered).toBe(true));
    const other = new JudgeService(s.cfg.runsRoot); const second = other.start(await other.prepare(s.runId, s.datasetDir, "demo", "preliminary", [s.queue[1]!.trialId], s.config, s.registry), true);
    expect((await other.whenDone(second))?.state).toBe("error");
    await s.judge.stopAndWait(); expect((await s.judge.whenDone(id))?.state).toBe("stopped"); expect(s.judging.state.callCount).toBe(1);
    expect((await s.plan()).items[0]?.disposition).toBe("blocked");
  });

  it("调整整批预算仍复用已完成初评；损坏结果拒绝复用与重新计费", async () => {
    const s = await fixture(); await s.judge.whenDone(s.judge.start(await s.plan(), true));
    const larger = await s.plan(undefined, "preliminary", { ...s.config, maxTotalTokens: 100000 });
    expect(larger.items[0]?.disposition).toBe("reuse"); await s.judge.whenDone(s.judge.start(larger, true)); expect(s.judging.state.callCount).toBe(1);
    const path = join(s.cfg.runsRoot, s.queue[0]!.sourceRunId, "trials", s.queue[0]!.trialId, s.attempts()[0]!);
    const record = JSON.parse(readFileSync(path, "utf8")); writeFileSync(path, JSON.stringify({ ...record, grade: { ...record.grade, rawScore: 99 } }));
    await expect(s.plan()).rejects.toThrow(); expect(s.judging.state.callCount).toBe(1);
  });

  it("上下文预检和不可信配置在请求前失败，不改正式答卷", async () => {
    const s = await fixture(); const model = s.registry.models.getModel("judge-test", "judge-model")!; model.contextWindow = 64;
    const job = await s.judge.whenDone(s.judge.start(await s.plan(), true)); expect(job?.items[0]).toMatchObject({ state: "not_sent" });
    expect(job?.items[0]?.response).toBeUndefined(); expect(job?.items[0]?.error).toContain("上下文容量");
    expect(s.judging.state.callCount).toBe(0); expect(s.answering.state.callCount).toBe(2);
    expect(() => JudgeConfigSchema.parse({ ...s.config, apiKey: "offline-placeholder" })).toThrow();
    expect(() => JudgeConfigSchema.parse({ ...s.config, limits: { ...s.config.limits, totalRunTimeMs: 3000000000 } })).toThrow();
  });

  it("裁判总时间与流空闲看门狗均能终止挂起，未知结果不补发", async () => {
    for (const limits of [{ requestTimeoutMs: 30, totalRunTimeMs: 1000 }, { requestTimeoutMs: 1000, totalRunTimeMs: 30 }]) {
      const s = await fixture(); s.judging.setResponses([async (_context, options) => {
        await new Promise((_, reject) => { if (options?.signal?.aborted) reject(new Error("offline abort")); else options?.signal?.addEventListener("abort", () => reject(new Error("offline abort")), { once: true }); }); return fauxAssistantMessage(reply());
      }]);
      const config = { ...s.config, limits: { ...s.config.limits, ...limits } };
      const status = await s.judge.whenDone(s.judge.start(await s.plan(undefined, "preliminary", config), true));
      expect(status?.items[0]?.state).toBe("outcome_unknown"); expect(s.judging.state.callCount).toBe(1);
      expect((await s.plan(undefined, "preliminary", config)).items[0]?.disposition).toBe("blocked");
    }
  });

  it("usage 缺失会暂停其余校准样本，保留未知预留与完整分母", async () => {
    const s = await fixture(); await s.human(0, 4); await s.human(1, 3);
    const original = s.registry.models.streamSimple.bind(s.registry.models);
    vi.spyOn(s.registry.models, "streamSimple").mockImplementation((...args) => {
      const source = original(...args);
      return { [Symbol.asyncIterator]: async function* () { for await (const event of source) {
        if (event.type === "done") event.message.usage = { ...event.message.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
        yield event;
      } }, result: () => source.result() } as AssistantMessageEventStream;
    });
    const ids = s.queue.map((item) => item.trialId); const job = await s.judge.whenDone(s.judge.start(await s.plan(ids, "calibration"), true));
    expect(job).toMatchObject({ state: "budget_paused", budget: { unknownRequests: 1, knownTokens: 0 } });
    expect(s.judging.state.callCount).toBe(1);
    expect((await s.judge.calibrationReport(s.runId, s.datasetDir, "demo", ids, s.config, s.registry)).summary).toMatchObject({ total: 2, compared: 1 });
  });

  it("TUI 校准选择、取消和保存摘要；重启后离线读取人工检查，没有新请求", async () => {
    const s = await fixture(); saveJudgeConfig(s.cfg.judgeConfigPath, s.config); await s.human(0, 4); await s.human(1, 3);
    await s.tui.openCalibration(s.runId); s.tui.selectCalibration(0, true); s.tui.selectCalibration(1, true);
    await s.tui.prepareJudge(); const id = s.tui.startJudge(); await s.tui.getJudgeService().whenDone(id); await s.tui.finishJudge();
    s.tui.setCalibrationField("by", "meiko"); s.tui.setCalibrationField("reason", "逐题检查，仅限这两题"); await s.tui.confirmCalibration();
    expect(s.tui.getState().screen).toMatchObject({ kind: "calibration", confirming: true });
    const app = new ExamApp(s.tui); const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    try {
      Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
      expect(stripTerminalSequences(app.render(80).join("\n"))).toContain("明确保存这组样本检查");
      app.handleInput("\x1b"); expect(s.tui.getState().screen).toMatchObject({ confirming: false, reason: "逐题检查，仅限这两题" });
      await s.tui.confirmCalibration(); await s.tui.confirmCalibration();
    } finally { app.dispose(); if (rows) Object.defineProperty(process.stdout, "rows", rows); else Reflect.deleteProperty(process.stdout, "rows"); }
    const fresh = new ExamTui(s.cfg); await fresh.openCalibration(s.runId); fresh.selectCalibration(0, true); fresh.selectCalibration(1, true); await fresh.loadCalibrationReport();
    expect(fresh.getState().screen).toMatchObject({ kind: "calibration", report: { review: { by: "meiko" }, summary: { compared: 2 } } });
    expect(s.judging.state.callCount).toBe(2);
  });

  it("Ctrl+C 退出先停止裁判并存档，再恢复终端，不留后台请求", async () => {
    const s = await fixture(); saveJudgeConfig(s.cfg.judgeConfigPath, s.config); let entered = false;
    s.judging.setResponses([async (_context, options) => { entered = true; await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("offline abort")), { once: true })); return fauxAssistantMessage(reply()); }]);
    await s.tui.openReview(s.runId); await s.tui.prepareJudge(); const id = s.tui.startJudge(); await vi.waitFor(() => expect(entered).toBe(true));
    const app = new ExamApp(s.tui); let closed = false;
    app.setQuitHandler(() => { expect(s.tui.getJudgeService().getStatus(id)?.state).toBe("stopped"); closed = true; });
    try { app.handleInput("\x03"); await vi.waitFor(() => expect(closed).toBe(true)); expect(s.judging.state.callCount).toBe(1); }
    finally { app.dispose(); await s.tui.stopAndWait(); }
  });

  it("初评期间当前题退出待复核队列时，不把评分草稿带到下一题", async () => {
    const s = await fixture(); saveJudgeConfig(s.cfg.judgeConfigPath, s.config);
    await s.tui.openReview(s.runId); s.tui.setReviewField("score", "2"); s.tui.setReviewField("confirmer", "meiko"); s.tui.setReviewField("reason", "仅属于第一题的理由");
    s.judging.setResponses([async () => { await s.human(0, 5); return fauxAssistantMessage(reply()); }]);
    await s.tui.prepareJudge(); const id = s.tui.startJudge(); await s.tui.getJudgeService().whenDone(id); await s.tui.finishJudge();
    const screen = s.tui.getState().screen; if (screen.kind !== "review") throw new Error("wrong screen");
    expect(screen.items[screen.index]?.trialId).toBe(s.queue[1]!.trialId);
    expect(screen).toMatchObject({ score: null, confirmer: "meiko", reason: "", confirming: false });
    expect(s.tui.getState().message).toContain("未带入");
    expect(JSON.parse(readFileSync(s.gradePath(), "utf8"))).toMatchObject({ reviewStatus: "human_confirmed", rawScore: 5 });
    expect(JSON.parse(readFileSync(s.gradePath(1), "utf8"))).toMatchObject({ reviewStatus: "pending_human_review" });
  });

  it("无效格式和截断响应保留原文及停止原因，重启读取不请求模型", async () => {
    for (const stopReason of ["stop", "length"] as const) {
      const s = await fixture(); await s.human(1, 4);
      const raw = stopReason === "stop" ? '```json\n{"score":3}\n```' : '{"score":3,"items":[';
      s.judging.setResponses([fauxAssistantMessage(raw, { stopReason })]);
      const job = await s.judge.whenDone(s.judge.start(await s.plan([s.queue[1]!.trialId], "calibration"), true));
      expect(job?.items[0]).toMatchObject({ state: stopReason === "stop" ? "invalid" : "outcome_unknown", response: { text: raw, stopReason, containsToolCalls: false } });
      const record = JSON.parse(readFileSync(join(s.cfg.runsRoot, s.queue[1]!.sourceRunId, "trials", s.queue[1]!.trialId, s.attempts(1)[0]!), "utf8"));
      expect(record.response).toEqual({ text: raw, stopReason, containsToolCalls: false });
      const fresh = new JudgeService(s.cfg.runsRoot);
      const sample = await fresh.calibrationSample(s.runId, s.datasetDir, "demo", s.queue[1]!.trialId, s.config, s.registry);
      expect(sample).toMatchObject({ judgeResponse: { text: raw, stopReason }, humanGrade: { rawScore: 4 } });
      expect(sample.judgeGrade).toBeUndefined();
      const repeat = await fresh.prepare(s.runId, s.datasetDir, "demo", "calibration", [s.queue[1]!.trialId], s.config, s.registry);
      expect(repeat.items[0]?.disposition).toBe("blocked"); await fresh.whenDone(fresh.start(repeat, true));
      expect(s.judging.state.callCount).toBe(1);
    }
  });

  it("初评期间最后一题已人工确认时，空队列也不保留旧分数", async () => {
    const s = await fixture(); saveJudgeConfig(s.cfg.judgeConfigPath, s.config); await s.human(1, 3);
    await s.tui.openReview(s.runId); s.tui.setReviewField("score", "2"); s.tui.setReviewField("confirmer", "meiko"); s.tui.setReviewField("reason", "原题草稿");
    s.judging.setResponses([async () => { await s.human(0, 5); return fauxAssistantMessage(reply()); }]);
    await s.tui.prepareJudge(); const id = s.tui.startJudge(); await s.tui.getJudgeService().whenDone(id); await s.tui.finishJudge();
    expect(s.tui.getState().screen).toMatchObject({ kind: "review", items: [], index: 0, score: null, reason: "", confirmer: "meiko" });
    expect(s.judging.state.callCount).toBe(1);
  });

  it("裁判擅自调用工具时保留返回文本和工具标记，不执行工具或继续请求", async () => {
    const s = await fixture(); const before = readFileSync(s.gradePath(), "utf8");
    s.judging.setResponses([fauxAssistantMessage([fauxText("这是工具调用前的文本"), fauxToolCall("run_python", { code: "print(123)" })], { stopReason: "toolUse" })]);
    const job = await s.judge.whenDone(s.judge.start(await s.plan(), true));
    expect(job?.items[0]).toMatchObject({ state: "outcome_unknown", response: { text: "这是工具调用前的文本", stopReason: "toolUse", containsToolCalls: true } });
    expect(readFileSync(s.gradePath(), "utf8")).toBe(before); expect(s.judging.state.callCount).toBe(1);
    expect((await s.plan()).items[0]?.disposition).toBe("blocked");
  });

  it("TUI 可以完整滚动失败响应，并过滤其中的终端控制序列", async () => {
    const s = await fixture(); saveJudgeConfig(s.cfg.judgeConfigPath, s.config); await s.human(1, 4);
    const raw = "\x1b[2J错误格式\n" + Array.from({ length: 35 }, (_, i) => `原始返回第${i}行`).join("\n") + "\n末行核对完成";
    s.judging.setResponses([fauxAssistantMessage(raw)]);
    await s.tui.openCalibration(s.runId); s.tui.selectCalibration(1, true); await s.tui.prepareJudge(); const id = s.tui.startJudge(); await s.tui.getJudgeService().whenDone(id);
    const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows"), app = new ExamApp(s.tui);
    try {
      Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
      const readAll = () => {
        const pages: string[] = [];
        for (let i = 0; i < 100; i++) {
          const rendered = app.render(80); expect(rendered).toHaveLength(24); expect(rendered.every((line) => visibleWidth(line) <= 80)).toBe(true);
          expect(rendered.join("\n")).not.toContain("\x1b[2J"); pages.push(stripTerminalSequences(rendered.join("\n"))); app.handleInput("\x1b[B");
        }
        return pages.join("\n");
      };
      expect(readAll()).toContain("末行核对完成");
      await s.tui.finishJudge(); await s.tui.openCalibrationSample(); app.handleInput("4");
      const text = readAll(); expect(text).toContain("裁判返回文本 · 停止原因 stop"); expect(text).toContain("末行核对完成");
      app.handleInput("\x1b"); expect(s.tui.getState().screen).toMatchObject({ kind: "calibration", selected: [s.queue[1]!.trialId] });
      expect(s.judging.state.callCount).toBe(1);
    } finally { app.dispose(); if (rows) Object.defineProperty(process.stdout, "rows", rows); else Reflect.deleteProperty(process.stdout, "rows"); }
  });

  it("旧裁判记录没有返回文本时仍可复用，不补造原文或重新计费", async () => {
    const s = await fixture(); const id = s.judge.start(await s.plan(), true); await s.judge.whenDone(id);
    const path = join(s.cfg.runsRoot, s.queue[0]!.sourceRunId, "trials", s.queue[0]!.trialId, s.attempts()[0]!);
    const { response: _response, ...legacy } = JSON.parse(readFileSync(path, "utf8")); writeFileSync(path, JSON.stringify(legacy));
    const fresh = new JudgeService(s.cfg.runsRoot), plan = await fresh.prepare(s.runId, s.datasetDir, "demo", "preliminary", [s.queue[0]!.trialId], s.config, s.registry);
    expect(plan.items[0]?.disposition).toBe("reuse"); const reused = await fresh.whenDone(fresh.start(plan, true));
    expect(reused?.items[0]).toMatchObject({ state: "reused", score: 3 }); expect(reused?.items[0]?.response).toBeUndefined();
    expect(s.judging.state.callCount).toBe(1);
  });

  it("校准分别显示人工确认与裁判可请求状态，原图阻止原因与发送前一致", async () => {
    const s = await fixture(); await s.human(1, 3);
    const before = await s.judge.calibrationCandidates(s.runId, s.datasetDir, "demo");
    expect(before[1]).toMatchObject({ humanConfirmed: true, eligible: true, requestReady: false });
    expect(before[1]?.requestBlockReason).toContain("/judge");
    s.registry.models.getModel("judge-test", "judge-model")!.input = ["text"];
    const ready = await s.judge.calibrationCandidates(s.runId, s.datasetDir, "demo", { config: s.config, registry: s.registry });
    expect(ready[1]).toMatchObject({ humanConfirmed: true, eligible: false, requestReady: false });
    expect(ready[1]?.blockedReason).toContain("原图"); await expect(s.plan([s.queue[1]!.trialId], "calibration")).rejects.toThrow(ready[1]!.blockedReason);
    expect(s.judging.state.callCount).toBe(0);
  });

  it("非图片附件的人工样本不显示为可请求，也不发送裁判请求", async () => {
    const s = await fixture({ dataAttachment: true }); await s.human(0, 3);
    const candidates = await s.judge.calibrationCandidates(s.runId, s.datasetDir, "demo", { config: s.config, registry: s.registry });
    expect(candidates[0]).toMatchObject({ humanConfirmed: true, eligible: false, requestReady: false });
    expect(candidates[0]?.blockedReason).toContain("非图片附件"); await expect(s.plan([s.queue[0]!.trialId], "calibration")).rejects.toThrow("非图片附件");
    expect(s.judging.state.callCount).toBe(0);
  });

  it("规则已判分答卷显式人工核对，初始不预填分数，保存历史并保留其他样本及列表草稿", async () => {
    const s = await fixture(); saveJudgeConfig(s.cfg.judgeConfigPath, s.config); await s.human(0, 4);
    const old = JSON.parse(readFileSync(s.gradePath(1), "utf8"));
    const rule = { ...old, gradeId: `${old.gradeId}__rule-test`, reviewStatus: "rule_graded", rawScore: 3, items: [{ points: 3, evidence: "第一步正确", note: "测试规则评分" }] };
    writeGradeFile(s.cfg.runsRoot, s.queue[1]!.sourceRunId, s.queue[1]!.trialId, rule);
    expect((await s.review.getQueue(s.runId, "without_tool")).map((item) => item.trialId)).not.toContain(s.queue[1]!.trialId);
    await s.tui.openCalibration(s.runId); s.tui.selectCalibration(0, true); s.tui.selectCalibration(1); s.tui.setCalibrationField("by", "meiko"); s.tui.setCalibrationField("reason", "仅用于所选人工样本");
    await s.tui.openCalibrationReview(); expect(s.tui.getState().screen).toMatchObject({ kind: "review", score: null, items: [{ trialId: s.queue[1]!.trialId, currentGrade: { reviewStatus: "rule_graded", rawScore: 3 } }] });
    s.tui.setReviewField("score", "2"); s.tui.setReviewField("reason", "逐题人工核查后给分"); s.tui.prepareReview(); await s.tui.submitReview();
    expect(s.tui.getState().screen).toMatchObject({ kind: "calibration", selected: [s.queue[0]!.trialId], by: "meiko", reason: "仅用于所选人工样本", report: undefined, candidates: [{ humanConfirmed: true }, { humanConfirmed: true, requestReady: true }] });
    expect(JSON.parse(readFileSync(s.gradePath(1), "utf8"))).toMatchObject({ reviewStatus: "human_confirmed", rawScore: 2 });
    expect(readFileSync(join(s.cfg.runsRoot, s.queue[1]!.sourceRunId, "trials", s.queue[1]!.trialId, "grade-history.jsonl"), "utf8")).toContain(rule.gradeId);
    expect(s.judging.state.callCount).toBe(0);
  });

  it("裁判配置错误仍可人工核对；原图、取消摘要及返回保留列表草稿，禁止 j 和 m", async () => {
    const s = await fixture(); writeFileSync(s.cfg.judgeConfigPath, "invalid config");
    const old = JSON.parse(readFileSync(s.gradePath(1), "utf8")); writeGradeFile(s.cfg.runsRoot, s.queue[1]!.sourceRunId, s.queue[1]!.trialId, { ...old, reviewStatus: "rule_graded" });
    await s.tui.openCalibration(s.runId); s.tui.selectCalibration(1); s.tui.setCalibrationField("by", "meiko"); s.tui.setCalibrationField("reason", "保留列表依据");
    expect(s.tui.getState().screen).toMatchObject({ judgeIssue: expect.stringContaining("裁判配置不可用") });
    const app = new ExamApp(s.tui); const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    try {
      Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
      const rendered = app.render(80); expect(rendered.every((line) => visibleWidth(line) <= 80)).toBe(true);
      expect(stripTerminalSequences(rendered.join("\n"))).toContain("人工核对当前答卷");
      app.handleInput("r"); await vi.waitFor(() => expect(s.tui.getState().screen.kind).toBe("review"));
      s.tui.setReviewField("score", "2"); s.tui.setReviewField("reason", "当前题的人工理由");
      await expect(s.tui.prepareJudge()).rejects.toThrow("先完成人工核对");
      app.handleInput("m"); expect(s.tui.getState().screen).toMatchObject({ kind: "review", mode: "without_tool" });
      await s.tui.openReviewImage(); app.handleInput("\x1b"); expect(s.tui.getState().screen).toMatchObject({ kind: "review", score: 2, reason: "当前题的人工理由" });
      s.tui.prepareReview(); app.handleInput("\x1b"); expect(s.tui.getState().screen).toMatchObject({ kind: "review", confirming: false });
      app.handleInput("\x1b"); expect(s.tui.getState().screen).toMatchObject({ kind: "calibration", index: 1, by: "meiko", reason: "保留列表依据" });
      expect(JSON.parse(readFileSync(s.gradePath(1), "utf8"))).toMatchObject({ reviewStatus: "rule_graded" }); expect(s.judging.state.callCount).toBe(0);
    } finally { app.dispose(); if (rows) Object.defineProperty(process.stdout, "rows", rows); else Reflect.deleteProperty(process.stdout, "rows"); }
  });

  it("人工核对保存前材料或成绩变化时拒绝旧决定，不覆盖已确认分数", async () => {
    const s = await fixture(); await s.tui.openCalibration(s.runId); await s.tui.openCalibrationReview();
    s.tui.setReviewField("score", "2"); s.tui.setReviewField("confirmer", "meiko"); s.tui.setReviewField("reason", "旧材料决定"); s.tui.prepareReview();
    await s.human(0, 5); await expect(s.tui.submitReview()).rejects.toThrow("已变化");
    expect(JSON.parse(readFileSync(s.gradePath(), "utf8"))).toMatchObject({ reviewStatus: "human_confirmed", rawScore: 5 }); expect(s.judging.state.callCount).toBe(0);
  });

  it("人工核对已保存而候选刷新失败时，明确报告成功写入并退出旧确认页", async () => {
    const s = await fixture(); await s.tui.openCalibration(s.runId); await s.tui.openCalibrationReview();
    s.tui.setReviewField("score", "2"); s.tui.setReviewField("confirmer", "meiko"); s.tui.setReviewField("reason", "完整人工核对"); s.tui.prepareReview();
    vi.spyOn(s.tui.getJudgeService(), "calibrationCandidates").mockRejectedValueOnce(new Error("测试读取失败"));
    await expect(s.tui.submitReview()).rejects.toThrow("人工评分已保存，但校准列表刷新失败");
    expect(s.tui.getState().screen).toMatchObject({ kind: "calibration", confirming: false, report: undefined });
    const saved = readFileSync(s.gradePath(), "utf8"); await s.tui.submitReview(); expect(readFileSync(s.gradePath(), "utf8")).toBe(saved);
    expect(JSON.parse(saved)).toMatchObject({ reviewStatus: "human_confirmed", rawScore: 2 }); expect(s.judging.state.callCount).toBe(0);
  });

  it("没有裁判配置时仍可阅读已人工确认的完整材料和非图片附件引用", async () => {
    const s = await fixture({ dataAttachment: true }); await s.human(0, 3);
    await s.tui.openCalibration(s.runId); await s.tui.openCalibrationSample();
    const screen = s.tui.getState().screen; if (screen.kind !== "calibrationSample") throw new Error("wrong screen");
    expect(screen.sample).toMatchObject({ answer, humanGrade: { rawScore: 3 }, judgeState: "unconfigured", question: { assets: [{ ref: "data.txt" }] } });
    const app = new ExamApp(s.tui);
    try { app.handleInput("1"); expect(stripTerminalSequences(app.render(100).join("\n"))).toContain("公开附件 data.txt"); }
    finally { app.dispose(); }
    expect(s.judging.state.callCount).toBe(0);
  });

  it("坏裁判配置不阻止已人工确认的样本阅读和原图核对，也不伪造模型成绩", async () => {
    const s = await fixture(); await s.human(1, 4); writeFileSync(s.cfg.judgeConfigPath, "invalid config");
    await s.tui.openCalibration(s.runId); s.tui.selectCalibration(1); await s.tui.openCalibrationSample();
    expect(s.tui.getState().screen).toMatchObject({ kind: "calibrationSample", sample: { judgeState: "unavailable", judgeError: expect.stringContaining("裁判配置不可用"), judgeGrade: undefined } });
    await s.tui.openCalibrationImage(); expect(s.tui.getState().screen).toMatchObject({ image: { width: 8, height: 6 } });
    expect(s.judging.state.callCount).toBe(0);
  });

  it("校准可核对完整题面、答卷、细则和分项证据；原图返回保留草稿，变化拒绝读取", async () => {
    const s = await fixture(); saveJudgeConfig(s.cfg.judgeConfigPath, s.config); await s.human(1, 3);
    await s.judge.whenDone(s.judge.start(await s.plan([s.queue[1]!.trialId], "calibration"), true));
    await s.tui.openCalibration(s.runId); s.tui.selectCalibration(1, true); s.tui.setCalibrationField("by", "meiko"); s.tui.setCalibrationField("reason", "完整材料核对中");
    await s.tui.openCalibrationSample();
    const screen = s.tui.getState().screen; if (screen.kind !== "calibrationSample") throw new Error("wrong screen");
    expect(screen.sample).toMatchObject({ answer, humanGrade: { rawScore: 3 }, judgeGrade: { items: [{ points: 3, evidence: "第一步正确" }, { points: 0 }] } });
    expect(screen.sample.scoring.reference).toBe("PRIVATE-REFERENCE"); expect(screen.sample.question.stem).toContain("完整共享条件");
    const app = new ExamApp(s.tui); const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    try {
      Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
      const rendered = app.render(80); expect(rendered.every((line) => visibleWidth(line) <= 80)).toBe(true);
      expect(stripTerminalSequences(rendered.join("\n"))).toContain("返回校准列表，保留草稿");
      app.handleInput("2"); expect(s.tui.getState().screen).toMatchObject({ tab: "answer" });
      expect(stripTerminalSequences(app.render(80).join("\n"))).toContain(answer);
      await s.tui.openCalibrationImage(); expect(s.tui.getState().screen).toMatchObject({ image: { width: 8, height: 6 } });
      app.handleInput("\x1b"); expect(s.tui.getState().screen).toMatchObject({ kind: "calibrationSample", tab: "answer", image: undefined });
      app.handleInput("\x1b"); expect(s.tui.getState().screen).toMatchObject({ kind: "calibration", by: "meiko", reason: "完整材料核对中", selected: [s.queue[1]!.trialId] });
      await s.tui.openCalibrationSample(); await s.human(1, 4);
      await expect(s.tui.openCalibrationImage()).rejects.toThrow("已变化");
      expect(s.judging.state.callCount).toBe(1);
    } finally { app.dispose(); if (rows) Object.defineProperty(process.stdout, "rows", rows); else Reflect.deleteProperty(process.stdout, "rows"); }
  });
});
