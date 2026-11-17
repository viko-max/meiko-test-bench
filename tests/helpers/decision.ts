/**
 * 决策辅助测试共享夹具：构造一份真实题集 + 真实归档 Trial（与报告同一套
 * loadValidAnswers 校验来源），只使用本机目录，不访问网络、不写入真实数据。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { importDataset } from "../../src/dataset/import.js";

export const FIXTURE_ANSWER = "计算过程略。😀 最终选择 A 和 J。故选 A、J。";

export interface DecisionFixture {
  root: string;
  datasetsRoot: string;
  runsRoot: string;
  datasetId: string;
  datasetDir: string;
  runId: string;
  trialId: string;
  trialDir: string;
  gradePath: string;
  /** 重写归档 trial.json（如改 finalAnswerSheet 模拟材料变化）。 */
  rewriteTrial: (patch: Record<string, unknown>) => void;
  readTrial: () => Record<string, unknown>;
  gradeBytes: () => string;
}

export async function buildDecisionFixture(patchTrial: Record<string, unknown> = {}): Promise<DecisionFixture> {
  mkdirSync(resolve(".work"), { recursive: true });
  const root = mkdtempSync(resolve(".work", "decision-fixture-"));
  const datasetsRoot = join(root, "datasets");
  const datasetId = "demo";
  const dir = join(datasetsRoot, datasetId);
  mkdirSync(join(dir, "public"), { recursive: true });
  mkdirSync(join(dir, "scoring"));
  const options = Object.fromEntries("ABCDEFGHIJ".split("").map((label) => [label, `选项 ${label} 的说明`]));
  writeFileSync(
    join(dir, "public", "q1.md"),
    `---\nid: q1\nversion: "1"\nsubject: math\nanswer_kind: multi_choice\noptions:\n` +
      Object.entries(options).map(([label, text]) => `  ${label}: ${JSON.stringify(text)}`).join("\n") +
      `\n---\n\n下列说法正确的是（多选）。\n`,
  );
  writeFileSync(join(dir, "scoring", "q1.json"), JSON.stringify({
    questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "multi_choice",
    maxScore: 6, reference: { A: "...", J: "..." }, deterministicLocked: false,
  }));
  const imported = await importDataset({ datasetId, publicDir: join(dir, "public"), scoringDir: join(dir, "scoring") });
  const entry = imported.entries.find((e) => e.questionId === "q1");
  if (!entry?.question || entry.errors.length) throw new Error(`fixture dataset invalid: ${entry?.errors.join("; ")}`);

  const runsRoot = join(root, "runs");
  const runId = "demo@1__faux__faux-1__test0000";
  const trialId = "q1__without_tool__bbbbbbbbbbbb__0";
  const trialDir = join(runsRoot, runId, "trials", trialId);
  mkdirSync(trialDir, { recursive: true });
  const trial = {
    trialId, datasetId, datasetVersion: "1", questionId: "q1", questionVersion: "1",
    provider: "faux", modelId: "faux-1", mode: "without_tool",
    configDigest: "cfg-digest", promptVersion: "v1", toolsVersion: "v1",
    executionStatus: "completed", finalAnswerSheet: FIXTURE_ANSWER,
    gradingStatus: "ungraded", questionContentDigest: entry.contentDigest,
    ...patchTrial,
  };
  const trialPath = join(trialDir, "trial.json");
  writeFileSync(trialPath, JSON.stringify(trial, null, 2));
  // manifest：与 trial 身份一致，供 resolveRunMode / loadValidAnswers 走同一路径。
  writeFileSync(join(runsRoot, runId, "manifest.json"), JSON.stringify({
    schema: "pi-exam-run-manifest/1", mode: "without_tool",
    datasetId, datasetVersion: "1", provider: "faux", modelId: "faux-1", configDigest: "cfg-digest",
    plannedQuestionIds: ["q1"], plannedMaxScore: 6,
    sources: [{ questionId: "q1", runId, trialId, status: "usable" }],
    promptVersion: "v1", toolsVersion: "v1",
  }, null, 2));
  const gradePath = join(trialDir, "grade.json");
  writeFileSync(gradePath, JSON.stringify({
    gradeId: `${trialId}__base`, trialId, questionId: "q1", scoringVersion: "1",
    graderKind: "rule", rawScore: 0, maxScore: 6, items: [],
    reviewStatus: "pending_human_review", reviewReason: "non-deterministic extraction",
    createdAt: new Date(0).toISOString(),
  }, null, 2));
  return {
    root, datasetsRoot, runsRoot, datasetId, datasetDir: dir, runId, trialId, trialDir, gradePath,
    rewriteTrial: (patch) => {
      const current = JSON.parse(readFileSync(trialPath, "utf8")) as Record<string, unknown>;
      writeFileSync(trialPath, JSON.stringify({ ...current, ...patch }, null, 2));
    },
    readTrial: () => JSON.parse(readFileSync(trialPath, "utf8")) as Record<string, unknown>,
    gradeBytes: () => readFileSync(gradePath, "utf8"),
  };
}
