import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  evaluateDecisionSamples,
  splitForGroup,
  splitSamples,
  type DecisionSample,
  type SimulatedDecisionRun,
} from "../src/service/decision-evaluation.js";
import { ANT_DECISION_PROFILE, XIANGXIN_DECISION_PROFILE } from "../src/shared/decision.js";

const fixture = JSON.parse(readFileSync(join(resolve("tests"), "fixtures", "decision", "review-samples.json"), "utf8")) as { samples: DecisionSample[] };
const samples = fixture.samples;

describe("decision-evaluation 样本与划分", () => {
  it("自写公开样本 ≥10 个、≥5 个 questionGroup，字段完整且证据确实来自答卷", () => {
    expect(samples.length).toBeGreaterThanOrEqual(10);
    const groups = new Set(samples.map((s) => s.questionGroup));
    expect(groups.size).toBeGreaterThanOrEqual(5);
    // 覆盖：清晰单选、提及后排除、A和J多选、无结论、数值与单位、emoji/中文 Unicode
    expect(groups).toEqual(expect.objectContaining({}));
    for (const required of ["single-choice-basic", "mention-exclude", "multi-select-aj", "no-conclusion", "numeric-unit", "unicode-emoji"]) {
      expect(groups.has(required), `缺少覆盖组 ${required}`).toBe(true);
    }
    for (const s of samples) {
      expect(["explicit", "non-explicit"]).toContain(s.expectedConclusion);
      expect(typeof s.humanConfirmed).toBe("boolean");
      for (const evidence of s.expectedEvidence) {
        expect(s.answer.includes(evidence), `证据必须来自原文：${evidence}`).toBe(true);
      }
    }
  });

  it("按 questionGroup 稳定划分 dev/validation：同一组绝不跨 split，两边都非空", () => {
    for (const s of samples) {
      expect(splitForGroup(s.questionGroup)).toBe(splitForGroup(s.questionGroup)); // 稳定
    }
    const bySplit = splitSamples(samples);
    expect(bySplit.dev.length).toBeGreaterThan(0);
    expect(bySplit.validation.length).toBeGreaterThan(0);
    const devGroups = new Set(bySplit.dev.map((s) => s.questionGroup));
    const valGroups = new Set(bySplit.validation.map((s) => s.questionGroup));
    for (const g of devGroups) expect(valGroups.has(g), `组 ${g} 跨 split`).toBe(false);
    expect(devGroups.size + valGroups.size).toBe(new Set(samples.map((s) => s.questionGroup)).size);
  });
});

/** 完美蚂蚁 runner：extract 用 UTF16 offset。 */
const perfectAntRunner = async (sample: DecisionSample): Promise<SimulatedDecisionRun> => ({
  model: "lingdt-decision-1.0",
  choice: sample.expectedConclusion === "explicit" ? (sample.expectedOptions.length > 1 ? "explicit_multiple" : "explicit_single") : "no_conclusion",
  multiChoices: sample.expectedOptions,
  extractSpans: sample.expectedEvidence.map((text) => ({ type: "evidence", text, start: sample.answer.indexOf(text), end: sample.answer.indexOf(text) + text.length, confidence: 0.9 })),
  extractTruncated: false,
  spanSpans: null,
  noul: sample.expectedConclusion === "explicit" ? 0.9 : 0.1,
  latencyMs: 100,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
});

/** 完美象信 runner：span 用码点 offset。 */
const perfectXiangxinRunner = async (sample: DecisionSample): Promise<SimulatedDecisionRun> => ({
  model: "xiangxin-3.8",
  choice: sample.expectedConclusion === "explicit" ? (sample.expectedOptions.length > 1 ? "explicit_multiple" : "explicit_single") : "no_conclusion",
  multiChoices: null,
  extractSpans: null,
  spanSpans: sample.expectedEvidence.map((text) => {
    // provider 给的是码点位置：先取 UTF16 前缀，再数其码点数（前缀含 emoji 时两者不同）。
    const startCp = Array.from(sample.answer.slice(0, sample.answer.indexOf(text))).length;
    return { path: "", start: startCp, end: startCp + Array.from(text).length, text, confidence: 0.85 };
  }),
  noul: sample.expectedConclusion === "explicit" ? 0.9 : 0.1,
  latencyMs: 80,
  usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
});

/** 有系统性错误的 runner：把非明确判成明确、把一处证据位置放错。 */
const buggyRunner = async (sample: DecisionSample): Promise<SimulatedDecisionRun> => {
  const base = await perfectAntRunner(sample);
  return {
    ...base,
    choice: "explicit_single", // 系统性 false explicit
    extractSpans: sample.expectedEvidence.map((text, i) => ({
      type: "evidence", text,
      start: i === 0 && sample.expectedEvidence.length ? Math.max(0, sample.answer.indexOf(text) - 1) : sample.answer.indexOf(text),
      end: i === 0 && sample.expectedEvidence.length ? Math.max(0, sample.answer.indexOf(text) - 1) + text.length : sample.answer.indexOf(text) + text.length,
      confidence: 0.5,
    })),
  };
};

const totals = (r: Awaited<ReturnType<typeof evaluateDecisionSamples>>) => {
  const ant = r.providers.find((p) => p.profileId === "ant-decision")!;
  return { dev: ant.dev.count + ant.validation.count };
};

describe("evaluateDecisionSamples（离线模拟蚂蚁/象信）", () => {
  it("完美 runner：falseExplicitRate=0、evidenceExactRate=1、humanReviewCoverage=1，split/count/latency/usage 正确", async () => {
    const report = await evaluateDecisionSamples(samples, [
      { profile: ANT_DECISION_PROFILE, runner: perfectAntRunner },
      { profile: XIANGXIN_DECISION_PROFILE, runner: perfectXiangxinRunner },
    ], { now: "2026-11-17T00:00:00.000Z" });
    expect(report.generatedAt).toBe("2026-11-17T00:00:00.000Z");
    expect(report.splits.dev + report.splits.validation).toBe(samples.length);
    expect(report.splits.groups.dev + report.splits.groups.validation).toBe(new Set(samples.map((s) => s.questionGroup)).size);
    for (const p of report.providers) {
      for (const split of [p.dev, p.validation] as const) {
        expect(split.falseExplicit.rate ?? 0).toBe(0);
        if (split.evidenceExact.total) expect(split.evidenceExact.rate).toBe(1);
        expect(split.humanReviewCoverage.rate).toBe(1);
        expect(split.failedRuns).toBe(0);
      }
      const totalCount = p.dev.count + p.validation.count;
      expect(totalCount).toBe(samples.length);
      const perSample = p.profileId === "ant-decision" ? 15 : 12;
      const latency = p.profileId === "ant-decision" ? 100 : 80;
      expect(p.dev.usage.totalTokens + p.validation.usage.totalTokens).toBe(perSample * totalCount);
      expect(p.dev.avgLatencyMs).toBe(latency);
    }
    // 多选组 optionsExactRate=1
    const ant = report.providers.find((p) => p.profileId === "ant-decision")!;
    expect(ant.dev.optionsExact.matched + ant.validation.optionsExact.matched).toBe(8); // 四个带选项组各 2 个样本全对（含 A 和 J 多选）
  });

  it("出错 runner：falseExplicit 计入、证据错位拉低 evidenceExactRate、阈值只报告不自动确认", async () => {
    const report = await evaluateDecisionSamples(samples, [
      { profile: ANT_DECISION_PROFILE, runner: buggyRunner },
    ], { thresholds: { falseExplicitRateMax: 0.2, evidenceExactRateMin: 0.99, humanReviewCoverageMin: 1 } });
    const ant = report.providers.find((p) => p.profileId === "ant-decision")!;
    const fe = [...(ant.dev.falseExplicit.rate !== null ? [ant.dev.falseExplicit] : []), ...(ant.validation.falseExplicit.rate !== null ? [ant.validation.falseExplicit] : [])];
    expect(fe.length).toBeGreaterThan(0);
    for (const m of fe) {
      expect(m.rate).toBe(1); // 非明确样本全被判明确
      expect(m.thresholdMax).toBe(0.2);
      expect(m.thresholdMet).toBe(false); // 只报告，没有任何自动确认动作
    }
    // evidenceExact：每组样本第一处证据错位（无证据的样本不受影响）
    const ev = ant.dev.evidenceExact.total ? ant.dev : ant.validation;
    expect(ev.evidenceExact.matched).toBeLessThan(ev.evidenceExact.total);
    expect(totals(report).dev).toBe(samples.length);
    expect(report.thresholds).toEqual({ falseExplicitRateMax: 0.2, evidenceExactRateMin: 0.99, humanReviewCoverageMin: 1 });
  });

  it("runner 抛错计为 failedRuns，不进入人工覆盖分子", async () => {
    const report = await evaluateDecisionSamples(samples.slice(0, 4), [
      { profile: ANT_DECISION_PROFILE, runner: async () => { throw new Error("simulated provider outage"); } },
    ]);
    const ant = report.providers[0]!;
    expect(ant.dev.failedRuns + ant.validation.failedRuns).toBe(4);
    expect(ant.dev.humanReviewCoverage.rate ?? 0).toBe(0);
  });

  it("象信 span（multiChoices=null）：按与 decision-review 相同的边界规则从已验证证据推导 A..Z 选项", async () => {
    const report = await evaluateDecisionSamples(samples, [
      { profile: XIANGXIN_DECISION_PROFILE, runner: perfectXiangxinRunner },
    ]);
    const xx = report.providers.find((p) => p.profileId === "xiangxin-decision")!;
    // 四个带选项组各 2 个样本：证据覆盖 "最终答案选 B"/"本题选 C"/"最终选 D"/"答案应为 A"/"A 和 J"/"A、J"/"选 A 🎉"/"最终答案是 C"
    expect(xx.dev.optionsExact.matched + xx.validation.optionsExact.matched).toBe(8);
    expect(xx.dev.optionsExact.total + xx.validation.optionsExact.total).toBe(8);
    if (xx.dev.optionsExact.total) expect(xx.dev.optionsExact.rate).toBe(1);
    if (xx.validation.optionsExact.total) expect(xx.validation.optionsExact.rate).toBe(1);
    expect(xx.dev.optionsExact.notApplicable).toBeUndefined();
  });

  it("span 证据缺失选项时推导结果记为不匹配（不是一律错误，也不虚报 0 之外的假象）", async () => {
    // 象信 runner 对 multi-select-aj 只给覆盖 A 的证据：J 无证据支持 → 推导结果 ≠ 期望 → 不匹配。
    const partialXiangxinRunner = async (sample: DecisionSample): Promise<SimulatedDecisionRun> => {
      const base = await perfectXiangxinRunner(sample);
      if (sample.questionGroup !== "multi-select-aj") return base;
      const text = sample.answer.includes("、") ? "A、" : "A 和";
      const startCp = Array.from(sample.answer.slice(0, sample.answer.indexOf(text))).length;
      return {
        ...base,
        spanSpans: [{ path: "", start: startCp, end: startCp + Array.from(text).length, text, confidence: 0.85 }],
      };
    };
    const report = await evaluateDecisionSamples(samples, [
      { profile: XIANGXIN_DECISION_PROFILE, runner: partialXiangxinRunner },
    ]);
    const xx = report.providers.find((p) => p.profileId === "xiangxin-decision")!;
    expect(xx.dev.optionsExact.matched + xx.validation.optionsExact.matched).toBe(6); // 两组 multi-select-aj 不匹配
    expect(xx.dev.optionsExact.total + xx.validation.optionsExact.total).toBe(8);
  });

  it("profile 完全无证据能力（无 extract/span）且 multiChoices=null：optionsExact 记为不适用（rate=null/total=0），绝不虚报 0", async () => {
    const bareProfile = {
      ...XIANGXIN_DECISION_PROFILE,
      id: "bare-decision",
      displayName: "无证据能力 (bare)",
      capabilities: ["choice", "noul"] as Array<"choice" | "noul">,
    };
    const bareRunner = async (sample: DecisionSample): Promise<SimulatedDecisionRun> => ({
      model: "bare-decision-model",
      choice: sample.expectedConclusion === "explicit" ? "explicit_single" : "no_conclusion",
      multiChoices: null,
      extractSpans: null,
      spanSpans: null,
      noul: sample.expectedConclusion === "explicit" ? 0.9 : 0.1,
      latencyMs: 50,
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    });
    const report = await evaluateDecisionSamples(samples, [{ profile: bareProfile, runner: bareRunner }]);
    const bare = report.providers.find((p) => p.profileId === "bare-decision")!;
    expect(bare.dev.optionsExact.total).toBe(0);
    expect(bare.validation.optionsExact.total).toBe(0);
    expect(bare.dev.optionsExact.rate).toBeNull();
    expect(bare.validation.optionsExact.rate).toBeNull();
    // 有带选项样本的 split 必须显式列明不适用。
    const withOptions = [bare.dev, bare.validation].filter((m) => m.count > 0);
    expect(withOptions.length).toBeGreaterThan(0);
    for (const m of withOptions) expect(m.optionsExact.notApplicable).toBe(true);
  });
});
