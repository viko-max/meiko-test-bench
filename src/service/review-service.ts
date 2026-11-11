/**
 * Human review service (REV-1 / P1-3/5). Connects the review queue, model-prelim
 * grader and human confirmation to a durable save + report rebuild. Reuses the
 * grading primitives (confirmGrade / gradeWithModel) and the durable grade store
 * (writeGradeFile, which preserves history). The TUI/Web call THIS — they never
 * re-derive grading or resume logic (AGENTS.md §3/§8).
 *
 * P1-3/5: the review queue and submitHuman use the ONE canonical valid-answer
 * loader (loadValidAnswers) — the SAME validated set the report uses. So a
 * content-changed / blocked answer can NEVER be reviewed or counted here ("续跑
 * 拒绝，报告和复核却接受" is impossible), and answers resumed from a PRIOR run dir
 * are reachable + written back to their real location. A human grade is recorded
 * against the CURRENT scoring basis (its maxScore + scoringVersion); out-of-range
 * scores are rejected; a stale human_confirmed grade re-enters the queue.
 */
import { GradeSchema, type AnswerMode, type Grade, type GradeItem, type ScoringSpec, type Trial } from "../shared/contracts.js";
import { gradeIsStale } from "../grading/grade.js";
import { assertScoring, scoringDigest } from "../grading/scoring.js";
import { confirmGrade, gradeWithModel, type GraderCompletion } from "../grading/model-grader.js";
import { writeGradeFile } from "../runner/archive.js";
import { loadValidAnswers, readManifest } from "../runner/answer-source.js";
import { readArchivedTrial } from "../runner/archive.js";
import { createHash } from "node:crypto";
import type { PublicQuestion } from "../shared/contracts.js";
import { join } from "node:path";
import { resolvePublicAttachment } from "../tools/paths.js";
import { loadQuestionImage, type QuestionImage } from "./question-image.js";
import { loadQuestionImages } from "../dataset/question-images.js";

export interface ReviewQueueItem {
  trialId: string;
  questionId: string;
  /** The run dir the trial actually lives in (may be a PRIOR resumed run). */
  sourceRunId: string;
  answerSheet: string | null;
  reviewStatus: string;
  currentGrade?: Grade;
  scoring?: ScoringSpec;
  question?: PublicQuestion;
  truncated?: boolean;
  reviewToken?: string;
}

export interface HumanDecision {
  score: number;
  reason: string;
  confirmer: string;
  expectedReviewToken?: string;
  items?: GradeItem[];
}

function reviewToken(trial: Trial, question: PublicQuestion | undefined, scoring: ScoringSpec, grade: Grade | undefined): string {
  return createHash("sha256").update(JSON.stringify({ trial, question, scoring, grade })).digest("hex");
}

export class ReviewService {
  constructor(private readonly runsRoot: string, private readonly datasetDir: string, private readonly datasetId: string) {}

  async loadImage(runId: string, mode: AnswerMode, trialId: string, assetIndex: number, expectedReviewToken: string, includeRuleGraded = false): Promise<QuestionImage> {
    const current = async () => {
      const item = (await this.getQueue(runId, mode, includeRuleGraded)).find((entry) => entry.trialId === trialId);
      if (!item || !expectedReviewToken || item.reviewToken !== expectedReviewToken) throw new Error("复核材料或图片已变化，请重新打开复核队列。");
      return item;
    };
    const item = await current();
    if (!Number.isSafeInteger(assetIndex) || assetIndex < 0) throw new Error("图片序号无效。");
    const asset = item.question?.assets[assetIndex];
    if (!asset || !asset.mediaType.startsWith("image/")) throw new Error("该附件不是可核对的图片。");
    const path = resolvePublicAttachment(join(this.datasetDir, "public"), asset.ref);
    const image = await loadQuestionImage(path, asset.ref);
    // 解码是异步操作，返回前再次核对材料，避免展示期间文件变化后继续评分。
    await current();
    return image;
  }

  /** Trials needing human review, from the run's VALID answer set (P1-3/5):
   *  completed, with a pending / model-preliminary / missing / STALE-human grade. */
  async getQueue(runId: string, mode: string, includeRuleGraded = false): Promise<ReviewQueueItem[]> {
    const va = await loadValidAnswers(this.runsRoot, runId, this.datasetDir, this.datasetId, mode as AnswerMode);
    const gradeByTrial = new Map(va.grades.map((g) => [g.trialId, g]));
    const out: ReviewQueueItem[] = [];
    for (const trial of va.trials) {
      if (trial.executionStatus !== "completed" || !trial.finalAnswerSheet) continue;
      const grade = gradeByTrial.get(trial.trialId);
      const scoring = va.scorings.get(trial.questionId);
      if (!scoring) continue;
      const staleHuman = grade && scoring ? gradeIsStale(grade, scoring) : false;
      const needsReview = !grade || grade.reviewStatus === "pending_human_review" || grade.reviewStatus === "model_preliminary" || staleHuman || (includeRuleGraded && grade.reviewStatus === "rule_graded");
      if (!needsReview) continue;
      out.push({
        trialId: trial.trialId,
        questionId: trial.questionId,
        sourceRunId: va.locations.get(trial.trialId)?.runId ?? runId,
        answerSheet: trial.finalAnswerSheet,
        reviewStatus: grade?.reviewStatus ?? "ungraded",
        ...(grade ? { currentGrade: grade } : {}),
        ...(scoring ? { scoring } : {}),
        question: va.questions.get(trial.questionId),
        truncated: trial.truncated,
        reviewToken: reviewToken(trial, va.questions.get(trial.questionId), scoring, grade),
      });
    }
    return out;
  }

  /** Record a human decision -> human_confirmed. P1-3/5: only a VALID (content-
   *  matched) answer from the run's canonical set can be reviewed; the grade is
   *  written back to the trial's REAL dir and carries the CURRENT basis. */
  async submitHuman(runId: string, trialId: string, decision: HumanDecision, mode: AnswerMode): Promise<Grade> {
    if (!decision.confirmer.trim() || !decision.reason.trim()) throw new Error("确认人与复核依据不能为空。");
    const va = await loadValidAnswers(this.runsRoot, runId, this.datasetDir, this.datasetId, mode);
    const trial: Trial | undefined = va.trials.find((t) => t.trialId === trialId);
    if (!trial) {
      throw new Error(`trial not found among ${runId}'s valid answers: ${trialId} (it may be blocked / content-changed / not in this mode)`);
    }
    const loc = va.locations.get(trialId);
    if (!loc) throw new Error(`no source location for ${trialId}`);
    if (trial.executionStatus !== "completed" || !trial.finalAnswerSheet?.trim()) throw new Error("只有已完成且有有效答卷的记录可以人工确认。");
    const scoring = va.scorings.get(trial.questionId);
    if (!scoring) {
      throw new Error(`no current scoring basis for ${trial.questionId}@${trial.questionVersion} — cannot record a human grade`);
    }
    if (!Number.isFinite(decision.score) || decision.score < 0 || decision.score > scoring.maxScore) {
      throw new Error(`score ${decision.score} out of range [0, ${scoring.maxScore}] for ${trial.questionId}@${trial.questionVersion}`);
    }
    assertScoring(scoring, va.questions.get(trial.questionId));
    const current = va.grades.find((grade) => grade.trialId === trialId);
    if (decision.expectedReviewToken && decision.expectedReviewToken !== reviewToken(trial, va.questions.get(trial.questionId), scoring, current)) {
      throw new Error("复核材料或已有评分已变化，请重新打开复核队列并检查后提交。");
    }
    const base: Grade =
      current && !gradeIsStale(current, scoring)
        ? current
        : GradeSchema.parse({
            gradeId: `${trialId}__base`,
            trialId,
            questionId: trial.questionId,
            scoringVersion: scoring.scoringVersion,
            scoringDigest: scoringDigest(scoring),
            graderKind: "rule",
            rawScore: 0,
            maxScore: scoring.maxScore,
            items: [],
            reviewStatus: "pending_human_review",
            createdAt: new Date().toISOString(),
          });
    if (decision.items) {
      const labels = new Set(va.questions.get(trial.questionId)?.parts?.map((part) => part.label) ?? []);
      if (decision.items.some((item) => item.partLabel && !labels.has(item.partLabel))) throw new Error("分项评分引用了不存在的小问。");
      if (scoring.rubric.length && (decision.items.length !== scoring.rubric.length || decision.items.some((item, i) => item.partLabel !== scoring.rubric[i]!.partLabel || item.points > scoring.rubric[i]!.points))) throw new Error("分项评分必须按评分细则顺序填写，且不能超过各项满分。");
    }
    const confirmed = confirmGrade({ ...base, maxScore: scoring.maxScore }, { by: decision.confirmer.trim(), score: decision.score, note: decision.reason.trim(), items: decision.items });
    writeGradeFile(this.runsRoot, loc.runId, loc.trialId, confirmed);
    return confirmed;
  }

  /** Ask an INDEPENDENT grader model for a preliminary score (model_preliminary,
   *  never auto-confirmed, never counted). Separate request from the answer model. */
  async modelPrelim(runId: string, trialId: string, graderComplete: GraderCompletion, mode?: AnswerMode): Promise<{ grade?: Grade; skipped?: string }> {
    const selected = mode ?? readManifest(this.runsRoot, runId)?.mode ?? readArchivedTrial(this.runsRoot, runId, trialId)?.trial.mode;
    if (!selected) return { skipped: `trial not found: ${trialId}` };
    const va = await loadValidAnswers(this.runsRoot, runId, this.datasetDir, this.datasetId, selected);
    const trial = va.trials.find((t) => t.trialId === trialId);
    const loc = va.locations.get(trialId);
    if (!trial || !loc || trial.executionStatus !== "completed") return { skipped: "answer blocked, incomplete or not in the requested run" };
    const question = va.questions.get(trial.questionId);
    const scoring = va.scorings.get(trial.questionId);
    if (!question || !scoring) return { skipped: "no current public question or scoring spec" };
    const currentGrade = va.grades.find((grade) => grade.trialId === trialId);
    if (currentGrade && !gradeIsStale(currentGrade, scoring) && ["rule_graded", "human_confirmed"].includes(currentGrade.reviewStatus)) return { skipped: "confirmed grade cannot be overwritten by a preliminary grade" };
    const token = reviewToken(trial, question, scoring, currentGrade);
    const checkCurrent = async () => {
      const latest = await loadValidAnswers(this.runsRoot, runId, this.datasetDir, this.datasetId, selected);
      const answer = latest.trials.find((item) => item.trialId === trialId);
      const basis = latest.scorings.get(trial.questionId);
      const location = latest.locations.get(trialId);
      if (!answer || !basis || location?.runId !== loc.runId || location.trialId !== loc.trialId || reviewToken(answer, latest.questions.get(trial.questionId), basis, latest.grades.find((grade) => grade.trialId === trialId)) !== token) throw new Error("初评期间题目、图片、答卷或评分已变化，结果未保存，请重新检查材料。");
    };
    let images;
    try {
      images = await loadQuestionImages(question, join(this.datasetDir, "public"));
      await checkCurrent();
    } catch (error) { return { skipped: (error as Error).message }; }
    const res = await gradeWithModel({ trial, question, scoring, graderComplete, questionImages: images });
    if (res.grade) {
      try { await checkCurrent(); } catch (error) { return { skipped: (error as Error).message }; }
      writeGradeFile(this.runsRoot, loc.runId, loc.trialId, res.grade);
    }
    return res;
  }
}
