import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { runBatch } from "../src/runner/batch.js";
import { ReviewService } from "../src/service/review-service.js";
import * as images from "../src/service/question-image.js";
import { ExamTui } from "../src/tui/controller.js";
import { ExamApp } from "../src/tui/app.js";
import { prepareMascotImage } from "../src/tui/mascot.js";

beforeAll(prepareMascotImage);
afterEach(() => vi.restoreAllMocks());

// 仅使用确定性题目和本地 faux 模型，材料保留，不修改正式记录。
async function fixture(withImages = true) {
  mkdirSync(resolve(".work"), { recursive: true });
  const root = mkdtempSync(resolve(".work", "review-images-"));
  const dataset = join(root, "datasets", "demo");
  mkdirSync(join(dataset, "public"), { recursive: true });
  mkdirSync(join(dataset, "scoring"));
  await sharp({ create: { width: 80, height: 40, channels: 3, background: "#185dab" } }).png().toFile(join(dataset, "public", "figure.png"));
  await sharp({ create: { width: 60, height: 30, channels: 3, background: "#e47a42" } }).jpeg().toFile(join(dataset, "public", "other.jpg"));
  writeFileSync(join(dataset, "public", "q1.md"), `---\nid: q1\nversion: "1"\nsubject: physics\nanswer_kind: open\n---\n\n解释共享材料中的两幅图。${withImages ? "\n\n![图甲](figure.png)\n\n![图乙](other.jpg)" : ""}\n`);
  writeFileSync(join(dataset, "scoring", "q1.json"), JSON.stringify({ questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "open", maxScore: 4, reference: "PRIVATE-REVIEW-IMAGE" }));
  const faux = fauxProvider({ models: [{ id: "faux-1", input: ["text", "image"] }] });
  const seen: string[] = [];
  faux.setResponses(Array.from({ length: 2 }, () => (context) => { seen.push(JSON.stringify(context)); return fauxAssistantMessage("独立作答，请检查两幅图。"); }));
  const models = createModels(); models.setProvider(faux.provider);
  const profile = ModelProfileSchema.parse({ id: "faux", provider: "faux", displayName: "Faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] }, models: [{ id: "faux-1", name: "Faux", input: ["text", "image"], contextWindow: 8192, maxTokens: 1024 }] });
  const cfg = { datasetsRoot: join(root, "datasets"), runsRoot: join(root, "runs"), workRoot: join(root, "work"), modelsConfigPath: "unused", toolsVersion: "v1", pythonInterpreter: "python", animation: false, registryOverride: { models, profilesById: new Map([["faux", profile]]) } };
  const result = await runBatch({ ...cfg, datasetId: "demo", datasetDir: dataset, profileId: "faux", modelId: "faux-1", modes: ["without_tool", "with_tool"], limit: 1 });
  const runId = result.byMode.without_tool!.runId;
  const service = new ReviewService(cfg.runsRoot, dataset, "demo");
  const tui = new ExamTui(cfg); await tui.openReview(runId);
  const app = new ExamApp(tui); app.rerender = vi.fn();
  const item = (await service.getQueue(runId, "without_tool"))[0]!;
  const gradePath = join(cfg.runsRoot, item.sourceRunId, "trials", item.trialId, "grade.json");
  return { root, dataset, cfg, result, faux, seen, runId, service, tui, app, item, gradePath };
}

function fill(tui: ExamTui) {
  tui.setReviewField("score", "2.5");
  tui.setReviewField("confirmer", "meiko");
  tui.setReviewField("reason", "原图条件已核对。");
}

describe("人工复核图片阅读", () => {
  it("两模式的有效答卷均可按原图读取，不发送评分材料或增加作答请求", async () => {
    const s = await fixture();
    try {
      for (const mode of ["without_tool", "with_tool"] as const) {
        const run = s.result.byMode[mode]!.runId;
        const item = (await s.service.getQueue(run, mode))[0]!;
        const image = await s.service.loadImage(run, mode, item.trialId, 0, item.reviewToken!);
        expect(image.width).toBe(80);
        expect(image.ref).toBe("figure.png");
        expect((await sharp(Buffer.from(image.png, "base64")).metadata()).format).toBe("png");
      }
      expect(s.faux.state.callCount).toBe(2);
      expect(s.seen.every((request) => !request.includes("PRIVATE-REVIEW-IMAGE"))).toBe(true);
    } finally { s.app.dispose(); }
  });

  it("i 进入、多图切换和 Esc 返回保留评分草稿；图片页不触发提交", async () => {
    const s = await fixture();
    try {
      fill(s.tui);
      s.app.handleInput("i");
      await vi.waitFor(() => expect(s.tui.getState().screen.kind).toBe("reviewImage"));
      expect(s.app.render(80).join("\n")).toContain("Esc 返回复核");
      s.app.handleInput("n");
      await vi.waitFor(() => { const screen = s.tui.getState().screen; expect(screen.kind === "reviewImage" && screen.image.ref).toBe("other.jpg"); });
      s.app.handleInput("\r"); s.app.handleInput("y");
      expect(JSON.parse(readFileSync(s.gradePath, "utf8")).reviewStatus).toBe("pending_human_review");
      s.app.handleInput("p");
      await vi.waitFor(() => { const screen = s.tui.getState().screen; expect(screen.kind === "reviewImage" && screen.assetIndex).toBe(0); });
      s.app.handleInput("\x1b");
      expect(s.tui.getState().screen).toMatchObject({ kind: "review", score: 2.5, confirmer: "meiko", reason: "原图条件已核对。", confirming: false });
      s.tui.prepareReview(); await s.tui.submitReview();
      expect(JSON.parse(readFileSync(s.gradePath, "utf8")).rawScore).toBe(2.5);
      expect(s.faux.state.callCount).toBe(2);
    } finally { s.app.dispose(); }
  });

  it("窄宽窗口和缩放保留图片提示、原图入口与底部命令，缩略图不越界", async () => {
    const s = await fixture();
    const capabilities = getCapabilities();
    try {
      setCapabilities({ ...capabilities, images: null });
      await s.tui.openReviewImage();
      for (const [width, height] of [[80, 24], [140, 40], [80, 24]]) {
        vi.spyOn(s.app as any, "termRows").mockReturnValue(height);
        const lines = s.app.render(width);
        const text = stripTerminalSequences(lines.join("\n"));
        expect(lines.length).toBeLessThanOrEqual(height);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(text).toContain("原图核对 q1 · 1/2");
        expect(text).toContain("系统原图查看器");
        expect(text).toContain("Esc 返回复核");
      }
    } finally { setCapabilities(capabilities); s.app.dispose(); }
  });

  it("无图和错误序号明确报错，确认摘要期间不能进入图片页", async () => {
    const s = await fixture(false);
    try {
      await expect(s.tui.openReviewImage()).rejects.toThrow("没有可核对");
      await expect(s.service.loadImage(s.runId, "without_tool", s.item.trialId, -1, s.item.reviewToken!)).rejects.toThrow("序号");
      await expect(s.service.loadImage(s.runId, "without_tool", s.item.trialId, 0, s.item.reviewToken!)).rejects.toThrow("不是可核对");
      fill(s.tui); s.tui.prepareReview();
      await expect(s.tui.openReviewImage()).rejects.toThrow("普通复核页面");
      expect(s.tui.getState().screen).toMatchObject({ kind: "review", confirming: true });
    } finally { s.app.dispose(); }
  });

  it("图片变化后拒绝继续查看、打开原图或保存旧决定", async () => {
    const s = await fixture();
    const opener = vi.spyOn(images, "openQuestionImage").mockResolvedValue();
    try {
      fill(s.tui); await s.tui.openReviewImage();
      await sharp({ create: { width: 80, height: 40, channels: 3, background: "#aa1133" } }).png().toFile(join(s.dataset, "public", "figure.png"));
      await expect(s.tui.openOriginalImage()).rejects.toThrow("已变化");
      await expect(s.tui.nextReviewImage(1)).rejects.toThrow("已变化");
      expect(opener).not.toHaveBeenCalled();
      s.tui.closeReviewImage(); s.tui.prepareReview();
      await expect(s.tui.submitReview()).rejects.toThrow();
      expect(JSON.parse(readFileSync(s.gradePath, "utf8")).reviewStatus).toBe("pending_human_review");
    } finally { s.app.dispose(); }
  });

  it("材料或评分已更新时拒绝旧队列，系统原图仅在明确操作后打开", async () => {
    const s = await fixture();
    const opener = vi.spyOn(images, "openQuestionImage").mockResolvedValue();
    try {
      await s.tui.openReviewImage();
      expect(opener).not.toHaveBeenCalled();
      await s.tui.openOriginalImage();
      expect(opener).toHaveBeenCalledTimes(1);
      await s.service.submitHuman(s.runId, s.item.trialId, { score: 3, confirmer: "another", reason: "已复核" }, "without_tool");
      await expect(s.tui.openOriginalImage()).rejects.toThrow("已变化");
      expect(opener).toHaveBeenCalledTimes(1);
    } finally { s.app.dispose(); }
  });

  it("异步图片读取失败显示错误，保留原复核页面与分数", async () => {
    const s = await fixture();
    try {
      fill(s.tui);
      vi.spyOn(ReviewService.prototype, "loadImage").mockRejectedValueOnce(new Error("测试图片无法读取"));
      s.app.handleInput("i");
      await vi.waitFor(() => expect(s.tui.getState().message).toContain("测试图片无法读取"));
      expect(s.tui.getState().screen).toMatchObject({ kind: "review", score: 2.5 });
      expect(s.app.rerender).toHaveBeenCalled();
    } finally { s.app.dispose(); }
  });
});
