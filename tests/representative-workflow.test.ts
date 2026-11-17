import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { ImportService } from "../src/import/import-service.js";
import { runBatch } from "../src/runner/batch.js";
import { EXAM_TOOLS_VERSION } from "../src/tools/index.js";
import { writeGradeFile } from "../src/runner/archive.js";
import { ReviewService } from "../src/service/review-service.js";
import { TaskControlService } from "../src/service/task-service.js";
import { ExamTui } from "../src/tui/controller.js";
import { ExamApp } from "../src/tui/app.js";
import type { GraderRequest } from "../src/grading/model-grader.js";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { Agent } from "@earendil-works/pi-agent-core";

// 测试材料与 faux 响应仅用于验证程序行为；本地 calculate 工具实际求值，不冒充模型能力。
async function fixture(executeTool = false) {
  mkdirSync(resolve(".work"), { recursive: true });
  const root = mkdtempSync(resolve(".work", "representative-workflow-"));
  const source = join(root, "source"); mkdirSync(source);
  await sharp({ create: { width: 80, height: 40, channels: 3, background: "#225e93" } }).png().toFile(join(source, "figure.png"));
  await sharp({ create: { width: 40, height: 80, channels: 3, background: "#e36a37" } }).jpeg().toFile(join(source, "second.jpg"));
  const basis = (reference: string | Record<string, string>, maxScore = 2) => ({ scoringVersion: "1", maxScore, reference });
  const options = { A: "选项甲", B: "选项乙", C: "选项丙" };
  const samples = [
    { id: "single", subject: "math", answer_kind: "single_choice", options, scoring: { ...basis("A"), deterministicLocked: true } },
    { id: "multi", subject: "biology", answer_kind: "multi_choice", options, scoring: basis("AC") },
    { id: "numeric", subject: "physics", answer_kind: "numeric_unit", scoring: { ...basis("6", 3), units: ["N"], tolerance: 0.01, deterministicLocked: true } },
    { id: "blanks", subject: "chemistry", answer_kind: "multi_blank", scoring: basis({ a: "2", b: "3" }) },
    { id: "expression", subject: "math", answer_kind: "expression", scoring: basis("x^2+2*x+1") },
    { id: "shared", subject: "geography", answer_kind: "open", parts: [{ label: "a", prompt: "第一小问完整材料" }, { label: "b", prompt: "第二小问完整材料" }], assets: [{ ref: "figure.png", alt: "共享原图甲" }, { ref: "second.jpg", alt: "共享原图乙" }], scoring: { ...basis({ a: "PRIVATE-FIRST", b: "PRIVATE-SECOND" }, 5), rubric: [{ partLabel: "a", points: 3, evidence: "PRIVATE-RUBRIC-A" }, { partLabel: "b", points: 2, evidence: "PRIVATE-RUBRIC-B" }], units: ["km"], tolerance: 0.1, acceptableAlternatives: ["可接受的完整说明"], reviewConditions: "按原图检查" } },
    { id: "unscored", subject: "computer-science", answer_kind: "open" },
    { id: "ambiguous", subject: "astronomy", answer_kind: "single_choice", options, scoring: { ...basis("A"), deterministicLocked: true } },
  ];
  const answers: Record<string, string> = { single: "最终答案：A", multi: "最终答案：A、C", numeric: "最终答案：6 N", blanks: "a=2，b=3", expression: "最终答案：(x+1)^2", shared: "第一小问：完整解释。第二小问：完整推导。", unscored: "完整无评分答卷", ambiguous: "A 或 B，尚不能确定最终选项。" };
  const sourceFile = join(source, "questions.json");
  writeFileSync(sourceFile, JSON.stringify(samples.map((sample) => ({ ...sample, version: "1", question: `fixture:${sample.id}\n共享条件保持原样，公式 $F=ma$。` }))));
  const cfg = { datasetsRoot: join(root, "datasets"), importRoot: join(root, "drafts"), runsRoot: join(root, "runs"), workRoot: join(root, "work"), modelsConfigPath: "unused", toolsVersion: EXAM_TOOLS_VERSION, pythonInterpreter: "python", animation: false };
  const importer = new ImportService(cfg.datasetsRoot, cfg.importRoot);
  const draft = importer.importSource(sourceFile, { datasetId: "representative" });
  const published = await importer.confirmDraft(draft.draftId);
  const faux = fauxProvider({ models: [{ id: "faux-1", input: ["text", "image"] }] });
  const requests: Array<{ id: string; text: string; withTools: boolean; toolResult: boolean; toolOutput: string }> = [];
  const respond = (context: TranscriptContext) => {
    const text = JSON.stringify(context);
    const id = samples.find((sample) => text.includes(`fixture:${sample.id}`))?.id;
    if (!id) throw new Error("测试请求缺少原始题目标识。");
    const withTools = context.messages.some((message) => message.role === "system" && message.toolsAdded?.length);
    const toolResult = context.messages.some((message) => message.role === "toolResult");
    const toolOutput = context.messages.flatMap((message) => message.role === "toolResult" ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []) : []).join("\n");
    requests.push({ id, text, withTools, toolResult, toolOutput });
    if (executeTool && id === "numeric" && withTools && !toolResult) return fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 * 3" }));
    return fauxAssistantMessage(answers[id]!);
  };
  faux.setResponses(Array.from({ length: 17 }, () => respond));
  const models = createModels(); models.setProvider(faux.provider);
  const profile = ModelProfileSchema.parse({ id: "faux", displayName: "Faux", provider: "faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] }, models: [{ id: "faux-1", name: "Faux", input: ["text", "image"], contextWindow: 16384, maxTokens: 1024 }] });
  const params = { ...cfg, datasetId: published.datasetId, datasetDir: published.path, profileId: "faux", modelId: "faux-1", modes: ["without_tool", "with_tool"] as Array<"without_tool" | "with_tool">, limit: 8, registryOverride: { models, profilesById: new Map([["faux", profile]]) } };
  const result = await runBatch(params);
  const service = new ReviewService(cfg.runsRoot, published.path, published.datasetId);
  const tasks = new TaskControlService();
  const runId = result.byMode.without_tool!.runId;
  const item = (await service.getQueue(runId, "without_tool")).find((item) => item.questionId === "shared")!;
  const gradePath = join(cfg.runsRoot, item.sourceRunId, "trials", item.trialId, "grade.json");
  return { root, cfg, published, faux, requests, params, result, service, tasks, runId, item, gradePath };
}

describe("代表题型完整流程", () => {
  it("八类题从导入到两模式归档及续跑；原图与评分隔离，真实工具结果进入后续请求", async () => {
    const s = await fixture(true);
    expect(s.faux.state.callCount).toBe(17);
    expect(s.requests.every((request) => !request.text.includes("PRIVATE-"))).toBe(true);
    const shared = s.requests.filter((request) => request.id === "shared");
    expect(shared).toHaveLength(2);
    for (const request of shared) {
      expect(request.text).toContain("第一小问完整材料"); expect(request.text).toContain("第二小问完整材料");
      expect(request.text).toContain(readFileSync(join(s.published.path, "public", "figure.png")).toString("base64"));
      expect(request.text).toContain(readFileSync(join(s.published.path, "public", "second.jpg")).toString("base64"));
    }
    const toolRequest = s.requests.find((request) => request.id === "numeric" && request.withTools && request.toolResult);
    expect(toolRequest?.toolOutput).toContain("result = 6");
    for (const mode of ["without_tool", "with_tool"] as const) {
      const report = s.result.byMode[mode]!.report;
      expect(report.perQuestion).toHaveLength(8);
      expect(report.perQuestion.every((row) => row.executionStatus === "completed")).toBe(true);
      expect(report.totals.confirmedRaw).toBe(5);
      expect(report.perQuestion.find((row) => row.questionId === "unscored")?.gradingStatus).toBe("unscored");
      for (const id of ["multi", "blanks", "expression", "shared", "ambiguous"]) expect(report.perQuestion.find((row) => row.questionId === id)?.gradingStatus).toBe("pending_human_review");
    }
    await runBatch(s.params);
    expect(s.faux.state.callCount).toBe(17);
  }, 25000);

  it("原图与完整评分到达独立裁判，初评不计正式分；TUI 总分确认保留历史", async () => {
    const s = await fixture();
    const seen: GraderRequest[] = [];
    const judge = fauxProvider({ provider: "independent-judge", models: [{ id: "judge-1", input: ["text", "image"] }] });
    const judgeModels = createModels(); judgeModels.setProvider(judge.provider);
    let judgeContext = "";
    judge.setResponses([(context) => { judgeContext = JSON.stringify(context); return fauxAssistantMessage('{"score":3,"evidence":"两小问初评证据"}'); }]);
    const graderComplete = { supportsImages: true, complete: async (request: GraderRequest) => {
      seen.push(request);
      const agent = new Agent({ initialState: { systemPrompt: "Independent preliminary grading.", model: judge.models[0]!, tools: [], thinkingLevel: "off" }, streamFn: (model, context, options) => judgeModels.streamSimple(model, context, { ...options, maxRetries: 0, maxTokens: 256 }) });
      await agent.prompt(request.prompt, request.images);
      const answer = agent.state.messages.at(-1);
      if (answer?.role !== "assistant") throw new Error("独立裁判没有返回正文。");
      return answer.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
    } };
    const result = await s.service.modelPrelim(s.runId, s.item.trialId, graderComplete, "without_tool");
    expect(result.grade?.reviewStatus).toBe("model_preliminary"); expect(seen).toHaveLength(1);
    expect(seen[0]!.images.map((image) => image.data)).toEqual(["figure.png", "second.jpg"].map((ref) => readFileSync(join(s.published.path, "public", ref)).toString("base64")));
    for (const text of ["第一小问完整材料", "第二小问完整材料", "PRIVATE-RUBRIC-A", "PRIVATE-RUBRIC-B", "可接受的完整说明"]) expect(seen[0]!.prompt).toContain(text);
    expect(seen[0]!.prompt).not.toContain("without_tool"); expect(seen[0]!.prompt).not.toContain("faux-1");
    expect(judge.state.callCount).toBe(1);
    expect(judgeContext).toContain(seen[0]!.images[0]!.data);
    expect(judgeContext).toContain("PRIVATE-RUBRIC-A");
    expect((await s.tasks.rebuildReport(s.cfg.runsRoot, s.runId, s.published.path, "representative", "without_tool")).totals.confirmedRaw).toBe(5);
    const tui = new ExamTui(s.cfg); await tui.openReview(s.runId);
    const screen = tui.getState().screen;
    if (screen.kind !== "review") throw new Error("未进入复核页。");
    tui.highlightReview(screen.items.findIndex((item) => item.questionId === "shared"));
    tui.setReviewField("score", "4"); tui.setReviewField("confirmer", "meiko"); tui.setReviewField("reason", "原图与两小问逐一检查后修订总分。"); tui.prepareReview();
    const app = new ExamApp(tui);
    try {
      vi.spyOn(app as any, "termRows").mockReturnValue(24);
      let summary = app.render(80).join("\n");
      expect(summary).toContain("确认保存"); expect(summary).toContain("明确确认保存");
      for (let i = 0; i < 15; i++) { app.handleInput("\x1b[B"); summary = app.render(80).join("\n"); }
      expect(summary).toContain("未逐项重新评分"); expect(summary).toContain("明确确认保存");
      await tui.submitReview();
    } finally { app.dispose(); }
    const grade = JSON.parse(readFileSync(s.gradePath, "utf8"));
    expect(grade.items).toHaveLength(1); expect(grade.items[0].points).toBe(4); expect(grade.rawScore).toBe(4);
    expect(readFileSync(join(s.cfg.runsRoot, s.item.sourceRunId, "trials", s.item.trialId, "grade-history.jsonl"), "utf8")).toContain("两小问初评证据");
    expect((await s.tasks.rebuildReport(s.cfg.runsRoot, s.runId, s.published.path, "representative", "without_tool")).totals.confirmedRaw).toBe(9);
    expect(s.faux.state.callCount).toBe(16);
  }, 20000);

  it("纯文本裁判无法初评图片题；初评期间评分材料变化时不覆盖旧成绩", async () => {
    const s = await fixture();
    const before = readFileSync(s.gradePath, "utf8");
    const textJudge = vi.fn(async () => '{"score":5}');
    expect((await s.service.modelPrelim(s.runId, s.item.trialId, textJudge, "without_tool")).skipped).toContain("image support");
    expect(textJudge).not.toHaveBeenCalled();
    const path = join(s.published.path, "scoring", "shared.json");
    const result = await s.service.modelPrelim(s.runId, s.item.trialId, { supportsImages: true, complete: async () => { const spec = JSON.parse(readFileSync(path, "utf8")); spec.reference.a = "测试期间更新的参考依据"; writeFileSync(path, JSON.stringify(spec)); return '{"score":5}'; } }, "without_tool");
    expect(result.skipped).toContain("已变化"); expect(readFileSync(s.gradePath, "utf8")).toBe(before);
    expect(s.faux.state.callCount).toBe(16);
  }, 20000);

  it("初评期间人工已确认则保留人工结果；已确认成绩不能被初评降回待确认", async () => {
    const s = await fixture();
    const result = await s.service.modelPrelim(s.runId, s.item.trialId, { supportsImages: true, complete: async () => { await s.service.submitHuman(s.runId, s.item.trialId, { score: 4, confirmer: "another", reason: "已检查" }, "without_tool"); return '{"score":1}'; } }, "without_tool");
    expect(result.skipped).toContain("已变化");
    expect(JSON.parse(readFileSync(s.gradePath, "utf8"))).toMatchObject({ rawScore: 4, reviewStatus: "human_confirmed" });
    const complete = vi.fn(async () => '{"score":1}');
    expect((await s.service.modelPrelim(s.runId, s.item.trialId, { supportsImages: true, complete }, "without_tool")).skipped).toContain("confirmed");
    expect(complete).not.toHaveBeenCalled();
  }, 20000);

  it("逐项改分按当前细则验证，拒绝不存在的小问及超项满分；旧分项完整保留", async () => {
    const s = await fixture();
    const original = JSON.parse(readFileSync(s.gradePath, "utf8"));
    writeGradeFile(s.cfg.runsRoot, s.item.sourceRunId, s.item.trialId, { ...original, rawScore: 3, items: [{ partLabel: "a", points: 2, evidence: "旧第一项证据" }, { partLabel: "b", points: 1, evidence: "旧第二项证据" }] });
    const before = readFileSync(s.gradePath, "utf8");
    const decision = { score: 4, confirmer: "meiko", reason: "逐项重新检查" };
    await expect(s.service.submitHuman(s.runId, s.item.trialId, { ...decision, items: [{ partLabel: "a", points: 4 }, { partLabel: "b", points: 0 }] }, "without_tool")).rejects.toThrow("各项满分");
    await expect(s.service.submitHuman(s.runId, s.item.trialId, { ...decision, items: [{ partLabel: "missing", points: 2 }, { partLabel: "b", points: 2 }] }, "without_tool")).rejects.toThrow("不存在");
    expect(readFileSync(s.gradePath, "utf8")).toBe(before);
    const grade = await s.service.submitHuman(s.runId, s.item.trialId, { ...decision, items: [{ partLabel: "a", points: 3, evidence: "新第一项证据" }, { partLabel: "b", points: 1, evidence: "新第二项证据" }] }, "without_tool");
    expect(grade.items.reduce((sum, item) => sum + item.points, 0)).toBe(grade.rawScore);
    expect(readFileSync(join(s.cfg.runsRoot, s.item.sourceRunId, "trials", s.item.trialId, "grade-history.jsonl"), "utf8")).toContain("旧第二项证据");
  }, 20000);

  it("人工确认使用当前评分依据的满分，旧评分满分不限制新的有效决定", async () => {
    const s = await fixture();
    const path = join(s.published.path, "scoring", "shared.json");
    const basis = JSON.parse(readFileSync(path, "utf8"));
    basis.maxScore = 6; basis.rubric[0].points = 4;
    writeFileSync(path, JSON.stringify(basis));
    const item = (await s.service.getQueue(s.runId, "without_tool")).find((item) => item.questionId === "shared")!;
    const grade = await s.service.submitHuman(s.runId, item.trialId, { score: 6, confirmer: "meiko", reason: "按当前依据重新检查", expectedReviewToken: item.reviewToken }, "without_tool");
    expect(grade.maxScore).toBe(6); expect(grade.rawScore).toBe(6); expect(grade.items[0]!.points).toBe(6);
  }, 20000);
});
