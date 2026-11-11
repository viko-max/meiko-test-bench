import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ImportService } from "../src/import/import-service.js";
import { buildUserContent } from "../src/runner/prompt.js";
import { importDataset } from "../src/dataset/import.js";
import { runBatch } from "../src/runner/batch.js";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { loadQuestionImage, openQuestionImage } from "../src/service/question-image.js";
import { renderQuestionImage } from "../src/tui/question-image.js";
import { ExamApp } from "../src/tui/app.js";
import { ExamTui } from "../src/tui/controller.js";
import { prepareMascotImage } from "../src/tui/mascot.js";
import * as json from "../src/shared/json.js";

beforeAll(prepareMascotImage);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  mkdirSync(resolve(".work"), { recursive: true });
  const root = mkdtempSync(resolve(".work", "draft-review-"));
  const source = join(root, "source");
  mkdirSync(source);
  const file = join(source, "questions.json");
  writeFileSync(file, JSON.stringify([{ id: "q1", version: "1", subject: "physics", answer_kind: "open", question: "保持原公式 $F=ma$，解释原图。", options: { A: "选项甲", B: "选项乙" }, parts: [{ label: "a", prompt: "第一小问完整文字。" }], assets: [{ ref: "figure.png" }, { ref: "other.jpg" }], scoring: { reference: "PRIVATE-ANSWER-TEST", maxScore: 4, scoringVersion: "1" } }, { id: "q2", question: "第二题原文。", answer_kind: "open" }], null, 2));
  await sharp({ create: { width: 40, height: 20, channels: 3, background: "#e84562" } }).png().toFile(join(source, "figure.png"));
  await sharp({ create: { width: 60, height: 30, channels: 3, background: "#93bcd8" } }).jpeg().toFile(join(source, "other.jpg"));
  const cfg = { datasetsRoot: join(root, "datasets"), importRoot: join(root, "drafts"), runsRoot: join(root, "runs"), workRoot: join(root, "work"), modelsConfigPath: "unused", toolsVersion: "v1", pythonInterpreter: "python", animation: false };
  const service = new ImportService(cfg.datasetsRoot, cfg.importRoot);
  const draft = service.importSource(file, { datasetId: "review-demo" });
  const tui = new ExamTui(cfg);
  const app = new ExamApp(tui);
  return { root, file, source, cfg, service, draft, tui, app };
}

describe("草稿原文核对、编辑和版本保护", () => {
  it("完整原文可核对，模型预览与公开请求共用构建函数并隔离私有评分", async () => {
    const s = await fixture();
    const r = s.service.reviewQuestion(s.draft.draftId, 0);
    expect(r.sourceText).toBe(readFileSync(s.file, "utf8"));
    expect(r.sourceText).toContain("PRIVATE-ANSWER-TEST");
    expect(r.scoringText).toContain("PRIVATE-ANSWER-TEST");
    expect(r.modelText).not.toContain("PRIVATE-ANSWER-TEST");
    expect(r.modelText).toContain("$F=ma$");
    expect(r.modelText).toContain("第一小问完整文字");
    expect(r.modelText).toContain("选项甲");
    expect(r.check.ok).toBe(true);
    s.app.dispose();
  });

  it("保存保留前一版本快照、来源字节及独立评分；入库后两模式读取修改后的同一公开题目", async () => {
    const s = await fixture();
    const before = readFileSync(s.file);
    const r = s.service.reviewQuestion(s.draft.draftId, 0);
    const text = "修正排版后的原题 $F=ma$。\n\n第二行保持换行。";
    const edited = s.service.editQuestion(s.draft.draftId, 0, r.digest, "stem", text);
    expect(edited.draft.questions[0]!.stem).toBe(text);
    expect(readFileSync(s.file).equals(before)).toBe(true);
    const revisions = readdirSync(join(s.cfg.importRoot, s.draft.draftId)).filter((name) => name.startsWith("revision-"));
    expect(revisions).toHaveLength(1);
    const revision = JSON.parse(readFileSync(join(s.cfg.importRoot, s.draft.draftId, revisions[0]!), "utf8"));
    expect(revision.before.questions[0].stem).toBe(r.draft.questions[0]!.stem);
    const confirmed = await s.service.confirmDraft(s.draft.draftId);
    const loaded = await importDataset({ datasetId: confirmed.datasetId, publicDir: join(confirmed.path, "public"), scoringDir: join(confirmed.path, "scoring") });
    expect(buildUserContent(loaded.entries[0]!.question!)).toBe(edited.modelText);
    expect(readFileSync(join(confirmed.path, "public", "figure.png")).equals(readFileSync(join(s.source, "figure.png")))).toBe(true);
    expect(readFileSync(join(confirmed.path, "public", "q1.md"), "utf8")).not.toContain("PRIVATE-ANSWER-TEST");
    const profile = ModelProfileSchema.parse({ id: "faux", provider: "faux", displayName: "Faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] }, models: [{ id: "faux-1", name: "Faux", contextWindow: 4096, maxTokens: 1024, input: ["text", "image"] }] });
    const faux = fauxProvider({ models: [{ id: "faux-1", input: ["text", "image"] }] });
    const seen: string[] = [];
    faux.setResponses(Array.from({ length: 2 }, () => (context) => { seen.push(JSON.stringify(context)); return fauxAssistantMessage("独立答卷"); }));
    const models = createModels();
    models.setProvider(faux.provider);
    await runBatch({ ...s.cfg, datasetId: confirmed.datasetId, datasetDir: confirmed.path, modes: ["without_tool", "with_tool"], profileId: "faux", modelId: "faux-1", limit: 1, registryOverride: { models, profilesById: new Map([["faux", profile]]) } });
    expect(faux.state.callCount).toBe(2);
    for (const payload of seen) { expect(payload).toContain("修正排版后的原题"); expect(payload).not.toContain("PRIVATE-ANSWER-TEST"); }
    s.app.dispose();
  });

  it("陈旧编辑、非法元数据、错误评分 JSON 和空题干不覆盖当前草稿", async () => {
    const s = await fixture();
    const r = s.service.reviewQuestion(s.draft.draftId, 0);
    const next = s.service.editQuestion(s.draft.draftId, 0, r.digest, "stem", "有效新题面。");
    expect(() => s.service.editQuestion(s.draft.draftId, 0, r.digest, "stem", "陈旧覆盖")).toThrow("已被其他操作更新");
    expect(() => s.service.editQuestion(s.draft.draftId, 0, next.digest, "metadata", JSON.stringify({ ...JSON.parse(next.metadataText), sourceFile: "elsewhere" }))).toThrow();
    expect(() => s.service.editQuestion(s.draft.draftId, 0, next.digest, "metadata", JSON.stringify({ ...JSON.parse(next.metadataText), reference: "forbidden" }))).toThrow();
    expect(() => s.service.editQuestion(s.draft.draftId, 0, next.digest, "scoring", "{bad")).toThrow();
    expect(() => s.service.editQuestion(s.draft.draftId, 0, next.digest, "stem", "  ")).toThrow("不能为空");
    expect(s.service.getDraft(s.draft.draftId)!.questions[0]!.stem).toBe("有效新题面。");
    s.app.dispose();
  });

  it("错误引用可保存在草稿中继续修正，但不能发布；元数据与评分各自独立编辑", async () => {
    const s = await fixture();
    let r = s.service.reviewQuestion(s.draft.draftId, 0);
    r = s.service.editQuestion(s.draft.draftId, 0, r.digest, "metadata", JSON.stringify({ ...JSON.parse(r.metadataText), subject: "math", assets: [{ ref: "missing.png" }] }));
    expect(r.check.ok).toBe(false);
    await expect(s.service.confirmDraft(s.draft.draftId)).rejects.toThrow("入库校验失败");
    r = s.service.editQuestion(s.draft.draftId, 0, r.digest, "metadata", JSON.stringify({ ...JSON.parse(r.metadataText), assets: [{ ref: "figure.png" }] }));
    r = s.service.editQuestion(s.draft.draftId, 0, r.digest, "scoring", "null");
    expect(r.check.ok).toBe(true);
    expect(r.check.warnings.join(" ")).toContain("未评分");
    expect(r.draft.questions[0]!.scoring).toBeUndefined();
    expect(r.modelText).toContain("# Question (math)");
    s.app.dispose();
  });

  it("来源变化后明确提示并拒绝保存、发布，已发布草稿不能编辑", async () => {
    const s = await fixture();
    const r = s.service.reviewQuestion(s.draft.draftId, 0);
    writeFileSync(s.file, "已经变化的来源");
    expect(s.service.reviewQuestion(s.draft.draftId, 0).sourceError).toContain("来源文件已变化");
    expect(s.service.check(s.draft.draftId).ok).toBe(false);
    expect(() => s.service.editQuestion(s.draft.draftId, 0, r.digest, "stem", "修改")).toThrow("来源文件已变化");
    await expect(s.service.confirmDraft(s.draft.draftId)).rejects.toThrow("入库校验失败");
    const other = await fixture();
    const original = other.service.reviewQuestion(other.draft.draftId, 0);
    await other.service.confirmDraft(other.draft.draftId);
    expect(() => other.service.editQuestion(other.draft.draftId, 0, original.digest, "stem", "覆盖")).toThrow("只能编辑未确认");
    s.app.dispose(); other.app.dispose();
  });

  it("保留快照失败时不更新草稿，写入错误明确返回", async () => {
    const s = await fixture();
    const r = s.service.reviewQuestion(s.draft.draftId, 0);
    const write = json.writeJsonAtomic;
    vi.spyOn(json, "writeJsonAtomic").mockImplementation((path, value) => { if (String(path).includes("revision-")) throw new Error("offline write failure"); return write(path, value); });
    expect(() => s.service.editQuestion(s.draft.draftId, 0, r.digest, "stem", "不应写入")).toThrow("offline write failure");
    expect(s.service.getDraft(s.draft.draftId)!.questions[0]!.stem).toBe(r.draft.questions[0]!.stem);
    s.app.dispose();
  });
});

describe("图片核对与实际 TUI 编辑操作", () => {
  it("核对后图片变化会阻止预览和发布，修改题干不能更新原图摘要", async () => {
    const s = await fixture();
    const r = s.service.reviewQuestion(s.draft.draftId, 0);
    await loadQuestionImage(join(s.source, "figure.png"), "figure.png");
    await sharp({ create: { width: 40, height: 20, channels: 3, background: "#00ff00" } }).png().toFile(join(s.source, "figure.png"));
    expect(s.service.check(s.draft.draftId).ok).toBe(false);
    expect(() => s.service.reviewAsset(s.draft.draftId, 0, 0)).toThrow("附件已变化");
    const edited = s.service.editQuestion(s.draft.draftId, 0, r.digest, "stem", "修改题干仍不能接受被替换的原图。");
    expect(edited.draft.assetDigests).toEqual(r.draft.assetDigests);
    await expect(s.service.confirmDraft(s.draft.draftId)).rejects.toThrow("附件已变化");
    expect(existsSync(s.cfg.datasetsRoot)).toBe(false);
    s.app.dispose();
  });

  it("PNG、JPEG 与灰度图实际解码；缩略图与 Kitty 分支均有尺寸边界", async () => {
    const s = await fixture();
    const a = s.service.reviewAsset(s.draft.draftId, 0, 0);
    const image = await loadQuestionImage(a.path, a.ref);
    const capabilities = getCapabilities();
    try {
      setCapabilities({ ...capabilities, images: null });
      const lines = renderQuestionImage(image, 20, 4);
      expect(lines.length).toBeLessThanOrEqual(4);
      expect(lines.every((line) => visibleWidth(line) <= 20)).toBe(true);
      expect(lines.join("")).toContain("▀");
      setCapabilities({ ...capabilities, images: "kitty" });
      expect(renderQuestionImage(image, 20, 4).join("")).toContain("\x1b_G");
    } finally { setCapabilities(capabilities); }
    const jpeg = await loadQuestionImage(join(s.source, "other.jpg"), "other.jpg");
    expect((await sharp(Buffer.from(jpeg.png, "base64")).metadata()).format).toBe("png");
    await sharp({ create: { width: 8, height: 6, channels: 3, background: "#999999" } }).greyscale().png().toFile(join(s.source, "grey.png"));
    const grey = await loadQuestionImage(join(s.source, "grey.png"), "grey.png");
    expect(grey.thumbnail.pixels.length).toBe(grey.thumbnail.width * grey.thumbnail.height * 3);
    s.app.dispose();
  });

  it("损坏图、非图片、越界引用及预览后变化均拒绝，不启动系统程序", async () => {
    const s = await fixture();
    writeFileSync(join(s.source, "broken.png"), "invalid image");
    await expect(loadQuestionImage(join(s.source, "broken.png"), "broken.png")).rejects.toThrow();
    await expect(loadQuestionImage(s.file, "questions.json")).rejects.toThrow("仅能核对");
    const r = s.service.reviewQuestion(s.draft.draftId, 0);
    s.service.editQuestion(s.draft.draftId, 0, r.digest, "metadata", JSON.stringify({ ...JSON.parse(r.metadataText), assets: [{ ref: "../outside.png" }] }));
    expect(() => s.service.reviewAsset(s.draft.draftId, 0, 0)).toThrow("escapes root");
    const image = await loadQuestionImage(join(s.source, "figure.png"), "figure.png");
    writeFileSync(image.path, "changed");
    await expect(openQuestionImage(image)).rejects.toThrow("原图已变化");
    s.app.dispose();
  });

  it("v 打开核对；编辑时 q、斜杠和 Enter 均为内容，Ctrl+S 保存，Esc 取消", async () => {
    const s = await fixture();
    s.tui.previewDraft(s.draft.draftId);
    s.app.handleInput("v");
    await vi.waitFor(() => expect(s.tui.getState().screen.kind).toBe("draftQuestion"));
    s.app.handleInput("e");
    s.app.handleInput("\r");
    s.app.handleInput("q"); s.app.handleInput("/");
    expect(stripTerminalSequences(s.app.render(80).join("\n"))).toContain("Ctrl+S 保存草稿");
    s.app.handleInput("\x13");
    await vi.waitFor(() => expect(s.service.getDraft(s.draft.draftId)!.questions[0]!.stem).toContain("\nq/"));
    const saved = s.service.getDraft(s.draft.draftId)!;
    s.app.handleInput("e"); s.app.handleInput("不保存"); s.app.handleInput("\x1b");
    expect(s.service.getDraft(s.draft.draftId)).toEqual(saved);
    s.app.handleInput("\x1b");
    expect(s.tui.getState().screen.kind).toBe("importPreview");
    expect(existsSync(s.cfg.datasetsRoot)).toBe(false);
    s.app.dispose();
  });

  it("错误 JSON 保存后保留编辑内容与错误提示；图片切换和 Esc 返回原题", async () => {
    const s = await fixture();
    s.tui.openDraftQuestion(s.draft.draftId, 0);
    s.app.handleInput("f"); s.app.handleInput("invalid-json"); s.app.handleInput("\x13");
    await vi.waitFor(() => expect(s.tui.getState().message).toBeTruthy());
    expect(stripTerminalSequences(s.app.render(80).join("\n"))).toContain("公开元数据");
    s.app.handleInput("\x1b"); s.app.handleInput("i");
    await vi.waitFor(() => expect(s.tui.getState().screen.kind).toBe("draftImage"));
    s.app.handleInput("n");
    await vi.waitFor(() => expect(s.tui.getState().screen).toMatchObject({ kind: "draftImage", assetIndex: 1 }));
    s.app.handleInput("\x1b");
    expect(s.tui.getState().screen).toMatchObject({ kind: "draftQuestion", review: { index: 0 } });
    s.app.dispose();
  });

  it("窄宽窗口完整滚动和模式输入视图不混入私有答案", async () => {
    const s = await fixture();
    s.tui.openDraftQuestion(s.draft.draftId, 0);
    const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    try {
      Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
      for (const width of [40, 80, 140]) {
        const lines = s.app.render(width);
        expect(lines).toHaveLength(24);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
      expect(stripTerminalSequences(s.app.render(140).join("\n"))).toContain("模型实际文本输入");
      s.app.handleInput("\t"); s.app.handleInput("\t");
      const text = stripTerminalSequences(s.app.render(80).join("\n"));
      expect(text).toContain("选项甲"); expect(text).not.toContain("PRIVATE-ANSWER-TEST");
      s.app.handleInput("n");
      await vi.waitFor(() => expect(s.tui.getState().screen).toMatchObject({ review: { index: 1 } }));
      expect(stripTerminalSequences(s.app.render(80).join("\n"))).toContain("第二题原文");
    } finally {
      if (rows) Object.defineProperty(process.stdout, "rows", rows); else Reflect.deleteProperty(process.stdout, "rows");
      s.app.dispose();
    }
  });
});
