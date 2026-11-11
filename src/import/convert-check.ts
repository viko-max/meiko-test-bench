/**
 * Conversion check (Next_Plan §3 step 5): compare a staged draft against its
 * source and surface every problem a human must resolve before confirming —
 * empty stems, duplicate question numbers, incomplete scoring basis, LaTeX that
 * looks broken (unpaired $ / unterminated \frac), and referenced figures that
 * are missing from the source. The TUI shows this list; NOTHING is auto-repaired
 * (a wrong "fix" would silently change a question). Confirming is the human's
 * explicit decision after these are resolved or accepted.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { DraftDataset, DraftScoring } from "./import-service.js";
import { mixedScoringContent, publicQuestion, scoringSpec, validateImportId } from "./validation.js";
import { resolvePublicAttachment } from "../tools/paths.js";
import { ScoringSpecSchema } from "../shared/contracts.js";
import { assertScoring } from "../grading/scoring.js";
import { buildUserContent } from "../runner/prompt.js";

/** A scoring basis is complete only with a positive maxScore AND a reference. */
export function scoringComplete(s: DraftScoring | undefined): boolean {
  return !!s && s.maxScore !== undefined && Number.isFinite(s.maxScore) && s.maxScore > 0 &&
    ((typeof s.reference === "string" && !!s.reference.trim()) ||
    (!!s.reference && typeof s.reference === "object" && Object.keys(s.reference).length > 0) || (s.rubric?.length ?? 0) > 0);
}

export interface QuestionIssue {
  questionId: string;
  issues: string[];
}

export interface ConvertCheck {
  datasetId: string;
  questions: QuestionIssue[];
  issues: string[]; // dataset-level problems
  ok: boolean;
  warnings: string[];
}

/** Heuristic LaTeX sanity: unpaired inline `$`, or a `\frac{` with no closing. */
function formulaAnomalies(stem: string): string[] {
  const out: string[] = [];
  const dollars = (stem.match(/\$/g) ?? []).length;
  if (dollars % 2 !== 0) out.push("公式疑似不完整：$ 不成对");
  const openFrac = (stem.match(/\\frac\s*\{/g) ?? []).length;
  const pairs = (stem.match(/\}\s*\{/g) ?? []).length + (stem.match(/\}\s*[^}{]*$/g) ?? []).length;
  if (openFrac > 0 && openFrac > pairs) out.push("公式疑似不完整：\\frac 括号不匹配");
  return out;
}

export function checkDraft(draft: DraftDataset, opts: { sourceDir?: string } = {}): ConvertCheck {
  const questions: QuestionIssue[] = [];
  const datasetIssues: string[] = [...(draft.errors ?? [])];
  const warnings: string[] = [];
  const seen = new Set<string>();
  try { validateImportId(draft.datasetId); } catch (error) { datasetIssues.push((error as Error).message); }

  for (const q of draft.questions) {
    const issues: string[] = [];
    if (!q.stem.trim()) issues.push("题面为空");
    if (seen.has(q.id)) issues.push("题号重复（同名会互相覆盖，请修正来源）");
    seen.add(q.id);
    if (!scoringComplete(q.scoring)) warnings.push(`${q.id}: 缺少完整评分依据（未评分：可收集答卷，不计入正式分）`);
    try {
      publicQuestion(q);
      buildUserContent(publicQuestion(q));
      if (["single_choice", "multi_choice"].includes(q.answerKind) && Object.keys(q.options ?? {}).length < 2) issues.push("选择题缺少完整选项。");
      if (q.scoring) ScoringSpecSchema.omit({ questionId: true, questionVersion: true, answerKind: true }).partial().parse(q.scoring);
      if (scoringComplete(q.scoring)) {
        assertScoring(scoringSpec(q)!, publicQuestion(q));
      }
    } catch (error) { issues.push((error as Error).message); }
    issues.push(...(q.conversionIssues ?? []));
    if ([q.stem, ...Object.values(q.options ?? {}), ...(q.parts ?? []).map((part) => part.prompt)].some(mixedScoringContent)) issues.push("题面疑似混入答案或解析，请分离材料后重新导入。");
    issues.push(...formulaAnomalies(q.stem));
    if (opts.sourceDir || existsSync(q.sourceFile)) {
      for (const a of q.assets ?? []) {
        try { resolvePublicAttachment(dirname(q.sourceFile), a.ref); }
        catch (error) { issues.push(`缺图或附件路径无效：${a.ref} · ${(error as Error).message}`); }
      }
    }
    if (issues.length) questions.push({ questionId: q.id, issues });
  }

  if (draft.questions.length === 0) datasetIssues.push("未解析到任何题目（检查来源格式或拆分方式）");
  const dupCount = draft.questions.length - seen.size;
  if (dupCount > 0) datasetIssues.push(`${dupCount} 个重复题号`);

  return { datasetId: draft.datasetId, questions, issues: datasetIssues, warnings, ok: questions.length === 0 && datasetIssues.length === 0 };
}
