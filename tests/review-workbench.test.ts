import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { runBatch } from "../src/runner/batch.js";
import { ReviewService } from "../src/service/review-service.js";
import { ExamTui } from "../src/tui/controller.js";
import { ExamApp } from "../src/tui/app.js";
import { TaskControlService } from "../src/service/task-service.js";

// 确定性验证材料保留在 .work，不触及正式题库和历史成绩。
async function fixture(reuse = false) {
  mkdirSync(resolve(".work"), { recursive: true });
  const root = mkdtempSync(resolve(".work", "review-verification-"));
  const dataset = join(root, "datasets", "demo");
  mkdirSync(join(dataset, "public"), { recursive: true });
  mkdirSync(join(dataset, "scoring"));
  const scoring = { questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "open", maxScore: 2.5, reference: "hidden-reference-marker", rubric: [{ points: 2.5, evidence: "完整解释应引用条件", acceptAlternatives: ["等价说明"] }], reviewConditions: "逐项检查" };
  for (const id of ["q1", "q2"]) {
    writeFileSync(join(dataset, "public", `${id}.md`), `---\nid: ${id}\nversion: "1"\nsubject: physics\nanswer_kind: open\n---\n\n完整题面开头-${id}\n\n请解释条件与结论。\n\n完整题面结尾-${id}\n`);
    writeFileSync(join(dataset, "scoring", `${id}.json`), JSON.stringify({ ...scoring, questionId: id }));
  }
  const faux = fauxProvider();
  const answer = ["答卷开头-marker", ...Array.from({ length: 50 }, (_, i) => `推理步骤 ${i}：这是用于验证长答卷阅读的中文内容。`), "答卷结尾-marker"].join("\n");
  faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage(answer)));
  const models = createModels();
  models.setProvider(faux.provider);
  const profile = ModelProfileSchema.parse({ id: "faux", displayName: "Faux", provider: "faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] }, models: [{ id: "faux-1", name: "Faux", input: ["text"], reasoning: false, contextWindow: 4096, maxTokens: 1024 }], capability: {} });
  const cfg = { datasetsRoot: join(root, "datasets"), modelsConfigPath: "unused", runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: "v1", pythonInterpreter: "python", registryOverride: { models, profilesById: new Map([["faux", profile]]) } };
  const params = { datasetId: "demo", datasetDir: dataset, modes: ["without_tool"] as Array<"without_tool">, profileId: "faux", modelId: "faux-1", limit: 2, ...cfg };
  let result = await runBatch(params);
  if (reuse) result = await runBatch(params);
  const runId = result.byMode.without_tool!.runId;
  const review = new ReviewService(cfg.runsRoot, dataset, "demo");
  const tui = new ExamTui(cfg);
  await tui.openReview(runId);
  const item = (await review.getQueue(runId, "without_tool"))[0]!;
  const gradePath = join(cfg.runsRoot, item.sourceRunId, "trials", item.trialId, "grade.json");
  const app = new ExamApp(tui);
  app.rerender = vi.fn();
  return { root, dataset, cfg, faux, runId, review, tui, app, item, gradePath, scoring };
}

async function flush() { await new Promise<void>((done) => setImmediate(done)); }
function fill(tui: ExamTui) {
  tui.setReviewField("score", "1.25");
  tui.setReviewField("confirmer", "meiko");
  tui.setReviewField("reason", "第一项推理成立，第二项未给出证据。");
}

describe("人工复核工作台", () => {
  it("不默认评分，缺少分数、确认人或依据不能进入确认或保存", async () => {
    const s = await fixture();
    const screen = s.tui.getState().screen;
    expect(screen.kind === "review" && screen.score).toBeNull();
    expect(() => s.tui.prepareReview()).toThrow("填写");
    s.tui.setReviewField("score", "0");
    s.tui.setReviewField("confirmer", " ");
    s.tui.setReviewField("reason", "说明");
    expect(() => s.tui.prepareReview()).toThrow("填写");
    await expect(s.tui.submitReview()).rejects.toThrow("明确确认");
    expect(JSON.parse(readFileSync(s.gradePath, "utf8")).reviewStatus).toBe("pending_human_review");
  });

  it.each(["", "NaN", "Infinity", "-0.1", "2.6", "不是数字"])("无效分数 %s 被拒绝", async (score) => {
    const s = await fixture();
    expect(() => s.tui.setReviewField("score", score)).toThrow("有效分数");
  });

  it("小数分数明确确认后写入真实来源，保留历史并更新报告，不再作答", async () => {
    const s = await fixture(true);
    fill(s.tui);
    s.tui.prepareReview();
    await s.tui.submitReview();
    const saved = JSON.parse(readFileSync(s.gradePath, "utf8"));
    expect(saved.rawScore).toBe(1.25);
    expect(saved.reviewStatus).toBe("human_confirmed");
    expect(saved.items[0].note).toContain("meiko");
    expect(saved.items[0].note).toContain("第一项推理成立");
    expect(readFileSync(join(s.cfg.runsRoot, s.item.sourceRunId, "trials", s.item.trialId, "grade-history.jsonl"), "utf8")).toContain("pending_human_review");
    const report = await new TaskControlService().rebuildReport(s.cfg.runsRoot, s.runId, s.dataset, "demo", "without_tool");
    expect(report.totals.confirmedRaw).toBe(1.25);
    expect(s.faux.state.callCount).toBe(2);
    const next = s.tui.getState().screen;
    expect(next.kind === "review" && next.score).toBeNull();
    await expect(s.tui.submitReview()).rejects.toThrow("明确确认");
  });

  it("取消确认、修改字段和切换题目都使确认失效，题目之间不沿用分数或理由", async () => {
    const s = await fixture();
    fill(s.tui);
    s.tui.prepareReview();
    s.tui.cancelReviewConfirmation();
    await expect(s.tui.submitReview()).rejects.toThrow();
    s.tui.prepareReview();
    s.tui.setReviewField("score", "2");
    await expect(s.tui.submitReview()).rejects.toThrow();
    s.tui.highlightReview(1);
    const next = s.tui.getState().screen;
    expect(next.kind === "review" && next.score).toBeNull();
    expect(next.kind === "review" && next.reason).toBe("");
    expect(next.kind === "review" && next.confirmer).toBe("meiko");
  });

  it("同版本评分内容改变也拒绝旧复核决定，原评分保持不变", async () => {
    const s = await fixture();
    const before = readFileSync(s.gradePath, "utf8");
    fill(s.tui);
    s.tui.prepareReview();
    writeFileSync(join(s.dataset, "scoring", "q1.json"), JSON.stringify({ ...s.scoring, reference: "changed-reference" }));
    await expect(s.tui.submitReview()).rejects.toThrow("已变化");
    expect(readFileSync(s.gradePath, "utf8")).toBe(before);
  });

  it("其他复核者已更新成绩时不能覆盖，服务拒绝空白确认信息", async () => {
    const s = await fixture();
    fill(s.tui);
    s.tui.prepareReview();
    await s.review.submitHuman(s.runId, s.item.trialId, { score: 2, confirmer: "another", reason: "已检查" }, "without_tool");
    await expect(s.tui.submitReview()).rejects.toThrow("已变化");
    await expect(s.review.submitHuman(s.runId, s.item.trialId, { score: 0, confirmer: " ", reason: " " }, "without_tool")).rejects.toThrow("不能为空");
    expect(JSON.parse(readFileSync(s.gradePath, "utf8")).rawScore).toBe(2);
  });

  it("题面、长答卷头尾和评分依据均可阅读，滚动不改变选中题目", async () => {
    const s = await fixture();
    expect(s.app.render(80).join("\n")).toContain("完整题面开头-q1");
    s.app.handleInput("2");
    expect(s.app.render(80).join("\n")).toContain("答卷开头-marker");
    for (let i = 0; i < 100; i++) { s.app.handleInput("\x1b[B"); s.app.render(80); }
    expect(s.app.render(80).join("\n")).toContain("答卷结尾-marker");
    const state = s.tui.getState().screen;
    expect(state.kind === "review" && state.index).toBe(0);
    s.app.handleInput("3");
    expect(s.app.render(80).join("\n")).toContain("hidden-reference-marker");
  });

  it("字段输入中的 q/h/r 不触发全局命令，Enter 只检查摘要，y 才保存", async () => {
    const s = await fixture();
    const quit = vi.fn();
    s.app.setQuitHandler(quit);
    for (const [key, value] of [["s", "1.25"], ["c", "qhrmeiko"], ["e", "引用题目条件，结论只有部分成立"]]) {
      s.app.handleInput(key!);
      for (const char of value!) s.app.handleInput(char);
      s.app.handleInput("\r");
    }
    expect(quit).not.toHaveBeenCalled();
    s.app.handleInput("\r");
    await flush();
    expect(s.app.render(80).join("\n")).toContain("确认保存");
    s.app.handleInput("\r");
    await flush();
    expect(JSON.parse(readFileSync(s.gradePath, "utf8")).reviewStatus).toBe("pending_human_review");
    s.app.handleInput("y");
    await vi.waitFor(() => expect(JSON.parse(readFileSync(s.gradePath, "utf8")).reviewStatus).toBe("human_confirmed"));
    expect(JSON.parse(readFileSync(s.gradePath, "utf8")).items[0].note).toContain("qhrmeiko");
  });

  it("显式零分可以确认，保存成功但刷新失败会明确区分两个结果", async () => {
    const s = await fixture();
    fill(s.tui);
    s.tui.setReviewField("score", "0");
    s.tui.prepareReview();
    const refresh = vi.spyOn(ReviewService.prototype, "getQueue").mockRejectedValueOnce(new Error("无法读取队列"));
    try {
      await expect(s.tui.submitReview()).rejects.toThrow("已保存 q1，但复核队列刷新失败");
      expect(JSON.parse(readFileSync(s.gradePath, "utf8")).rawScore).toBe(0);
      expect(JSON.parse(readFileSync(s.gradePath, "utf8")).reviewStatus).toBe("human_confirmed");
    } finally {
      refresh.mockRestore();
    }
  });

  it("编辑字段时不显示不可用的全局导航，确认状态显示保存和取消提示", async () => {
    const s = await fixture();
    s.app.handleInput("c");
    expect(s.app.render(80).join("\n")).not.toContain("h 历史");
    s.app.handleInput("\x1b");
    fill(s.tui);
    s.tui.prepareReview();
    const rendered = s.app.render(80).join("\n");
    expect(rendered).toContain("y 保存评分");
    expect(rendered).not.toContain("h 历史");
  });

  it("评分依据页可滚动阅读实际待复核原因，分数仍由人工填写", async () => {
    const s = await fixture();
    expect(s.item.currentGrade?.reviewReason).toBe("open requires human/model review in v1");
    s.app.handleInput("3");
    const frames = [];
    for (let i = 0; i < 45; i++) {
      frames.push(s.app.render(80).join("\n"));
      s.app.handleInput("\x1b[B");
    }
    const output = frames.join("\n");
    expect(output).toContain("待复核原因：");
    expect(output).toContain("open requires human/model review in v1");
    const state = s.tui.getState().screen;
    expect(state.kind === "review" && state.score).toBeNull();
    expect(JSON.parse(readFileSync(s.gradePath, "utf8")).reviewStatus).toBe("pending_human_review");
  });
});
