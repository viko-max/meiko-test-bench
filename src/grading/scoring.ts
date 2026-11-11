import { ScoringSpecSchema, type PublicQuestion, type ScoringSpec } from "../shared/contracts.js";
import { sha256OfJsonable } from "../shared/hashing.js";

export function scoringDigest(scoring: ScoringSpec): string {
  return sha256OfJsonable(ScoringSpecSchema.parse(scoring));
}

export function assertScoring(scoring: ScoringSpec, question?: PublicQuestion): void {
  const checked = ScoringSpecSchema.parse(scoring);
  if (checked.rubric.length && Math.abs(checked.rubric.reduce((sum, item) => sum + item.points, 0) - checked.maxScore) > 1e-8) {
    throw new Error(`评分细则分值之和与满分不一致 (${checked.rubric.reduce((sum, item) => sum + item.points, 0)} != maxScore ${checked.maxScore})。`);
  }
  if (!question) return;
  if (checked.questionId !== question.id || checked.questionVersion !== question.version || checked.answerKind !== question.answerKind) {
    throw new Error("评分与题面的题号、版本或题型不一致。");
  }
  if (checked.answerKind === "single_choice") {
    const optionLabels = new Set(Object.keys(question.options ?? {}).map((label) => label.toUpperCase()));
    for (const alternative of checked.acceptableAlternatives) {
      const label = alternative.trim().toUpperCase();
      if (/^[A-Z]$/.test(label) && !optionLabels.has(label)) throw new Error(`可接受答案引用了不存在的选项 ${label}。`);
    }
  }
  const labels = (question.parts ?? []).map((part) => part.label);
  if (new Set(labels).size !== labels.length) throw new Error("小问标签重复。");
  if (checked.rubric.some((item) => item.partLabel && !labels.includes(item.partLabel))) throw new Error("评分细则引用了不存在的小问。");
}
