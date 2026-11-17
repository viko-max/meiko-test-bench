/**
 * 第二阶段决策模型离线样本评估（AGENTS.md §12）。完全离线：provider 行为由
 * 注入的 runner 模拟（tests/fixtures/decision/review-samples.json 为自写公开样本）。
 * 样本按 questionGroup 稳定划分 dev/validation，同一组的样本绝不跨 split。
 *
 * 指标只报告、不自动确认：falseExplicitRate（人工判定非明确却被判明确）、
 * evidenceExactRate（期望证据被精确定位且 quote 与原文完全一致）、
 * optionsExact（题面选项：multiChoices 直出；为 null 时按 decision-review 相同
 * 边界规则从已验证 extract/span 证据推导 A..Z；profile 完全无证据能力时记不适用、
 * 绝不虚报 0）、humanReviewCoverage（完成且仍标注需人工复核的占比——决策辅助永远不自动采信）。
 */
import { sha256OfText, type HexSha256 } from "../shared/hashing.js";
import type { DecisionEvidence, DecisionProviderProfile, DecisionUsage } from "../shared/decision.js";
import { evidenceSupportsOption, verifyExtractEvidence, verifySpanEvidence } from "./decision-review.js";
import type { ExtractSpan, SpanSpan } from "../providers/systemone.js";

export interface DecisionSample {
  /** 同组样本共享同一 split；组是题目/材料维度的稳定单位。 */
  questionGroup: string;
  /** 待评估的答卷原文。 */
  answer: string;
  /** 人工结论：明确 / 非明确。 */
  expectedConclusion: "explicit" | "non-explicit";
  /** 人工确认的题面选项（多选如 ["A","J"]；无选项题为空）。 */
  expectedOptions: string[];
  /** 人工确认的原文证据（必须与原文完全一致的片段）。 */
  expectedEvidence: string[];
  /** 该样本的人工标注是否已确认（未确认样本不计入 falseExplicit 分母）。 */
  humanConfirmed: boolean;
}

/** 模拟 provider 的一次决策输出（原始、未做证据定位校验）。 */
export interface SimulatedDecisionRun {
  model: string;
  choice: "explicit_single" | "explicit_multiple" | "no_conclusion" | "insufficient_evidence" | null;
  /** 模拟 multi-choice（profile 无该能力时给 null）。 */
  multiChoices: string[] | null;
  /** 模拟蚂蚁 extract spans（offset 编码不明，交由校验器解析）。 */
  extractSpans: ExtractSpan[] | null;
  extractTruncated?: boolean;
  /** 模拟象信 span spans（码点左闭右开）。 */
  spanSpans: SpanSpan[] | null;
  noul: number | null;
  latencyMs: number;
  usage: DecisionUsage;
  warnings?: string[];
}

export type DecisionSampleRunner = (sample: DecisionSample, profile: DecisionProviderProfile) => Promise<SimulatedDecisionRun>;

export type DecisionSplit = "dev" | "validation";

/** 按 questionGroup 稳定划分：同一组永远落在同一 split。 */
export function splitForGroup(questionGroup: string): DecisionSplit {
  const digest: HexSha256 = sha256OfText(`decision-split:${questionGroup}`);
  return parseInt(digest.slice(0, 2), 16) % 2 === 0 ? "dev" : "validation";
}

export function splitSamples(samples: DecisionSample[]): Record<DecisionSplit, DecisionSample[]> {
  const out: Record<DecisionSplit, DecisionSample[]> = { dev: [], validation: [] };
  for (const sample of samples) out[splitForGroup(sample.questionGroup)].push(sample);
  return out;
}

export interface DecisionEvalThresholds {
  falseExplicitRateMax?: number;
  evidenceExactRateMin?: number;
  humanReviewCoverageMin?: number;
}

export interface DecisionEvalSplitMetrics {
  count: number;
  failedRuns: number;
  falseExplicit: { count: number; denominator: number; rate: number | null; thresholdMax?: number; thresholdMet?: boolean };
  evidenceExact: { matched: number; total: number; rate: number | null; thresholdMin?: number; thresholdMet?: boolean };
  optionsExact: { matched: number; total: number; rate: number | null; /** profile 完全无证据能力（无 extract/span）且 multiChoices=null：该指标不适用，绝不虚报 0。 */
    notApplicable?: boolean };
  /** 完成且仍标注需人工复核（needsHumanReview）的样本占比；决策辅助永不自动采信。 */
  humanReviewCoverage: { covered: number; count: number; rate: number | null; thresholdMin?: number; thresholdMet?: boolean };
  avgLatencyMs: number | null;
  usage: DecisionUsage;
}

export interface DecisionEvaluationReport {
  generatedAt: string;
  splits: { dev: number; validation: number; groups: { dev: number; validation: number } };
  /** 阈值只报告达标与否，不触发任何自动确认。 */
  thresholds?: DecisionEvalThresholds;
  providers: Array<{
    profileId: string;
    displayName: string;
    requestedModel: string;
    dev: DecisionEvalSplitMetrics;
    validation: DecisionEvalSplitMetrics;
  }>;
}

function emptyMetrics(): DecisionEvalSplitMetrics {
  return {
    count: 0, failedRuns: 0,
    falseExplicit: { count: 0, denominator: 0, rate: null },
    evidenceExact: { matched: 0, total: 0, rate: null },
    optionsExact: { matched: 0, total: 0, rate: null },
    humanReviewCoverage: { covered: 0, count: 0, rate: null },
    avgLatencyMs: null,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

/** 校验模拟证据定位，返回精确定位成功的证据（含 quote 与位置）。 */
function localizedEvidence(sample: DecisionSample, run: SimulatedDecisionRun): DecisionEvidence[] {
  const evidence: DecisionEvidence[] = [];
  if (run.extractSpans) {
    for (const span of run.extractSpans) {
      if (run.extractTruncated) continue;
      const verified = verifyExtractEvidence(sample.answer, span);
      if (verified.ok) evidence.push(verified.evidence);
    }
  }
  if (run.spanSpans) {
    for (const span of run.spanSpans) {
      const verified = verifySpanEvidence(sample.answer, span);
      if (verified.ok) evidence.push(verified.evidence);
    }
  }
  return evidence;
}

/** 题面 A..Z 选项标签（评估样本无题面 stem，候选全集即单字母标签）。 */
const STEM_OPTION_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function sameOptions(selected: string[], expected: string[]): boolean {
  return selected.length === expected.length && selected.every((o) => expected.includes(o));
}

/**
 * 离线评估：对每个 provider 的每个样本运行注入的 runner，计算指标。
 * runner 抛错按失败运行计入（failedRuns），不进入比率分母之外的分母。
 */
export async function evaluateDecisionSamples(
  samples: DecisionSample[],
  providers: Array<{ profile: DecisionProviderProfile; runner: DecisionSampleRunner }>,
  opts: { thresholds?: DecisionEvalThresholds; now?: string } = {},
): Promise<DecisionEvaluationReport> {
  const bySplit = splitSamples(samples);
  const groups = new Map<string, DecisionSplit>();
  for (const sample of samples) groups.set(sample.questionGroup, splitForGroup(sample.questionGroup));
  const providersOut: DecisionEvaluationReport["providers"] = [];
  for (const { profile, runner } of providers) {
    const metrics: Record<DecisionSplit, DecisionEvalSplitMetrics> = { dev: emptyMetrics(), validation: emptyMetrics() };
    const latencySum: Record<DecisionSplit, number> = { dev: 0, validation: 0 };
    const latencyCount: Record<DecisionSplit, number> = { dev: 0, validation: 0 };
    for (const sample of samples) {
      const split = splitForGroup(sample.questionGroup);
      const m = metrics[split];
      m.count += 1;
      let run: SimulatedDecisionRun;
      try {
        run = await runner(sample, profile);
      } catch {
        m.failedRuns += 1;
        continue;
      }
      latencySum[split] += run.latencyMs;
      latencyCount[split] += 1;
      m.usage.inputTokens += run.usage.inputTokens;
      m.usage.outputTokens += run.usage.outputTokens;
      m.usage.totalTokens += run.usage.totalTokens;
      // 完成且仍是辅助（needsHumanReview 恒真）→ 计入人工覆盖。
      m.humanReviewCoverage.covered += 1;
      m.humanReviewCoverage.count += 1;
      const judgedExplicit = run.choice === "explicit_single" || run.choice === "explicit_multiple";
      if (sample.humanConfirmed && sample.expectedConclusion === "non-explicit") {
        m.falseExplicit.denominator += 1;
        if (judgedExplicit) m.falseExplicit.count += 1;
      }
      if (sample.expectedEvidence.length) {
        const evidence = localizedEvidence(sample, run);
        for (const expected of sample.expectedEvidence) {
          m.evidenceExact.total += 1;
          if (evidence.some((e) => e.quote === expected)) m.evidenceExact.matched += 1;
        }
      }
      if (sample.expectedOptions.length) {
        if (run.multiChoices !== null && run.multiChoices !== undefined) {
          // provider 直接给出选项（蚂蚁 multi-choice）。
          m.optionsExact.total += 1;
          if (sameOptions(run.multiChoices, sample.expectedOptions)) m.optionsExact.matched += 1;
        } else if (profile.capabilities.includes("extract") || profile.capabilities.includes("span")) {
          // multiChoices=null（如象信无 multi-choice）：与 decision-review 相同边界规则，
          // 只接受有已验证原文证据支持的 A..Z 选项，从证据推导。
          m.optionsExact.total += 1;
          const evidence = localizedEvidence(sample, run);
          const derived = STEM_OPTION_LABELS.filter((label) => evidenceSupportsOption(evidence, label));
          if (sameOptions(derived, sample.expectedOptions)) m.optionsExact.matched += 1;
        } else {
          // profile 既无 multi-choice 又无 extract/span：无证据可用，该指标不适用（不虚报 0）。
          m.optionsExact.notApplicable = true;
        }
      }
    }
    for (const split of ["dev", "validation"] as const) {
      const m = metrics[split];
      m.falseExplicit.rate = m.falseExplicit.denominator ? m.falseExplicit.count / m.falseExplicit.denominator : null;
      m.evidenceExact.rate = m.evidenceExact.total ? m.evidenceExact.matched / m.evidenceExact.total : null;
      m.optionsExact.rate = m.optionsExact.total ? m.optionsExact.matched / m.optionsExact.total : null;
      m.humanReviewCoverage.rate = m.count ? m.humanReviewCoverage.covered / m.count : null;
      m.avgLatencyMs = latencyCount[split] ? latencySum[split] / latencyCount[split] : null;
      if (opts.thresholds) {
        const t = opts.thresholds;
        if (t.falseExplicitRateMax !== undefined && m.falseExplicit.rate !== null) {
          m.falseExplicit.thresholdMax = t.falseExplicitRateMax;
          m.falseExplicit.thresholdMet = m.falseExplicit.rate <= t.falseExplicitRateMax;
        }
        if (t.evidenceExactRateMin !== undefined && m.evidenceExact.rate !== null) {
          m.evidenceExact.thresholdMin = t.evidenceExactRateMin;
          m.evidenceExact.thresholdMet = m.evidenceExact.rate >= t.evidenceExactRateMin;
        }
        if (t.humanReviewCoverageMin !== undefined && m.humanReviewCoverage.rate !== null) {
          m.humanReviewCoverage.thresholdMin = t.humanReviewCoverageMin;
          m.humanReviewCoverage.thresholdMet = m.humanReviewCoverage.rate >= t.humanReviewCoverageMin;
        }
      }
    }
    providersOut.push({
      profileId: profile.id, displayName: profile.displayName, requestedModel: profile.model,
      dev: metrics.dev, validation: metrics.validation,
    });
  }
  return {
    generatedAt: opts.now ?? new Date().toISOString(),
    splits: {
      dev: bySplit.dev.length,
      validation: bySplit.validation.length,
      groups: {
        dev: [...groups.values()].filter((s) => s === "dev").length,
        validation: [...groups.values()].filter((s) => s === "validation").length,
      },
    },
    ...(opts.thresholds ? { thresholds: opts.thresholds } : {}),
    providers: providersOut,
  };
}
