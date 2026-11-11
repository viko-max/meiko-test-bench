/**
 * Faithful presentation of a PublicQuestion as the user turn (AGENTS.md §5).
 * Preserves original text, formulas (LaTeX), options and sub-questions; adds no
 * hints, conditions, or answers. Images are attached separately by the runner
 * (both modes receive the original figures directly, not as a tool call).
 */
import { assertNoScoringLeak, assertPublicAssetsClean, PublicQuestionSchema, type PublicQuestion } from "../shared/contracts.js";
import { ContractError } from "../shared/errors.js";
import { parseOptionsFromBody } from "../dataset/parse.js";
import { sha256OfJsonable } from "../shared/hashing.js";

export function buildUserContent(q: PublicQuestion): string {
  assertNoScoringLeak(q);
  const checked = PublicQuestionSchema.safeParse(q);
  if (!checked.success) throw new ContractError(`公开题面校验失败：${checked.error.message}`);
  q = checked.data;
  assertPublicAssetsClean(q);
  const lines: string[] = [];
  lines.push(`# Question (${q.subject})`);
  lines.push("");
  lines.push(q.stem.trim());

  const bodyOptions = parseOptionsFromBody(q.stem);
  const hasBodyOptions = Object.keys(bodyOptions).length > 0;
  if (hasBodyOptions && q.options && sha256OfJsonable(bodyOptions) !== sha256OfJsonable(q.options)) {
    throw new ContractError("正文选项与结构化选项不一致，请核对题目。");
  }
  if (!hasBodyOptions && q.options && Object.keys(q.options).length > 0) {
    lines.push("");
    lines.push("## Options");
    for (const [label, text] of Object.entries(q.options)) {
      lines.push(`- ${label}. ${text}`);
    }
  }

  if (q.parts && q.parts.length > 0) {
    lines.push("");
    lines.push("## Sub-questions");
    for (const part of q.parts) {
      lines.push(`- (${part.label}) ${part.prompt}`);
    }
  }

  if (q.assets.length > 0) {
    const figs = q.assets.filter((a) => a.role === "figure" || a.mediaType.startsWith("image/"));
    if (figs.length > 0) {
      lines.push("");
      lines.push(`_This question includes ${figs.length} figure(s), provided as image(s) with this message._`);
    }
  }

  return lines.join("\n");
}
