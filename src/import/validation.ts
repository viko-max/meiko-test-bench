import { unified } from "unified";
import remarkParse from "remark-parse";
import { PublicQuestionSchema, ScoringSpecSchema, IdentifierSchema, assertPublicAssetsClean, type PublicQuestion, type ScoringSpec } from "../shared/contracts.js";
import { mediaTypeForRef } from "../dataset/parse.js";
import type { DraftQuestion } from "./import-service.js";

export function validateImportId(value: string): string {
  IdentifierSchema.parse(value);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) || value.endsWith(".")) throw new Error(`不支持的文件标识：${value}`);
  return value;
}

export function publicQuestion(q: DraftQuestion): PublicQuestion {
  validateImportId(q.id);
  const assets = (q.assets ?? []).map((asset) => {
    const expected = mediaTypeForRef(asset.ref);
    if (expected && asset.mediaType && expected !== asset.mediaType) throw new Error(`附件类型不匹配：${asset.ref}`);
    return { ...asset, role: asset.role ?? "figure", mediaType: asset.mediaType ?? expected ?? "" };
  });
  const question = PublicQuestionSchema.parse({ id: q.id, version: q.version, subject: q.subject, answerKind: q.answerKind,
    stem: q.stem, options: q.options, parts: q.parts, assets, language: q.language, tags: q.tags });
  assertPublicAssetsClean(question);
  return question;
}

export function scoringSpec(q: DraftQuestion): ScoringSpec | undefined {
  if (!q.scoring) return undefined;
  return ScoringSpecSchema.parse({ ...q.scoring, questionId: q.id, questionVersion: q.version,
    scoringVersion: q.scoring.scoringVersion ?? "1", answerKind: q.answerKind });
}

// 只标记疑似评分材料，不猜测分离位置，也不自动删除来源内容。
export function mixedScoringContent(text: string): boolean {
  type Node = { type: string; value?: string; children?: Node[] };
  const tree = unified().use(remarkParse).parse(text) as unknown as Node;
  const plain = (node: Node): string => node.value ?? (node.children ?? []).map(plain).join("");
  const marker = /^(?:【)?(?:参考答案|标准答案|答案|参考解答|解答|解析|评分标准|answer(?:\s+key)?|solution|explanation|rubric)(?:】)?\s*(?:[:：]|$)/i;
  const visit = (node: Node): boolean =>
    (["heading", "paragraph", "code"].includes(node.type) && plain(node).split(/\r?\n/).some((line) => marker.test(line.trim()))) ||
    (node.children ?? []).some(visit);
  return visit(tree);
}
