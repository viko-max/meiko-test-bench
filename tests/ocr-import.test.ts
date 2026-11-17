import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { ImportService, type OcrClientFactory, type DraftDataset } from "../src/import/import-service.js";
import { convertOcrPages } from "../src/import/ocr-convert.js";
import { DeepSeekOcrError, type DeepSeekOcrResult } from "../src/providers/deepseek-ocr.js";
import { importDataset } from "../src/dataset/import.js";
import { ExamTui } from "../src/tui/controller.js";

const FIXTURE_SVG = resolve("tests/fixtures/ocr/public-formula-table-figure.svg");

function fresh(): { root: string; datasetsRoot: string; importRoot: string; svc: ImportService } {
  mkdirSync(resolve(".work"), { recursive: true });
  const root = mkdtempSync(resolve(".work", "ocr-import-"));
  const datasetsRoot = join(root, "datasets");
  const importRoot = join(root, ".import");
  mkdirSync(datasetsRoot, { recursive: true });
  const svc = new ImportService(datasetsRoot, importRoot);
  return { root, datasetsRoot, importRoot, svc };
}

const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
function ocrResult(pages: Array<{ index: number; text: string; finishReason?: "stop" | "length" }>): DeepSeekOcrResult {
  return {
    id: "ocr-test", created: 1730000000, purpose: "rich_layout_recognition", pageCount: pages.length,
    pages: pages.map((p) => ({ index: p.index, text: p.text, finishReason: p.finishReason ?? "stop" })),
    usage, requestId: "req-test", raw: { id: "ocr-test", object: "ocr.result", mock: true },
  };
}

/** 与自写 SVG 样卷对应的模拟识别返回：公式、表格与配图 box。 */
const SAMPLE_PAGE = [
  "自写公开样卷：公式、表格与配图（OCR 测试用）",
  "1. 已知二次函数 $f(x)=x^{2}-2x-3$，求其顶点坐标。",
  "配方法：$f(x)=(x-1)^{2}-4$，故顶点为 $(1,-4)$。",
  "2. 某班两名同学身高（cm）如下表，求平均身高。",
  "| 同学 | 甲 | 乙 |",
  "| --- | --- | --- |",
  "| 身高 | 160 | 170 |",
  "平均值 $\\bar{x}=\\frac{160+170}{2}=165$（cm）。",
  "3. 如图，圆 $O$ 半径为 $r=2$，求面积。",
  "配图<｜ref｜>圆与半径示意<｜/ref｜><｜box｜>[[60,380,420,620]]<｜/box｜>",
  "面积 $S=\\pi r^{2}=4\\pi$。",
].join("\n");

async function samplePng(root: string): Promise<string> {
  const png = join(root, "public-formula-table-figure.png");
  await sharp(FIXTURE_SVG).png().toFile(png);
  return png;
}

describe("OCR 导入（importOcrSource）", () => {
  it("Markdown/TXT/JSON 原有同步入口行为不变", () => {
    const { svc } = fresh();
    const src = join(freshRoot(), "src.md");
    writeFileSync(src, "## 1\nWhat is 2+2?\n\n- A. 3\n- B. 4\n", "utf8");
    const draft = svc.importSource(src, { datasetId: "md-demo" });
    expect(draft.format).toBe("markdown");
    expect(draft.questions.map((q) => q.id)).toEqual(["q1"]);
    expect(draft.ocr).toBeUndefined();
  });

  it("PNG 完整流程：识别→草稿→逐题对照→编辑核对→确认入库→importDataset 回读", async () => {
    const { root, datasetsRoot, importRoot } = fresh();
    let calls = 0;
    const factory: OcrClientFactory = () => ({ recognize: async () => { calls++; return ocrResult([{ index: 0, text: SAMPLE_PAGE }]); } });
    const svc2 = new ImportService(datasetsRoot, importRoot, factory);
    const png = await samplePng(root);
    const draft = await svc2.importOcrSource(png, { datasetId: "ocr-demo" });

    expect(calls).toBe(1);
    expect(draft.format).toBe("ocr");
    expect(draft.ocr?.status).toBe("completed");
    expect(draft.ocr?.pageCount).toBe(1);
    expect(draft.ocr?.requestId).toBe("req-test");
    expect(draft.ocr?.usage).toEqual(usage);
    // 原件副本、原始响应、逐页文本、操作事件都在草稿目录。
    const dir = join(importRoot, draft.draftId);
    expect(existsSync(join(dir, "source-original.png"))).toBe(true);
    expect(existsSync(join(dir, "ocr-response.json"))).toBe(true);
    expect(readFileSync(join(dir, "page-0.txt"), "utf8")).toBe(SAMPLE_PAGE);
    expect(readFileSync(join(dir, "ocr-operation.jsonl"), "utf8")).toContain('"started"');

    // 题号拆分：3 题；公式/表格保留；坐标证据解析；共享原图附件。
    expect(draft.questions.map((q) => q.id)).toEqual(["q1", "q2", "q3"]);
    expect(draft.questions[0]!.stem).toContain("$f(x)=x^{2}-2x-3$");
    expect(draft.questions[1]!.stem).toContain("| 同学 | 甲 | 乙 |");
    expect(draft.questions[1]!.stem).toContain("$\\bar{x}=\\frac{160+170}{2}=165$");
    const q3 = draft.questions[2]!;
    expect(q3.stem).not.toContain("<｜box｜>"); // 坐标标记已解析
    expect(q3.stem).toContain("圆与半径示意"); // ref 文字保留
    expect(q3.boxes).toEqual([{ page: 0, ref: "圆与半径示意", box: [60, 380, 420, 620] }]);
    expect(q3.assets?.[0]?.ref).toBe("source-original.png");
    expect(draft.ocr?.pages?.[0]?.boxes).toEqual([{ ref: "圆与半径示意", box: [60, 380, 420, 620] }]);
    // 不猜答案、不自动补评分。
    expect(draft.questions.every((q) => q.scoring === undefined)).toBe(true);
    expect(draft.warnings.some((w) => w.includes("缺少完整评分依据"))).toBe(true);

    // 逐题对照：显示逐页 OCR 原文 + 页码 + box，不把二进制当原文。
    const review = svc2.reviewQuestion(draft.draftId, 2);
    expect(review.sourceText).toContain("──── 第 1 页");
    expect(review.sourceText).toContain("[[60,380,420,620]]");
    expect(review.sourceText).not.toContain("�");
    expect(review.modelText).toContain("$S=\\pi r^{2}=4\\pi$");
    expect(review.modelText).not.toContain("<｜ref｜>");

    // 编辑题干 = 该题识别歧义已核对，记录 revision。
    const edited = svc2.editQuestion(draft.draftId, 0, review.digest, "stem", "1. 已知二次函数 $f(x)=x^{2}-2x-3$，求其顶点坐标。\n\n（已对照原图核对。）");
    expect(edited.draft.questions[0]!.ocrCheckedAt).toBeTruthy();
    expect(readdirSync(dir).some((f) => f.startsWith("revision-"))).toBe(true);

    // 确认入库 → 正式题集可回读；评分默认不完整；原图作为公开共享附件。
    const res = await svc2.confirmDraft(draft.draftId);
    expect(res.datasetId).toBe("ocr-demo");
    const loaded = await importDataset({ datasetId: "ocr-demo", publicDir: join(res.path, "public"), scoringDir: join(res.path, "scoring") });
    expect(loaded.entries).toHaveLength(3);
    expect(loaded.entries.every((e) => e.scoring === undefined)).toBe(true);
    expect(existsSync(join(res.path, "public", "source-original.png"))).toBe(true);
    expect(readFileSync(join(res.path, "public", "q1.md"), "utf8")).toContain("f(x)=x^{2}-2x-3");
    expect(existsSync(join(res.path, "source", "0-source-original.png"))).toBe(true);
  });

  it("PDF 完整草稿 review：保留原文件与页/框证据，缺位图明确待核对，核对后可入库", async () => {
    const { datasetsRoot, importRoot } = fresh();
    const factory: OcrClientFactory = () => ({ recognize: async () => ocrResult([
      { index: 0, text: "1. 求 $x^2$ 在 $[-1,1]$ 上的最大值。\n<｜ref｜>函数图象<｜/ref｜><｜box｜>[[10,10,500,300]]<｜/box｜>" },
      { index: 1, text: "2. 求 $y=2x$ 的零点。\n参考答案：$x=0$" },
    ]) });
    const svc = new ImportService(datasetsRoot, importRoot, factory);
    const pdf = join(importRoot, "..", "paper.pdf");
    writeFileSync(pdf, Buffer.from("%PDF-1.4 fake two-page exam paper"));
    const draft = await svc.importOcrSource(pdf, { datasetId: "pdf-demo" });
    expect(draft.ocr?.status).toBe("completed");
    expect(draft.ocr?.pageCount).toBe(2);
    expect(draft.questions).toHaveLength(2);
    expect(draft.questions.every((q) => q.assets === undefined)).toBe(true); // 不伪造 PDF 位图
    expect(draft.questions[0]!.conversionIssues?.some((i) => i.includes("PDF 页面位图未提取"))).toBe(true);
    // 答案章节不得进入公共题干，原始内容只在 OCR 证据。
    expect(draft.questions[1]!.stem).not.toContain("参考答案");
    expect(draft.questions[1]!.conversionIssues?.some((i) => i.includes("答案/评分章节"))).toBe(true);
    const dir = join(importRoot, draft.draftId);
    expect(readFileSync(join(dir, "page-1.txt"), "utf8")).toContain("参考答案：$x=0$");
    const review = svc.reviewQuestion(draft.draftId, 1);
    expect(review.sourceText).toContain("PDF 页面位图未提取");
    expect(review.sourceText).toContain("──── 第 2 页");
    expect(review.modelText).not.toContain("参考答案");

    // 缺位图 → 校验不通过；逐题编辑保存（人工核对路径）后仍受全局 completed 约束。
    expect(svc.check(draft.draftId).ok).toBe(false);
    for (const [index, text] of [[0, draft.questions[0]!.stem], [1, draft.questions[1]!.stem]] as const) {
      const r = svc.reviewQuestion(draft.draftId, index);
      svc.editQuestion(draft.draftId, index, r.digest, "stem", `${text}\n\n（已对照原PDF核对。）`);
    }
    expect(svc.check(draft.draftId).ok).toBe(true);
    const res = await svc.confirmDraft(draft.draftId);
    expect(existsSync(join(res.path, "source", "0-source-original.pdf"))).toBe(true);
  });

  it("跨页同一题的 box 按所在原始行记录页码（不整段记第一页），原文与公开题干内容不变", () => {
    const { questions } = convertOcrPages([
      { index: 0, text: "1. 如图，第一页内容。<｜ref｜>图甲<｜/ref｜><｜box｜>[[10,20,300,200]]<｜/box｜>", finishReason: "stop" },
      { index: 1, text: "第 1 题续（第二页）：<｜ref｜>图乙<｜/ref｜><｜box｜>[[40,50,600,700]]<｜/box｜>\n2. 下一题。", finishReason: "stop" },
    ], { sourceFile: "cross.pdf", sourceDigest: "digest-x", isPdf: true });
    expect(questions.map((q) => q.id)).toEqual(["q1", "q2"]);
    const q1 = questions[0]!;
    expect(q1.boxes).toEqual([
      { page: 0, ref: "图甲", box: [10, 20, 300, 200] },
      { page: 1, ref: "图乙", box: [40, 50, 600, 700] },
    ]);
    expect(q1.pages).toEqual([0, 1]);
    // 公开题干与逐行原文一致（坐标标记剥离、ref 文字保留）。
    expect(q1.stem).toBe("1. 如图，第一页内容。图甲\n第 1 题续（第二页）：图乙");
    const q2 = questions[1]!;
    expect(q2.boxes).toEqual([]);
    expect(q2.stem).toBe("2. 下一题。");
  });

  it("真实 DeepSeek 版式返回：每题号行带 <ref>结构标签</ref><box> 前缀时仍按题号拆分，公开题干剔除独立区域标签、boxes 完整保留", () => {
    const page = [
      "<｜ref｜>title<｜/ref｜><｜box｜>[[174,27,817,79]]<｜/box｜> 自写公开样卷：公式、表格与配图（OCR 测试用） ",
      "<｜ref｜>text<｜/ref｜><｜box｜>[[65,120,629,165]]<｜/box｜> 1. 已知二次函数 $f(x)=x^2-2x-3$，求其顶点坐标。 ",
      "<｜ref｜>text<｜/ref｜><｜box｜>[[87,179,597,221]]<｜/box｜> 配方法：$f(x)=(x-1)^2-4$，故顶点为 $(1,-4)$。 ",
      "<｜ref｜>text<｜/ref｜><｜box｜>[[65,269,615,313]]<｜/box｜> 2. 某班 5 名同学身高 (cm) 如下表，求平均身高。 ",
      "<｜ref｜>table<｜/ref｜><｜box｜>[[131,331,543,461]]<｜/box｜> <table><tr><td>同学</td><td>甲</td><td>乙</td></tr><tr><td>身高</td><td>160</td><td>170</td></tr></table>",
      "<｜ref｜>text<｜/ref｜><｜box｜>[[87,490,590,532]]<｜/box｜> 平均值 $\\bar{x}=\\frac{160+170}{2}=165$ (cm)。 ",
      "<｜ref｜>text<｜/ref｜><｜box｜>[[65,580,515,623]]<｜/box｜> 3. 如图，圆 $O$ 半径为 $r=2$，求面积。 ",
      "<｜ref｜>image<｜/ref｜><｜box｜>[[174,643,366,903]]<｜/box｜>  ",
      "<｜ref｜>image_caption<｜/ref｜><｜box｜>[[167,917,373,951]]<｜/box｜> <center>（配图：圆与半径示意）</center> ",
      "<｜ref｜>text<｜/ref｜><｜box｜>[[533,742,807,784]]<｜/box｜> 面积 $S=\\pi r^2=4\\pi$。",
    ].join("\n");
    const { questions, issues } = convertOcrPages(
      [{ index: 0, text: page, finishReason: "stop" }],
      { sourceFile: "real.png", sourceDigest: "digest-real", isPdf: false });
    expect(questions.map((q) => q.id)).toEqual(["q1", "q2", "q3"]);
    expect(issues.filter((i) => i.includes("未识别到明确题号行"))).toEqual([]);
    // 公开题干不含独立区域标签（英文结构词），坐标标记全部剥离。
    for (const q of questions) {
      expect(q.stem).not.toContain("<｜");
      expect(q.stem).not.toMatch(/(^|[\s（(])(text|title|table|image|image_caption|figure|header|footer)(?=$|[\s)）<])/);
    }
    // 表格 HTML 原样保留、不改写。
    expect(questions[1]!.stem).toContain("<table><tr><td>同学</td>");
    // boxes 完整保留，结构性 ref 原样留在证据里。
    expect(questions[0]!.boxes).toEqual([
      { page: 0, ref: "text", box: [65, 120, 629, 165] },
      { page: 0, ref: "text", box: [87, 179, 597, 221] },
    ]);
    expect(questions[1]!.boxes.map((b) => b.ref)).toEqual(["text", "table", "text"]);
    expect(questions[2]!.boxes.map((b) => b.ref)).toEqual(["text", "image", "image_caption", "text"]);
    // 自定义中文 ref 文本仍保留在公开题干（回归）。
    const custom = convertOcrPages(
      [{ index: 0, text: "1. 如图。<｜ref｜>圆与半径示意<｜/ref｜><｜box｜>[[60,380,420,620]]<｜/box｜>", finishReason: "stop" }],
      { sourceFile: "custom.png", sourceDigest: "digest-custom", isPdf: false });
    expect(custom.questions[0]!.stem).toContain("圆与半径示意");
  });

  it("partial（length 截断）/failed（402）/outcome_unknown（取消）都保留草稿、不能入库、绝不自动重试", async () => {
    // partial：截断页 → 状态 partial，confirm 拒绝。
    {
      const { datasetsRoot, importRoot } = fresh();
      let calls = 0;
      const svc = new ImportService(datasetsRoot, importRoot, () => ({ recognize: async () => { calls++; return ocrResult([
        { index: 0, text: "1. 第一题完整。", finishReason: "stop" },
        { index: 1, text: "2. 第二题被截断", finishReason: "length" },
      ]); } }));
      const png = await samplePng(datasetsRoot);
      const draft = await svc.importOcrSource(png, { datasetId: "partial-demo" });
      expect(draft.ocr?.status).toBe("partial");
      expect(calls).toBe(1);
      await expect(svc.confirmDraft(draft.draftId)).rejects.toThrow(/OCR 识别未完成/);
      expect(svc.getDraft(draft.draftId)?.ocr?.status).toBe("partial"); // 草稿保留
    }
    // failed：402 余额不足 → 确定失败，confirm 拒绝。
    {
      const { datasetsRoot, importRoot } = fresh();
      let calls = 0;
      const svc = new ImportService(datasetsRoot, importRoot, () => ({ recognize: async () => { calls++; throw new DeepSeekOcrError("insufficient_balance", "DeepSeek 账户余额不足（HTTP 402），识别被拒绝；没有自动重试。", false, { httpStatus: 402 }); } }));
      const png = await samplePng(datasetsRoot);
      const draft = await svc.importOcrSource(png, { datasetId: "failed-demo" });
      expect(draft.ocr?.status).toBe("failed");
      expect(draft.ocr?.error?.code).toBe("insufficient_balance");
      expect(draft.ocr?.error?.outcomeUnknown).toBe(false);
      expect(calls).toBe(1);
      await expect(svc.confirmDraft(draft.draftId)).rejects.toThrow(/OCR 识别未完成/);
    }
    // outcome_unknown：客户端取消 → 服务端可能继续计费，confirm 拒绝并提示核对供应商记录。
    {
      const { datasetsRoot, importRoot } = fresh();
      let calls = 0;
      const svc = new ImportService(datasetsRoot, importRoot, () => ({
        recognize: async (_path: string, opts?: { signal?: AbortSignal }) => new Promise<DeepSeekOcrResult>((_res, reject) => {
          calls++;
          opts?.signal?.addEventListener("abort", () => reject(new DeepSeekOcrError("cancelled", "DeepSeek OCR 请求已取消；上传可能已到达服务端并继续处理/计费，结果未知。", true)), { once: true });
        }),
      }));
      const png = await samplePng(datasetsRoot);
      const controller = new AbortController();
      const pending = svc.importOcrSource(png, { datasetId: "unknown-demo", signal: controller.signal });
      setTimeout(() => controller.abort(), 30);
      const draft = await pending;
      expect(calls).toBe(1);
      expect(draft.ocr?.status).toBe("outcome_unknown");
      expect(draft.ocr?.error?.outcomeUnknown).toBe(true);
      await expect(svc.confirmDraft(draft.draftId)).rejects.toThrow(/结果未知|OCR 识别未完成/);
    }
  });

  it("进程重启：running 草稿经 get/list 显示 outcome_unknown，不自动重发", () => {
    const { svc, importRoot } = fresh();
    const draftId = "draft-deadbeef";
    mkdirSync(join(importRoot, draftId), { recursive: true });
    const running: DraftDataset = {
      draftId, datasetId: "restart-demo", version: "1", status: "draft", format: "ocr",
      source: join(importRoot, "gone.png"), questions: [], warnings: [], createdAt: new Date().toISOString(),
      ocr: {
        sourcePath: join(importRoot, "gone.png"), sourceCopy: "source-original.png",
        sourceSha256: "0".repeat(64), purpose: "rich_layout_recognition", status: "running", startedAt: new Date().toISOString(),
      },
    };
    writeFileSync(join(importRoot, draftId, "draft.json"), JSON.stringify(running));
    const seen = svc.getDraft(draftId);
    expect(seen?.ocr?.status).toBe("outcome_unknown");
    expect(seen?.ocr?.error?.message).toContain("未自动重发");
    expect(svc.listDrafts().find((d) => d.draftId === draftId)?.ocr?.status).toBe("outcome_unknown");
    return expect(svc.confirmDraft(draftId)).rejects.toThrow(/OCR 识别未完成/);
  });
});

function freshRoot(): string {
  mkdirSync(resolve(".work"), { recursive: true });
  return mkdtempSync(resolve(".work", "ocr-md-"));
}

describe("TUI OCR 入口（ExamTui + 注入 OCR client）", () => {
  const tuiCfg = (root: string, factory: OcrClientFactory) => ({
    datasetsRoot: join(root, "datasets"), importRoot: join(root, ".import"), runsRoot: join(root, "runs"),
    workRoot: join(root, "work"), modelsConfigPath: "unused", toolsVersion: "v2-restricted", pythonInterpreter: "python",
    animation: false, ocrClientFactory: factory,
  });

  it("正常入口：startImport(PNG) 走异步 OCR，完成后进入导入预览并可入库", async () => {
    const { root } = fresh();
    const tui = new ExamTui(tuiCfg(root, () => ({ recognize: async () => ocrResult([{ index: 0, text: SAMPLE_PAGE }]) })));
    const png = await samplePng(root);
    tui.startImport(png, "tui-ocr");
    expect(tui.hasPendingImportOcr()).toBe(true);
    expect(tui.getState().message).toContain("OCR 识别中");
    await vi.waitFor(() => expect(tui.hasPendingImportOcr()).toBe(false));
    const screen = tui.getState().screen;
    expect(screen.kind).toBe("importPreview");
    expect(screen.kind === "importPreview" && screen.draft.ocr?.status).toBe("completed");
    await tui.confirmImport();
    expect(tui.getState().message).toContain("已入库 tui-ocr");
    tui.gotoBank();
    expect(tui.getState().screen.kind === "bank" && tui.getState().screen.datasets.map((d) => d.datasetId)).toContain("tui-ocr");
  });

  it("取消入口：cancelImportOcr 取消并保留结果未知草稿；stopAndWait 会先取消并等待存档", async () => {
    const { root } = fresh();
    let calls = 0;
    const tui = new ExamTui(tuiCfg(root, () => ({
      recognize: async (_path: string, opts?: { signal?: AbortSignal }) => {
        calls++;
        return new Promise<DeepSeekOcrResult>((_res, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new DeepSeekOcrError("cancelled", "已取消；上传可能已到达服务端并继续处理/计费，结果未知。", true)), { once: true });
        });
      },
    })));
    const png = await samplePng(root);
    tui.startImport(png, "tui-cancel");
    await vi.waitFor(() => expect(tui.hasPendingImportOcr()).toBe(true));
    expect(tui.cancelImportOcr()).toBe(true);
    await vi.waitFor(() => expect(tui.hasPendingImportOcr()).toBe(false));
    const screen = tui.getState().screen;
    expect(screen.kind).toBe("importPreview");
    expect(screen.kind === "importPreview" && screen.draft.ocr?.status).toBe("outcome_unknown");
    expect(tui.getState().message).toContain("没有自动重试");
    await tui.confirmImport();
    expect(tui.getState().message).toContain("不能入库");
    expect(calls).toBe(1); // 无自动重试

    // stopAndWait：取消进行中的 OCR 并等待存档。
    const tui2 = new ExamTui(tuiCfg(root, () => ({
      recognize: async (_path: string, opts?: { signal?: AbortSignal }) => new Promise<DeepSeekOcrResult>((_res, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new DeepSeekOcrError("cancelled", "已取消；结果未知。", true)), { once: true });
      }),
    })));
    const png2 = await samplePng(root);
    tui2.startImport(png2, "tui-stop");
    await vi.waitFor(() => expect(tui2.hasPendingImportOcr()).toBe(true));
    await tui2.stopAndWait();
    expect(tui2.hasPendingImportOcr()).toBe(false);
    const drafts = tui2.getImporter().listDrafts();
    expect(drafts.find((d) => d.datasetId === "tui-stop")?.ocr?.status).toBe("outcome_unknown");
  });

  it("Markdown 入口仍同步不变", async () => {
    const { root } = fresh();
    const tui = new ExamTui(tuiCfg(root, () => ({ recognize: async () => { throw new Error("OCR client must not be used for md"); } })));
    const src = join(root, "plain.md");
    writeFileSync(src, "## 1\nExplain gravity.\n", "utf8");
    tui.startImport(src, "tui-md");
    expect(tui.hasPendingImportOcr()).toBe(false);
    const screen = tui.getState().screen;
    expect(screen.kind).toBe("importPreview");
    expect(screen.kind === "importPreview" && screen.draft.format).toBe("markdown");
  });
});
