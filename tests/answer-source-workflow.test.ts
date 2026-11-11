import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { runBatch, type BatchParams } from "../src/runner/batch.js";
import { readManifest, type RunManifest } from "../src/runner/answer-source.js";
import * as sources from "../src/runner/answer-source.js";
import * as archive from "../src/runner/archive.js";
import { TaskControlService } from "../src/service/task-service.js";
import { ReviewService } from "../src/service/review-service.js";
import { ExamTui } from "../src/tui/controller.js";

// 新建的验证材料保留在 .work，不删除，也不改正式题库和历史运行。
function setup(open = false) {
  const base = resolve(".work");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "source-verification-"));
  const dataset = join(root, "datasets", "demo");
  mkdirSync(join(dataset, "public"), { recursive: true });
  mkdirSync(join(dataset, "scoring"));
  writeFileSync(join(dataset, "public", "q1.md"), `---\nid: q1\nversion: "1"\nsubject: math\nanswer_kind: ${open ? "open" : "single_choice"}\n---\n\n2+2=?\n\n- A. 3\n- B. 4\n`);
  writeFileSync(join(dataset, "public", "q2.md"), '---\nid: q2\nversion: "1"\nsubject: physics\nanswer_kind: open\n---\n\nExplain.\n');
  writeFileSync(join(dataset, "scoring", "q1.json"), JSON.stringify({ questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: open ? "open" : "single_choice", maxScore: 1, reference: "B", deterministicLocked: !open }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("Answer: B")));
  const profile = ModelProfileSchema.parse({ id: "faux", displayName: "Faux", provider: "faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] }, models: [{ id: "faux-1", name: "Faux", input: ["text"], reasoning: false, contextWindow: 4096, maxTokens: 1024 }], capability: {} });
  const params: BatchParams = { datasetId: "demo", datasetDir: dataset, modes: ["without_tool"], profileId: "faux", modelId: "faux-1", limit: 1, runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: "v1", pythonInterpreter: "python", modelsConfigPath: "unused", registryOverride: { models, profilesById: new Map([["faux", profile]]) } };
  const task = new TaskControlService();
  const review = new ReviewService(params.runsRoot, dataset, "demo");
  const tui = new ExamTui({ datasetsRoot: join(root, "datasets"), modelsConfigPath: "unused", runsRoot: params.runsRoot, workRoot: params.workRoot, toolsVersion: "v1", pythonInterpreter: "python" });
  return { root, dataset, faux, params, task, review, tui };
}
async function answered(open = false) {
  const s = setup(open);
  const result = await runBatch(s.params);
  const runId = result.byMode.without_tool!.runId;
  const manifest = readManifest(s.params.runsRoot, runId)!;
  const location = manifest.sources[0]!;
  const trialDir = join(s.params.runsRoot, location.runId, "trials", location.trialId);
  const save = (m: RunManifest) => writeFileSync(join(s.params.runsRoot, runId, "manifest.json"), JSON.stringify(m));
  const rebuild = () => s.task.rebuildReport(s.params.runsRoot, runId, s.dataset, "demo", "without_tool");
  return { ...s, runId, manifest, location, trialDir, save, rebuild };
}
afterEach(() => vi.restoreAllMocks());

describe("任务来源、恢复、报告与复核的一致性", () => {
  it("A 作答，B 完全复用，再指定 B/C 续跑均不增加请求", async () => {
    const s = await answered();
    const b = await runBatch(s.params);
    const bid = b.byMode.without_tool!.runId;
    expect(bid).not.toBe(s.runId);
    expect(existsSync(join(s.params.runsRoot, bid, "trials"))).toBe(false);
    const c = await runBatch({ ...s.params, runId: bid });
    await runBatch({ ...s.params, runId: c.byMode.without_tool!.runId });
    expect(s.faux.state.callCount).toBe(1);
    expect(c.byMode.without_tool!.report.totals.confirmedRaw).toBe(1);
    expect(s.task.listTasks(s.params.runsRoot).some((t) => t.runId === bid)).toBe(true);
  });

  it("指定已有计划时不因 limit 增大而作答计划外题目", async () => {
    const s = await answered();
    const result = await runBatch({ ...s.params, runId: s.runId, limit: 100 });
    expect(result.byMode.without_tool!.report.perQuestion.map((r) => r.questionId)).toEqual(["q1"]);
    expect(result.plannedMax).toBe(1);
    expect(s.faux.state.callCount).toBe(1);
  });

  it("未知 run-id、配置不一致和 fresh/run-id 冲突均在发送前拒绝", async () => {
    const s = await answered();
    await expect(runBatch({ ...s.params, runId: "missing-run" })).rejects.toThrow("does not exist");
    await expect(runBatch({ ...s.params, runId: s.runId, requestTimeoutMs: 7 })).rejects.toThrow("configuration");
    await expect(runBatch({ ...s.params, runId: s.runId, fresh: true })).rejects.toThrow("cannot be combined");
    expect(s.faux.state.callCount).toBe(1);
  });

  it("来源尚未更新的 attempt-only 在报告和续跑中均保留未知，旧评分不计入", async () => {
    const s = await answered();
    renameSync(join(s.trialDir, "trial.json"), join(s.trialDir, "saved-trial.json"));
    s.manifest.sources = [];
    s.save(s.manifest);
    const report = await s.rebuild();
    expect(report.perQuestion[0]!.executionStatus).toBe("outcome_unknown");
    expect(report.totals.confirmedRaw).toBe(0);
    await runBatch({ ...s.params, runId: s.runId });
    expect(s.faux.state.callCount).toBe(1);
  });

  it("损坏的请求记录或清单不能被当作未执行", async () => {
    const s = await answered();
    renameSync(join(s.trialDir, "trial.json"), join(s.trialDir, "saved-trial.json"));
    writeFileSync(join(s.trialDir, "attempt.json"), "{");
    s.manifest.sources = [];
    s.save(s.manifest);
    await expect(s.rebuild()).rejects.toThrow();
    await expect(runBatch({ ...s.params, runId: s.runId })).rejects.toThrow();
    writeFileSync(join(s.params.runsRoot, s.runId, "manifest.json"), "{");
    await expect(runBatch({ ...s.params, runId: s.runId })).rejects.toThrow();
    expect(s.faux.state.callCount).toBe(1);
  });

  it.each(["provider", "modelId", "configDigest", "datasetVersion"] as const)("清单身份 %s 不匹配时报告不计分，复核不调用裁判", async (key) => {
    const s = await answered();
    s.manifest[key] = "different";
    s.save(s.manifest);
    expect((await s.rebuild()).totals.confirmedRaw).toBe(0);
    expect(await s.review.getQueue(s.runId, "without_tool")).toHaveLength(0);
    const grader = vi.fn(async () => '{"score":1}');
    expect((await s.review.modelPrelim(s.runId, s.location.trialId, grader)).grade).toBeUndefined();
    expect(grader).not.toHaveBeenCalled();
  });

  it("答卷题号与来源引用不一致时不能计分", async () => {
    const s = await answered();
    const path = join(s.trialDir, "trial.json");
    const trial = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...trial, questionId: "q2" }));
    expect((await s.rebuild()).totals.confirmedRaw).toBe(0);
  });

  it.each(["duplicate-plan", "unplanned-source", "path-escape"])("清单结构 %s 无效时拒绝恢复", async (kind) => {
    const s = await answered();
    if (kind === "duplicate-plan") s.manifest.plannedQuestionIds.push("q1");
    if (kind === "unplanned-source") s.manifest.sources[0]!.questionId = "q2";
    if (kind === "path-escape") s.manifest.sources[0]!.runId = "../outside";
    s.save(s.manifest);
    await expect(s.rebuild()).rejects.toThrow();
    await expect(runBatch({ ...s.params, runId: s.runId })).rejects.toThrow();
    expect(s.faux.state.callCount).toBe(1);
  });

  it("blocked 答卷不能进行人工确认或模型初评，也不写评分历史", async () => {
    const s = await answered();
    const before = readFileSync(join(s.trialDir, "grade.json"), "utf8");
    s.manifest.sources[0]!.status = "blocked";
    s.save(s.manifest);
    const grader = vi.fn(async () => '{"score":1}');
    await s.review.modelPrelim(s.runId, s.location.trialId, grader);
    await expect(s.review.submitHuman(s.runId, s.location.trialId, { score: 1, reason: "test", confirmer: "test" }, "without_tool")).rejects.toThrow();
    expect(grader).not.toHaveBeenCalled();
    expect(readFileSync(join(s.trialDir, "grade.json"), "utf8")).toBe(before);
    expect(existsSync(join(s.trialDir, "grade-history.jsonl"))).toBe(false);
  });

  it("内容变化时模型初评重新校验，不调用裁判", async () => {
    const s = await answered(true);
    expect(await s.review.getQueue(s.runId, "without_tool")).toHaveLength(1);
    writeFileSync(join(s.dataset, "public", "q1.md"), '---\nid: q1\nversion: "1"\nsubject: math\nanswer_kind: open\n---\n\nChanged question.\n');
    const grader = vi.fn(async () => '{"score":1}');
    await s.review.modelPrelim(s.runId, s.location.trialId, grader);
    expect(grader).not.toHaveBeenCalled();
    expect((await s.rebuild()).totals.confirmedRaw).toBe(0);
  });

  it("前序运行的待复核答卷能初评、人工确认并保存到原位置", async () => {
    const s = await answered(true);
    const b = await runBatch(s.params);
    const bid = b.byMode.without_tool!.runId;
    const queue = await s.review.getQueue(bid, "without_tool");
    expect(queue[0]!.sourceRunId).toBe(s.runId);
    await s.review.modelPrelim(bid, queue[0]!.trialId, async () => '{"score":0,"evidence":"offline judge"}');
    expect((await s.task.rebuildReport(s.params.runsRoot, bid, s.dataset, "demo", "without_tool")).totals.confirmedRaw).toBe(0);
    await s.review.submitHuman(bid, queue[0]!.trialId, { score: 1, reason: "checked", confirmer: "tester" }, "without_tool");
    expect(JSON.parse(readFileSync(join(s.trialDir, "grade.json"), "utf8")).reviewStatus).toBe("human_confirmed");
    expect((await s.task.rebuildReport(s.params.runsRoot, bid, s.dataset, "demo", "without_tool")).totals.confirmedRaw).toBe(1);
    expect(s.faux.state.callCount).toBe(1);
  });

  it("缺评分的完整答卷保持 completed/unscored", async () => {
    const s = setup();
    const result = await runBatch({ ...s.params, limit: 2 });
    const report = await s.task.rebuildReport(s.params.runsRoot, result.byMode.without_tool!.runId, s.dataset, "demo", "without_tool");
    expect(report.perQuestion.find((r) => r.questionId === "q2")).toMatchObject({ executionStatus: "completed", gradingStatus: "unscored" });
  });

  it("历史任务选择不受最新模式事件影响，报告和复核都打开指定任务", async () => {
    const s = await answered(true);
    const b = await runBatch(s.params);
    const bid = b.byMode.without_tool!.runId;
    s.tui.onEvent({ type: "mode_done", runId: s.runId, mode: "without_tool", confirmedRaw: 0, confirmedMax: 0, plannedMax: 1 });
    await s.tui.openReport(bid);
    expect(s.tui.getState().screen).toMatchObject({ kind: "report", runId: bid });
    await s.tui.openReview(bid);
    expect(s.tui.getState().screen).toMatchObject({ kind: "review", runId: bid });
  });

  it("重启服务后依照保存批次切换两种模式", async () => {
    const s = setup();
    const result = await runBatch({ ...s.params, modes: ["without_tool", "with_tool"] });
    const noTool = result.byMode.without_tool!.runId;
    const tool = result.byMode.with_tool!.runId;
    const restarted = new TaskControlService();
    expect(restarted.resolveRunMode(s.params.runsRoot, noTool, "with_tool").runId).toBe(tool);
    await s.tui.openReport(tool);
    expect(s.tui.getState().screen).toMatchObject({ kind: "report", runId: tool, mode: "with_tool" });
  });

  it("无关联模式时明确提示，不跳到另外一次测评", async () => {
    const s = await answered();
    await runBatch({ ...s.params, modes: ["with_tool"] });
    await s.tui.openReport(s.runId);
    await s.tui.openReport(s.runId, "with_tool");
    expect(s.tui.getState().screen).toMatchObject({ kind: "report", runId: s.runId, mode: "without_tool" });
    expect(s.tui.getState().message).toContain("关联");
  });

  it("计划写入失败时零请求", async () => {
    const s = setup();
    vi.spyOn(sources, "writeManifest").mockImplementation(() => { throw new Error("disk unavailable"); });
    await expect(runBatch(s.params)).rejects.toThrow("disk unavailable");
    expect(s.faux.state.callCount).toBe(0);
  });

  it("来源写入失败后停止安排新题，恢复保存的计划时不重答已执行题", async () => {
    const s = setup();
    const original = sources.writeManifest;
    let runId = "";
    const spy = vi.spyOn(sources, "writeManifest").mockImplementation((root, id, manifest) => {
      runId = id;
      if (manifest.sources.length > 0) throw new Error("source storage failed");
      original(root, id, manifest);
    });
    await expect(runBatch({ ...s.params, limit: 2 })).rejects.toThrow("source storage failed");
    expect(s.faux.state.callCount).toBe(1);
    spy.mockRestore();
    const recovered = await runBatch({ ...s.params, runId });
    expect(s.faux.state.callCount).toBe(2);
    const rebuilt = await s.task.rebuildReport(s.params.runsRoot, recovered.byMode.without_tool!.runId, s.dataset, "demo", "without_tool");
    expect(rebuilt.totals).toEqual(recovered.byMode.without_tool!.report.totals);
  });

  it("评分写入失败不计入总分，随后恢复评分不重新作答且重建一致", async () => {
    const s = setup();
    const spy = vi.spyOn(archive, "writeGradeFile").mockImplementation(() => { throw new Error("grade storage failed"); });
    const first = await runBatch(s.params);
    expect(first.byMode.without_tool!.report.totals.confirmedRaw).toBe(0);
    spy.mockRestore();
    const recovered = await runBatch({ ...s.params, runId: first.byMode.without_tool!.runId });
    expect(s.faux.state.callCount).toBe(1);
    expect(recovered.byMode.without_tool!.report.totals.confirmedRaw).toBe(1);
    const rebuilt = await s.task.rebuildReport(s.params.runsRoot, recovered.byMode.without_tool!.runId, s.dataset, "demo", "without_tool");
    expect(rebuilt.totals).toEqual(recovered.byMode.without_tool!.report.totals);
  });
});
