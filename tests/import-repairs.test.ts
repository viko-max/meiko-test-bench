import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { fauxProvider, fauxAssistantMessage, createModels } from "@earendil-works/pi-ai";
import { ImportService, parseMarkdownSource, parseJsonSource } from "../src/import/import-service.js";
import { importDataset } from "../src/dataset/import.js";
import { ExamTui } from "../src/tui/controller.js";
import { ExamApp } from "../src/tui/app.js";
import { ModelProfileSchema } from "../src/shared/contracts.js";
import { runBatch } from "../src/runner/batch.js";
import { readManifest } from "../src/runner/answer-source.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as json from "../src/shared/json.js";
import { prepareMascotImage } from "../src/tui/mascot.js";

beforeAll(async () => prepareMascotImage());

// 所有验证材料保留在项目 .work 下，不删除文件，不修改正式题库。
function setup() {
  mkdirSync(resolve(".work"), { recursive: true });
  const root = mkdtempSync(resolve(".work", "import-repairs-"));
  const source = join(root, "source");
  mkdirSync(source);
  const datasets = join(root, "datasets");
  const drafts = join(root, "drafts");
  const service = new ImportService(datasets, drafts);
  const file = join(source, "q.json");
  const write = (questions: unknown[]) => writeFileSync(file, JSON.stringify(questions));
  const question = { id: "q1", question: "解释现象。", answer_kind: "open", maxScore: 5, answer: "hidden-reference" };
  const load = (id = "demo") => importDataset({ datasetId: id, publicDir: join(datasets, id, "public"), scoringDir: join(datasets, id, "scoring") });
  const tui = new ExamTui({ datasetsRoot: datasets, runsRoot: join(root, "runs"), importRoot: drafts, workRoot: join(root, "work"), modelsConfigPath: "unused", toolsVersion: "v1", pythonInterpreter: "python", animation: false });
  const app = new ExamApp(tui);
  return { root, source, datasets, drafts, service, file, write, question, load, tui, app };
}
afterEach(() => vi.restoreAllMocks());

describe("导入安全、忠实转换与不可覆盖发布", () => {
  it.each(["答案：B", "## 解析\n推理内容", "Answer: B", "## Solution\ncontent"])("混合评分标记 %s 阻止发布", async (marker) => {
    const s = setup();
    s.write([{ ...s.question, question: `原题\n\n${marker}` }]);
    const draft = s.service.importSource(s.file, { datasetId: "demo" });
    expect(s.service.check(draft.draftId).ok).toBe(false);
    await expect(s.service.confirmDraft(draft.draftId)).rejects.toThrow("入库校验失败");
    expect(existsSync(join(s.datasets, "demo"))).toBe(false);
  });

  it.each(["../escape", "con", "bad/name", "id."])("非法题号 %s 在写入前拒绝", async (id) => {
    const s = setup();
    s.write([{ ...s.question, id }]);
    const draft = s.service.importSource(s.file, { datasetId: "demo" });
    await expect(s.service.confirmDraft(draft.draftId)).rejects.toThrow();
    expect(existsSync(s.datasets)).toBe(false);
    expect(() => s.service.getDraft("../escape")).toThrow();
  });

  it("重复题号、格式错误和空题库都不能静默发布", async () => {
    const s = setup();
    s.write([s.question, s.question]);
    await expect(s.service.confirmDraft(s.service.importSource(s.file, { datasetId: "duplicate" }).draftId)).rejects.toThrow("题号重复");
    writeFileSync(s.file, "{");
    await expect(s.service.confirmDraft(s.service.importSource(s.file, { datasetId: "broken" }).draftId)).rejects.toThrow("转换失败");
    expect(s.service.listBank()).toEqual([]);
  });

  it("越界附件和父目录联接在复制前拒绝", async () => {
    const s = setup();
    writeFileSync(join(s.root, "private.png"), "fixture-only");
    s.write([{ ...s.question, assets: [{ ref: "../private.png" }] }]);
    const first = s.service.importSource(s.file, { datasetId: "demo" });
    await expect(s.service.confirmDraft(first.draftId)).rejects.toThrow("路径");
    const external = join(s.root, "external");
    mkdirSync(external);
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toFile(join(external, "figure.png"));
    symlinkSync(external, join(s.source, "linked"), "junction");
    s.write([{ ...s.question, assets: [{ ref: "linked/figure.png" }] }]);
    const second = s.service.importSource(s.file, { datasetId: "demo" });
    await expect(s.service.confirmDraft(second.draftId)).rejects.toThrow("路径");
    expect(s.service.listBank()).toEqual([]);
  });

  it("答案角色附件不能转换成普通题图", async () => {
    const s = setup();
    s.write([{ ...s.question, assets: [{ ref: "answer.png", role: "answer_key" }] }]);
    const draft = s.service.importSource(s.file, { datasetId: "demo" });
    await expect(s.service.confirmDraft(draft.draftId)).rejects.toThrow("scoring role");
  });

  it("既有版本不覆盖，新版本隔离题面、附件和评分", async () => {
    const s = setup();
    s.write([s.question]);
    await s.service.confirmDraft(s.service.importSource(s.file, { datasetId: "demo" }).draftId);
    const before = readFileSync(join(s.datasets, "demo/public/q1.md"), "utf8");
    s.write([{ id: "q1", question: "修改后的题面", answer_kind: "open" }]);
    const conflict = s.service.importSource(s.file, { datasetId: "demo" });
    await expect(s.service.confirmDraft(conflict.draftId)).rejects.toThrow("禁止覆盖");
    const version = s.service.importSource(s.file, { datasetId: "demo", version: "2" });
    expect((await s.service.confirmDraft(version.draftId)).datasetId).toBe("demo.v2");
    expect(readFileSync(join(s.datasets, "demo/public/q1.md"), "utf8")).toBe(before);
    expect((await s.load("demo.v2")).entries[0]!.scoring).toBeUndefined();
    const old = JSON.parse(readFileSync(join(s.datasets, "demo/VERSION.json"), "utf8"));
    const next = JSON.parse(readFileSync(join(s.datasets, "demo.v2/VERSION.json"), "utf8"));
    expect(next.publicDigest).not.toBe(old.publicDigest);
    expect(next.scoringDigest).not.toBe(old.scoringDigest);
  });

  it("同时发布同一版本时只有一个草稿成功", async () => {
    const s = setup();
    s.write([s.question]);
    const a = s.service.importSource(s.file, { datasetId: "demo" });
    const b = s.service.importSource(s.file, { datasetId: "demo" });
    const result = await Promise.allSettled([s.service.confirmDraft(a.draftId), s.service.confirmDraft(b.draftId)]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await s.load()).entries).toHaveLength(1);
  });

  it("发布失败不暴露半成品，来源变化拒绝旧草稿", async () => {
    const s = setup();
    s.write([s.question]);
    const draft = s.service.importSource(s.file, { datasetId: "demo" });
    s.write([{ ...s.question, question: "变化" }]);
    await expect(s.service.confirmDraft(draft.draftId)).rejects.toThrow("来源文件已变化");
    expect(s.service.listBank()).toEqual([]);
  });

  it("旧转换器的草稿必须重新导入，原记录保留", async () => {
    const s = setup();
    s.write([s.question]);
    const draft = s.service.importSource(s.file, { datasetId: "demo" });
    const file = join(s.drafts, draft.draftId, "draft.json");
    const old = JSON.parse(readFileSync(file, "utf8"));
    delete old.questions[0].sourceDigest;
    writeFileSync(file, JSON.stringify(old));
    await expect(s.service.confirmDraft(draft.draftId)).rejects.toThrow("旧草稿");
    expect(existsSync(file)).toBe(true);
    expect(existsSync(s.datasets)).toBe(false);
  });

  it("发布后的状态保存失败明确报告已发布，内容完整保留", async () => {
    const s = setup();
    s.write([s.question]);
    const draft = s.service.importSource(s.file, { datasetId: "demo" });
    const original = json.writeJsonAtomic;
    vi.spyOn(json, "writeJsonAtomic").mockImplementation((file, value) => {
      if (file.endsWith("draft.json") && (value as { status?: string }).status === "confirmed") throw new Error("disk failure");
      original(file, value);
    });
    await expect(s.service.confirmDraft(draft.draftId)).rejects.toThrow("已发布");
    expect((await s.load()).ok).toBe(true);
    vi.restoreAllMocks();
    const before = readFileSync(join(s.datasets, "demo/public/q1.md"));
    expect((await s.service.confirmDraft(draft.draftId)).questions).toBe(1);
    expect(s.service.getDraft(draft.draftId)!.status).toBe("confirmed");
    expect(readFileSync(join(s.datasets, "demo/public/q1.md"))).toEqual(before);
  });

  it("JSON 原图仅在附件字段出现也能完整进入公开题目", async () => {
    const s = setup();
    await sharp({ create: { width: 3, height: 2, channels: 3, background: "red" } }).png().toFile(join(s.source, "figure.png"));
    s.write([{ ...s.question, assets: [{ ref: "figure.png", alt: "原图" }] }]);
    const draft = s.service.importSource(s.file, { datasetId: "demo" });
    expect((await s.service.confirmDraft(draft.draftId)).assetsCopied).toBe(1);
    const entry = (await s.load()).entries[0]!;
    expect(entry.errors).toEqual([]);
    expect(entry.question!.assets).toEqual([{ ref: "figure.png", alt: "原图", role: "figure", mediaType: "image/png" }]);
    expect(readFileSync(join(s.datasets, "demo/public/figure.png"))).toEqual(readFileSync(join(s.source, "figure.png")));
  });

  it("单文件导入保留相邻原图，坏图片不能正式入库", async () => {
    const s = setup();
    await sharp({ create: { width: 3, height: 2, channels: 3, background: "blue" } }).png().toFile(join(s.source, "figure.png"));
    const md = join(s.source, "q.md");
    writeFileSync(md, "看图作答 ![原图](figure.png)");
    await s.service.confirmDraft(s.service.importSource(md, { datasetId: "single" }).draftId);
    expect((await s.load("single")).entries[0]!.question!.assets).toHaveLength(1);
    writeFileSync(join(s.source, "broken.png"), "PNGDATA");
    writeFileSync(md, "![坏图](broken.png)");
    await expect(s.service.confirmDraft(s.service.importSource(md, { datasetId: "broken" }).draftId)).rejects.toThrow("undecodable image");
    expect(existsSync(join(s.datasets, "broken"))).toBe(false);
  });

  it("JSON 正文中的图片和选项也能正确转换", async () => {
    const s = setup();
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).png().toFile(join(s.source, "figure.png"));
    s.write([{ ...s.question, question: "看图 ![原图](figure.png)\n\n- C. 甲\n- D. 乙", answer_kind: "single_choice", answer: "C" }]);
    await s.service.confirmDraft(s.service.importSource(s.file, { datasetId: "demo" }).draftId);
    const question = (await s.load()).entries[0]!.question!;
    expect(question.assets).toHaveLength(1);
    expect(question.options).toEqual({ C: "甲", D: "乙" });
  });

  it("标准题目包再次导入保留小问与完整评分细则", async () => {
    const s = setup();
    s.write([{ ...s.question, parts: [{ label: "a", prompt: "第一小问" }], rubric: [{ partLabel: "a", points: 5, evidence: "关键条件", acceptAlternatives: ["等价表达"] }], acceptableAlternatives: ["another"], reviewConditions: "有歧义需复核" }]);
    await s.service.confirmDraft(s.service.importSource(s.file, { datasetId: "first" }).draftId);
    const packaged = s.service.importSource(join(s.datasets, "first"), { datasetId: "roundtrip" });
    await s.service.confirmDraft(packaged.draftId);
    const entry = (await s.load("roundtrip")).entries[0]!;
    expect(entry.question!.parts).toEqual([{ label: "a", prompt: "第一小问" }]);
    expect(entry.scoring!.rubric[0]!.evidence).toBe("关键条件");
    expect(entry.scoring!.acceptableAlternatives).toEqual(["another"]);
    expect(entry.scoring!.reviewConditions).toBe("有歧义需复核");
  });

  it("Markdown 小标题和代码块不误拆，共享材料保持完整", () => {
    const input = '---\nid: q1\nversion: "1"\nsubject: physics\nanswer_kind: open\nparts:\n  - label: a\n    prompt: 第一问\n---\n共享材料\n## Part a\n第一问\n## Part b\n第二问';
    const questions = parseMarkdownSource(input, "q.md");
    expect(questions).toHaveLength(1);
    expect(questions[0]!.stem).toContain("共享材料");
    expect(questions[0]!.parts).toEqual([{ label: "a", prompt: "第一问" }]);
    expect(parseMarkdownSource("```text\n## 1\n## 2\n```", "q.md")).toHaveLength(1);
    expect(parseMarkdownSource("## 1\n题一\n## 2\n题二", "q.md")).toHaveLength(2);
  });

  it("带标签的 JSON 选项保留标签和文字，不转换成 JSON 字符串", () => {
    expect(parseJsonSource([{ question: "选择", options: [{ label: "C", text: "甲" }, { label: "D", text: "乙" }] }], "q.json")[0]!.options).toEqual({ C: "甲", D: "乙" });
  });

  it.each([{ options: 0 }, { assets: "figure.png" }, { options: { A: "只有一个选项" }, answer_kind: "single_choice" }])("错误字段不能静默丢弃后发布：%j", async (fields) => {
    const s = setup();
    s.write([{ ...s.question, ...fields }]);
    const draft = s.service.importSource(s.file, { datasetId: "demo" });
    await expect(s.service.confirmDraft(draft.draftId)).rejects.toThrow("入库校验失败");
    expect(s.service.listBank()).toEqual([]);
  });

  it("导入原图实际进入两种模式请求，私有评分不进入请求，运行记录使用发布版本", async () => {
    const s = setup();
    await sharp({ create: { width: 3, height: 2, channels: 3, background: "red" } }).png().toFile(join(s.source, "figure.png"));
    s.write([{ ...s.question, assets: [{ ref: "figure.png" }] }]);
    const published = await s.service.confirmDraft(s.service.importSource(s.file, { datasetId: "demo", version: "2" }).draftId);
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("解释现象。"), fauxAssistantMessage("解释现象。")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const contexts: unknown[] = [];
    const stream = models.streamSimple.bind(models);
    vi.spyOn(models, "streamSimple").mockImplementation((model, context, options) => {
      contexts.push(JSON.parse(JSON.stringify(context)));
      return stream(model, context, options);
    });
    const profile = ModelProfileSchema.parse({ id: "faux", displayName: "Faux", provider: "faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] }, models: [{ id: "faux-1", name: "Faux", input: ["text", "image"], reasoning: false, contextWindow: 4096, maxTokens: 1024 }], capability: { imageInput: "verified", verificationEvidence: "offline fixture" } });
    const result = await runBatch({ datasetId: published.datasetId, datasetDir: published.path, modes: ["without_tool", "with_tool"], profileId: "faux", modelId: "faux-1", limit: 1, runsRoot: join(s.root, "runs"), workRoot: join(s.root, "work"), toolsVersion: "v1", pythonInterpreter: "python", modelsConfigPath: "unused", registryOverride: { models, profilesById: new Map([["faux", profile]]) } });
    expect(faux.state.callCount).toBe(2);
    expect(contexts).toHaveLength(2);
    const imageData = readFileSync(join(s.source, "figure.png")).toString("base64");
    for (const context of contexts) {
      expect(JSON.stringify(context)).toContain(imageData);
      expect(JSON.stringify(context)).not.toContain("hidden-reference");
    }
    for (const mode of ["without_tool", "with_tool"] as const) {
      expect(readManifest(join(s.root, "runs"), result.byMode[mode]!.runId)!.datasetVersion).toBe("2");
    }
  });
});

describe("导入表单和终端操作", () => {
  it("路径、标识和版本逐步可见，Esc 保留草稿，归档不删除文件", async () => {
    const s = setup();
    s.write([s.question]);
    s.tui.gotoBank();
    s.app.handleInput("i");
    expect(s.app.render(100).join("\n")).toContain("导入路径");
    for (const char of s.file) s.app.handleInput(char);
    expect(s.app.render(100).join("\n")).toContain("q.json");
    s.app.handleInput("\r");
    expect(s.app.render(100).join("\n")).toContain("题集标识");
    for (const char of "demo") s.app.handleInput(char);
    s.app.handleInput("\r");
    expect(s.app.render(100).join("\n")).toContain("题集版本");
    s.app.handleInput("\r");
    const drafts = s.service.listDrafts();
    expect(drafts).toHaveLength(1);
    s.app.handleInput("\x1b");
    expect(s.service.listDrafts()).toHaveLength(1);
    s.tui.previewDraft(drafts[0]!.draftId);
    s.app.handleInput("d");
    await new Promise<void>((done) => setImmediate(done));
    expect(s.service.getDraft(drafts[0]!.draftId)!.status).toBe("discarded");
    expect(existsSync(join(s.drafts, drafts[0]!.draftId, "draft.json"))).toBe(true);
  });

  it.each([[80, 24], [40, 24], [100, 32]])("首页适配 %s×%s 并保留全部导航和操作提示", async (width, height) => {
    const s = setup();
    vi.spyOn(s.app as never, "termRows" as never).mockReturnValue(height as never);
    await s.tui.gotoHome();
    const lines = s.app.render(width);
    expect(lines.length).toBeLessThanOrEqual(height);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(lines.join("\n")).not.toContain("/help");
    expect(lines.join("\n")).toContain("/ 命令");
    expect(lines.join("\n")).not.toContain("7设置");
    for (const char of "/help") s.app.handleInput(char);
    expect(s.app.render(width).join("\n")).toContain("/help");
    s.app.handleInput("\r");
    await new Promise<void>((done) => setImmediate(done));
    expect(s.app.render(width).join("\n")).toContain("/run");
    s.app.handleInput("\x1b");
    s.app.handleInput("/");
    for (const char of "settings") s.app.handleInput(char);
    expect(s.app.render(width).join("\n")).toContain("/settings");
  });

  it.each(["q", "\x03"])("开场中的退出键 %s 优先于跳过动画", async (key) => {
    const s = setup();
    const tui = new ExamTui({ datasetsRoot: s.datasets, runsRoot: join(s.root, "runs"), workRoot: join(s.root, "work"), modelsConfigPath: "unused", toolsVersion: "v1", pythonInterpreter: "python" });
    const app = new ExamApp(tui);
    const quit = vi.fn();
    app.setQuitHandler(quit);
    await tui.begin();
    app.startOpening();
    app.handleInput(key);
    await new Promise<void>((done) => setImmediate(done));
    expect(quit).toHaveBeenCalledOnce();
    expect(tui.getState().screen.kind).toBe("opening");
  });
});
