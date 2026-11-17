/**
 * OCR result → staged DraftQuestion conversion (phase 1 /import). Faithfulness
 * rules: every page's raw recognised text is preserved VERBATIM in the private
 * OCR evidence (ocr-response.json + per-page text files in .import/<draftId>/);
 * the special <｜ref｜>…<｜/ref｜><｜box｜>[[x1,y1,x2,y2]]<｜/box｜> markers are
 * parsed into normalised (0..1000) coordinate evidence attached to each draft
 * question. Draft stems keep the recognised wording (markers stripped, ref text
 * kept); STRUCTURAL region labels (text/title/table/image/…) are dropped from
 * the public stem but survive verbatim in boxes.ref and the private raw OCR
 * evidence; formulas / tables are NOT rewritten. Questions split only on explicit
 * sequential question-number lines; without them the whole text stays ONE
 * question flagged for review. Answers are never guessed and scoring is never
 * auto-completed — a recognised answer/scoring section is CUT from the public
 * stem and only survives in the private OCR evidence.
 */
import { parseOptionsFromBody } from "../dataset/parse.js";
import type { DraftQuestion } from "./import-service.js";

export interface OcrBox {
  page: number;
  ref: string;
  box: [number, number, number, number];
}

export interface OcrPageInput {
  index: number;
  text: string;
  finishReason: "stop" | "length";
}

const BOX_TOKEN = /<｜ref｜>([\s\S]*?)<｜\/ref｜><｜box｜>\[\[\s*(\d{1,4})[，,]\s*(\d{1,4})[，,]\s*(\d{1,4})[，,]\s*(\d{1,4})\s*\]\]<｜\/box｜>/g;

/**
 * DeepSeek 版式识别返回的结构性区域标签：只描述区块类型，不是正文措辞。
 * 公开题干剔除这些标签（盒子证据 boxes.ref 与原始 OCR 证据原样保留）；
 * 其余 ref 文本（如自定义中文标注）视为正文保留。集合可扩展。
 */
const STRUCTURAL_REFS = new Set(["text", "title", "table", "image", "image_caption", "figure", "header", "footer"]);

export interface ParsedOcrText {
  /** Text with coordinate markers removed; structural region labels dropped; custom ref wording kept. */
  clean: string;
  boxes: Array<{ ref: string; box: [number, number, number, number] }>;
  /** True when unparseable <｜…｜> markers remain. */
  leftoverMarkers: boolean;
}

export function parseOcrText(text: string): ParsedOcrText {
  const boxes: Array<{ ref: string; box: [number, number, number, number] }> = [];
  const clean = text.replace(BOX_TOKEN, (_all, ref: string, x1: string, y1: string, x2: string, y2: string) => {
    const coord = [Number(x1), Number(y1), Number(x2), Number(y2)] as [number, number, number, number];
    boxes.push({ ref, box: coord.every((v) => v >= 0 && v <= 1000) ? coord : [0, 0, 0, 0] });
    return STRUCTURAL_REFS.has(ref) ? "" : ref;
  });
  return { clean, boxes, leftoverMarkers: clean.includes("<｜") };
}

/** 疑似答案/评分章节标题行：命中即把公共题干截断到该标题之前。 */
const ANSWER_HEAD = /^\s*(?:【)?\s*(参考答案|标准答案|答案与解析|答案及解析|参考解答|答案解析|评分标准|评分细则|答案|解答|解析)\s*(?:】)?\s*(?:[:：]|$)/;

/** 明确题号行：仅接受从 1 开始的连续递增编号，避免把题内编号列表误切。 */
function questionNumber(line: string): number | undefined {
  const m = line.match(/^\s*(?:(?:第\s*(\d{1,3})\s*题)|(\d{1,3}))\s*[.、．:：]\s*(?:\S|$)/);
  if (!m) return undefined;
  const n = Number(m[1] ?? m[2]);
  return Number.isSafeInteger(n) && n >= 1 && n <= 999 ? n : undefined;
}

export interface OcrConversion {
  questions: DraftQuestion[];
  /** Dataset-level issues that belong in draft.errors / check issues. */
  issues: string[];
}

export interface OcrConvertOptions {
  sourceFile: string;
  sourceDigest: string;
  /** PDF sources: page bitmaps are NOT extracted; questions are flagged. */
  isPdf: boolean;
  /** Accessible ordinary image source: shared original attached as figure. */
  sharedImage?: { ref: string; mediaType: string };
}

export function convertOcrPages(pages: OcrPageInput[], opts: OcrConvertOptions): OcrConversion {
  const issues: string[] = [];
  interface Line { page: number; text: string; finishReason: "stop" | "length" }
  const lines: Line[] = pages.flatMap((page) =>
    page.text.split(/\r?\n/).map((text) => ({ page: page.index, text, finishReason: page.finishReason })));
  // 题号检测基于剥离坐标标记与结构区域标签后的行文本（真实返回每行带
  // <｜ref｜>text<｜/ref｜><｜box｜> 前缀）；坐标仍按原始行/页归属。
  const strippedLines = lines.map((line) => parseOcrText(line.text).clean.trim());

  // 1) 按连续明确题号行分段；无明确题号 → 单题并标记核对。
  const boundaries: Array<{ line: number; number: number }> = [];
  let expected = 1;
  lines.forEach((line, i) => {
    const n = questionNumber(strippedLines[i]!);
    if (n === undefined) return;
    if (n === expected) { boundaries.push({ line: i, number: n }); expected++; }
  });
  let segments: Array<{ number: number | null; lines: Line[] }>;
  if (boundaries.length === 0) {
    segments = [{ number: null, lines }];
    issues.push("未识别到明确题号行：整份识别文本作为单题，请逐题核对拆分。");
  } else {
    segments = boundaries.map((boundary, i) => ({
      number: boundary.number,
      lines: lines.slice(boundary.line, boundaries[i + 1]?.line ?? lines.length),
    }));
  }

  const emptyPages = new Set(pages.filter((page) => !page.text.trim()).map((page) => page.index));
  const truncatedPages = new Set(pages.filter((page) => page.finishReason === "length").map((page) => page.index));

  const questions: DraftQuestion[] = segments.map((segment, i) => {
    const conversionIssues: string[] = [];
    // 2) 疑似答案/评分章节：公共题干截断，原始内容只留在独立 OCR 证据。
    let stemLines = segment.lines;
    const cut = stemLines.findIndex((line) => ANSWER_HEAD.test(line.text));
    if (cut >= 0) {
      const heading = stemLines[cut]!.text.trim();
      stemLines = stemLines.slice(0, cut);
      conversionIssues.push(`识别文本包含疑似答案/评分章节（${heading}），公共题干已截断；原始内容仅保留在独立 OCR 证据，评分默认不完整。`);
    }
    // 3) 逐行解析坐标证据：box 归属按所在原始行的页码（跨页段落不能整段记第一页）；题干保留识别文字（去掉坐标标记，结构性区域标签 text/title/table/… 从公开题干剔除，boxes.ref 与原始 OCR 证据原样保留）。
    const parsedLines = stemLines.map((line) => parseOcrText(line.text));
    const stem = parsedLines.map((parsed) => parsed.clean).join("\n").trim();
    if (parsedLines.some((parsed) => parsed.leftoverMarkers)) conversionIssues.push("存在无法解析的 OCR 坐标标记，请对照原件核对。");
    const pageIndexes = [...new Set(segment.lines.map((line) => line.page))];
    const boxes: OcrBox[] = [];
    parsedLines.forEach((parsed, lineIndex) => {
      const page = stemLines[lineIndex]!.page;
      for (const box of parsed.boxes) boxes.push({ page, ...box });
    });
    for (const page of pageIndexes) {
      if (truncatedPages.has(page)) conversionIssues.push(`第 ${page + 1} 页识别被截断（finish_reason=length），请对照原件补全。`);
      if (emptyPages.has(page)) conversionIssues.push(`第 ${page + 1} 页识别为空，请对照原件。`);
    }
    if ((stem.match(/\$/g) ?? []).length % 2 !== 0) conversionIssues.push("公式疑似异常（$ 不成对），请对照原件核对。");
    if (/(?:如右?图|右?图所示|见图|图\s*\d+)/.test(stem) && boxes.length === 0) {
      conversionIssues.push("题面提及配图但识别未返回坐标证据，疑似漏图，请对照原件。");
    }
    if (opts.isPdf) conversionIssues.push("PDF 页面位图未提取，请对照原PDF核对题面与配图。");
    const options = parseOptionsFromBody(stem);
    const hasOptions = Object.keys(options).length >= 2;
    return {
      id: segment.number === null ? `q${i + 1}` : `q${segment.number}`,
      version: "1",
      subject: "general",
      answerKind: hasOptions ? "single_choice" : "open",
      stem,
      ...(hasOptions ? { options } : {}),
      ...(opts.sharedImage ? { assets: [{ ref: opts.sharedImage.ref, mediaType: opts.sharedImage.mediaType, role: "figure", alt: "OCR 来源原图（共享原件，供核对）" }] } : {}),
      pages: pageIndexes,
      boxes,
      conversionIssues,
      sourceFile: opts.sourceFile,
      sourceDigest: opts.sourceDigest,
    };
  });

  const seen = new Set<string>();
  for (const question of questions) {
    if (seen.has(question.id)) issues.push(`重复题号：${question.id}（识别文本题号重复，请核对原件）`);
    seen.add(question.id);
  }
  return { questions, issues };
}
