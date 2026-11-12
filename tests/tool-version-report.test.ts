/**
 * 工具版本展示（shared/tool-version.ts）与报告 toolVersions：不同工具版本
 * 能力不同，分数仍按原逻辑直接累加，版本只作来源展示。
 */
import { describe, it, expect } from "vitest";
import { describeToolVersion, TOOL_VERSION_COMPARABILITY } from "../src/shared/tool-version.js";
import { buildModeReport, reportToMarkdown } from "../src/reporting/report.js";
import { GradeSchema, PublicQuestionSchema, ScoringSpecSchema, TrialSchema } from "../src/shared/contracts.js";
import { scoringDigest } from "../src/grading/scoring.js";

const q1 = PublicQuestionSchema.parse({ id: "q1", version: "1", subject: "m", answerKind: "single_choice", stem: "x", options: { A: "1", B: "2" }, assets: [] });
const q2 = PublicQuestionSchema.parse({ id: "q2", version: "1", subject: "m", answerKind: "single_choice", stem: "y", options: { A: "1", B: "2" }, assets: [] });
const s1 = ScoringSpecSchema.parse({ questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 5, reference: "B", deterministicLocked: true });
const s2 = ScoringSpecSchema.parse({ questionId: "q2", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 5, reference: "B", deterministicLocked: true });

const trial = (trialId: string, questionId: string, toolsVersion: string) => TrialSchema.parse({
  trialId, datasetId: "d", datasetVersion: "1", questionId, questionVersion: "1",
  provider: "p", modelId: "m", mode: "with_tool", configDigest: "c", promptVersion: "v3",
  toolsVersion, executionStatus: "completed", finalAnswerSheet: "B",
});
const grade = (gradeId: string, trialId: string, questionId: string, scoring: typeof s1) => GradeSchema.parse({
  gradeId, trialId, questionId, scoringVersion: "1", scoringDigest: scoringDigest(scoring),
  graderKind: "rule", rawScore: 5, maxScore: 5, items: [], reviewStatus: "rule_graded", createdAt: "t",
});

describe("describeToolVersion", () => {
  it("without_tool 只标注无工具，不加能力标签", () => {
    expect(describeToolVersion("without_tool", "v1")).toBe("v1（无工具）");
  });
  it("with_tool v1 标注宿主任意代码、非隔离；v2-restricted 标注受限能力", () => {
    expect(describeToolVersion("with_tool", "v1")).toBe("v1（宿主任意代码，非隔离）");
    expect(describeToolVersion("with_tool", "v2-restricted")).toBe("v2-restricted（受限计算、附件与图像工具）");
  });
  it("未知版本原样显示，不虚构能力", () => {
    expect(describeToolVersion("with_tool", "v9-future")).toBe("v9-future");
  });
});

describe("buildModeReport toolVersions", () => {
  const mixed = [
    trial("q1__with_tool__x__0", "q1", "v2-restricted"),
    trial("q2__with_tool__x__0", "q2", "v1"),
  ];
  const grades = [grade("g1", "q1__with_tool__x__0", "q1", s1), grade("g2", "q2__with_tool__x__0", "q2", s2)];

  it("不同工具版本均保留在去重排序的 toolVersions 中，分数仍按原逻辑", () => {
    const rep = buildModeReport({
      mode: "with_tool", trials: mixed, grades,
      questions: new Map([["q1", q1], ["q2", q2]]), scorings: new Map([["q1", s1], ["q2", s2]]),
      plannedMaxScore: 10,
    });
    expect(rep.toolVersions).toEqual(["v1", "v2-restricted"]);
    expect(rep.totals).toEqual({ confirmedRaw: 10, confirmedMax: 10, plannedMax: 10 });
  });

  it("markdown 逐版本展示 with_tool 能力并附可比性提示", () => {
    const rep = buildModeReport({
      mode: "with_tool", trials: mixed, grades,
      questions: new Map([["q1", q1], ["q2", q2]]), scorings: new Map([["q1", s1], ["q2", s2]]),
      plannedMaxScore: 10,
    });
    const md = reportToMarkdown(rep);
    expect(md).toContain("v1（宿主任意代码，非隔离）");
    expect(md).toContain("v2-restricted（受限计算、附件与图像工具）");
    expect(md).toContain(TOOL_VERSION_COMPARABILITY);
  });

  it("without_tool 简洁显示版本，不出现任意代码标签", () => {
    const rep = buildModeReport({
      mode: "without_tool", trials: mixed, grades,
      questions: new Map([["q1", q1], ["q2", q2]]), scorings: new Map([["q1", s1], ["q2", s2]]),
      plannedMaxScore: 10,
    });
    // without_tool 模式只统计本模式 trials；这里 trials 均为 with_tool，故无版本。
    expect(rep.toolVersions).toBeUndefined();
    expect(reportToMarkdown(rep)).not.toContain("任意代码");
  });

  it("without_tool 历史 v1 答卷显示为无工具", () => {
    const historical = TrialSchema.parse({
      trialId: "q1__without_tool__x__0", datasetId: "d", datasetVersion: "1", questionId: "q1", questionVersion: "1",
      provider: "p", modelId: "m", mode: "without_tool", configDigest: "c", promptVersion: "v2",
      toolsVersion: "v1", executionStatus: "completed", finalAnswerSheet: "B",
    });
    const rep = buildModeReport({
      mode: "without_tool", trials: [historical], grades: [grade("g1", "q1__without_tool__x__0", "q1", s1)],
      questions: new Map([["q1", q1]]), scorings: new Map([["q1", s1]]), plannedMaxScore: 5,
    });
    expect(rep.toolVersions).toEqual(["v1"]);
    const md = reportToMarkdown(rep);
    expect(md).toContain("v1（无工具）");
    expect(md).not.toContain("任意代码");
  });
});
