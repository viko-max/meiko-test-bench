import { z } from "zod";
import { GradeSchema, type PublicQuestion, type ScoringSpec, type Trial } from "../shared/contracts.js";
import { buildGraderPrompt } from "./model-grader.js";
import { shortDigest } from "../shared/hashing.js";
import { assertScoring, scoringDigest } from "./scoring.js";

export const STRUCTURED_JUDGE_VERSION = "judge-rubric-v1";
const ReplySchema = z.object({ score: z.number().finite().nonnegative(), items: z.array(z.object({
  rubricIndex: z.number().int().nonnegative(), points: z.number().finite().nonnegative(),
  evidence: z.string().trim().min(1), note: z.string().optional(),
}).strict()).min(1) }).strict();

export function assertJudgeScoring(scoring: ScoringSpec): void {
  assertScoring(scoring);
}

export function structuredJudgePrompt(question: PublicQuestion, scoring: ScoringSpec, answer: string): string {
  assertJudgeScoring(scoring);
  const materials = buildGraderPrompt(question, scoring, answer, true);
  return [`Protocol: ${STRUCTURED_JUDGE_VERSION}`, materials,
    'Reply with only valid JSON: {"score":0,"items":[{"rubricIndex":0,"points":0,"evidence":"exact excerpt from student answer","note":"reason"}]}',
    `Return exactly ${scoring.rubric.length || 1} items, one per rubric entry in original order, indexed from zero. Without a rubric, return one total-score item.`,
    "Each evidence must be an exact nonempty excerpt from the student answer, including for zero credit. Explain the decision in note; do not invent quotes.",
    "Item points must stay within that item's maximum; their sum must equal score. No markdown fences, extra keys or text.",
  ].join("\n");
}

export function structuredJudgeGrade(raw: string, trial: Trial, scoring: ScoringSpec, identity: string) {
  assertJudgeScoring(scoring);
  const reply = ReplySchema.parse(JSON.parse(raw));
  const maxima = scoring.rubric.length ? scoring.rubric.map((item) => item.points) : [scoring.maxScore];
  if (reply.score > scoring.maxScore || reply.items.length !== maxima.length || reply.items.some((item, index) =>
    item.rubricIndex !== index || item.points > maxima[index]! || !trial.finalAnswerSheet?.includes(item.evidence)) ||
    Math.abs(reply.items.reduce((sum, item) => sum + item.points, 0) - reply.score) > 1e-8) {
    throw new Error("裁判分项、总分或答卷原文证据不符合要求，结果保留人工检查。");
  }
  return GradeSchema.parse({ gradeId: `${trial.trialId}__judge__${shortDigest({ protocol: STRUCTURED_JUDGE_VERSION, identity, scoring, reply })}`,
    trialId: trial.trialId, questionId: trial.questionId, scoringVersion: scoring.scoringVersion, scoringDigest: scoringDigest(scoring),
    graderKind: "model", rawScore: reply.score, maxScore: scoring.maxScore, reviewStatus: "model_preliminary",
    items: reply.items.map((item, i) => ({ points: item.points, evidence: item.evidence,
      ...(scoring.rubric[i]?.partLabel ? { partLabel: scoring.rubric[i]!.partLabel } : {}),
      note: `${item.note ?? ""} | ${STRUCTURED_JUDGE_VERSION} · 未经人工确认` })), createdAt: new Date().toISOString() });
}
