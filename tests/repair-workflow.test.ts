import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelProfileSchema, PublicQuestionSchema, type Grade, type Trial } from "../src/shared/contracts.js";
import { loadArchivedTrials, writeGradeFile } from "../src/runner/archive.js";
import { loadQuestionImages, runBatch, type BatchParams } from "../src/runner/batch.js";
import { EXAM_TOOLS_VERSION } from "../src/tools/index.js";
import { importDataset } from "../src/dataset/import.js";
import { readJsonl } from "../src/shared/json.js";
import * as attachmentPaths from "../src/tools/paths.js";

// 验证产物仅在 .work 内创建，保留供核对，不删除用户文件或测试目录。
function workspace(): string {
  const base = resolve(".work");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "repair-verification-"));
}

function setup() {
  const root = workspace();
  const publicDir = join(root, "public");
  const scoringDir = join(root, "scoring");
  mkdirSync(publicDir);
  mkdirSync(scoringDir);
  const markdown = '---\nid: q\nversion: "1"\nsubject: math\nanswer_kind: single_choice\n---\n\n2+2=?\n\n- A. 3\n- B. 4\n';
  writeFileSync(join(publicDir, "q.md"), markdown);
  const scoring = { questionId: "q", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 5, reference: "B", deterministicLocked: true };
  writeFileSync(join(scoringDir, "q.json"), JSON.stringify(scoring));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("答案是 B")]);
  const profile = ModelProfileSchema.parse({
    id: "faux", displayName: "Faux", provider: "faux", api: "faux", baseUrl: "https://faux.example/v1", auth: { envVars: ["FAUX_KEY"] },
    models: [{ id: "faux-1", name: "Faux", input: ["text"], reasoning: false, contextWindow: 4096, maxTokens: 1024 }],
    capability: { imageInput: "verified" },
  });
  const params: BatchParams = {
    datasetId: "demo", datasetDir: root, modes: ["without_tool"], profileId: "faux", modelId: "faux-1", limit: 1,
    runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: EXAM_TOOLS_VERSION, pythonInterpreter: "python", modelsConfigPath: "unused",
    registryOverride: { models, profilesById: new Map([["faux", profile]]) },
  };
  return { root, publicDir, scoringDir, markdown, scoring, faux, params };
}

async function answered() {
  const s = setup();
  const first = await runBatch(s.params);
  const runId = first.byMode.without_tool!.runId;
  const td = join(s.params.runsRoot, runId, "trials");
  const trialId = readdirSync(td)[0]!;
  const trialDir = join(td, trialId);
  const trial = JSON.parse(readFileSync(join(trialDir, "trial.json"), "utf8")) as Trial;
  return { ...s, runId, trialId, trialDir, trial };
}

describe("批量入口的恢复与评分存档", () => {
  it.each([true, false])("仅有 attempt 时不重发，摘要存在=%s", async (withDigest) => {
    const s = await answered();
    const ap = join(s.trialDir, "attempt.json");
    const attempt = JSON.parse(readFileSync(ap, "utf8"));
    expect(attempt.questionContentDigest).toBe(s.trial.questionContentDigest);
    if (!withDigest) {
      const { questionContentDigest: _digest, ...legacy } = attempt;
      writeFileSync(ap, JSON.stringify(legacy));
    }
    renameSync(join(s.trialDir, "trial.json"), join(s.trialDir, "saved-trial.json"));
    const result = await runBatch({ ...s.params, resume: true });
    expect(s.faux.state.callCount).toBe(1);
    expect(result.byMode.without_tool!.report.perQuestion[0]!.executionStatus).toBe("outcome_unknown");
    expect(result.byMode.without_tool!.report.totals.confirmedRaw).toBe(0);
    const map = loadArchivedTrials(s.params.runsRoot, "without_tool", "faux", "faux-1", s.trial.configDigest);
    expect(map.get("q@1")!.trial.questionContentDigest).toBe(withDigest ? s.trial.questionContentDigest : undefined);
  });

  it.each(["changed", "missing"])("完成记录摘要 %s 时不重发、不计旧成绩", async (kind) => {
    const s = await answered();
    if (kind === "changed") writeFileSync(join(s.publicDir, "q.md"), s.markdown.replace("2+2", "3+3"));
    else {
      const { questionContentDigest: _digest, ...legacy } = s.trial;
      writeFileSync(join(s.trialDir, "trial.json"), JSON.stringify(legacy));
    }
    const result = await runBatch({ ...s.params, resume: true });
    expect(s.faux.state.callCount).toBe(1);
    expect(result.byMode.without_tool!.report.totals.confirmedRaw).toBe(0);
    expect(result.byMode.without_tool!.report.perQuestion[0]!.executionStatus).toBe("outcome_unknown");
  });

  it("新旧内容并存时选择当前内容，连续恢复均不发送", async () => {
    const s = await answered();
    const old = join(s.params.runsRoot, "000-old", "trials", s.trial.trialId);
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "trial.json"), JSON.stringify({ ...s.trial, questionContentDigest: "old-content" }));
    for (let n = 0; n < 2; n++) {
      const result = await runBatch({ ...s.params, resume: true });
      expect(s.faux.state.callCount).toBe(1);
      expect(result.byMode.without_tool!.report.totals.confirmedRaw).toBe(5);
    }
  });

  it("匹配当前内容的未知结果优先于其他内容的完成结果", async () => {
    const s = await answered();
    const old = join(s.params.runsRoot, "000-old", "trials", s.trial.trialId);
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "trial.json"), JSON.stringify({ ...s.trial, questionContentDigest: "old-content" }));
    renameSync(join(s.trialDir, "trial.json"), join(s.trialDir, "saved-trial.json"));
    const map = loadArchivedTrials(s.params.runsRoot, "without_tool", "faux", "faux-1", s.trial.configDigest, undefined, new Map([["q@1", s.trial.questionContentDigest]]));
    expect(map.get("q@1")!.trial.executionStatus).toBe("outcome_unknown");
    expect(map.get("q@1")!.runId).toBe(s.runId);
    await runBatch({ ...s.params, resume: true });
    expect(s.faux.state.callCount).toBe(1);
  });

  it("相同版本替换图片时，两种模式均不自动重新作答", async () => {
    const s = setup();
    s.params.modes = ["without_tool", "with_tool"];
    s.faux.setResponses([fauxAssistantMessage("答案是 B"), fauxAssistantMessage("答案是 B")]);
    writeFileSync(join(s.publicDir, "q.md"), s.markdown + "\n![图](fig.png)\n");
    const png = (background: string) => sharp({ create: { width: 2, height: 2, channels: 3, background } }).png().toBuffer();
    writeFileSync(join(s.publicDir, "fig.png"), await png("red"));
    await runBatch(s.params);
    expect(s.faux.state.callCount).toBe(2);
    writeFileSync(join(s.publicDir, "fig.png"), await png("blue"));
    const result = await runBatch({ ...s.params, resume: true });
    expect(s.faux.state.callCount).toBe(2);
    for (const mode of s.params.modes) {
      expect(result.byMode[mode]!.report.totals.confirmedRaw).toBe(0);
      expect(result.byMode[mode]!.report.perQuestion[0]!.executionStatus).toBe("outcome_unknown");
    }
  });

  it("恢复重评分保留旧 Grade，报告与保存的新 Grade 一致", async () => {
    const s = await answered();
    const previous = JSON.parse(readFileSync(join(s.trialDir, "grade.json"), "utf8")) as Grade;
    writeFileSync(join(s.scoringDir, "q.json"), JSON.stringify({ ...s.scoring, scoringVersion: "2", reference: "A" }));
    const result = await runBatch({ ...s.params, resume: true });
    expect(s.faux.state.callCount).toBe(1);
    expect(result.byMode.without_tool!.report.totals.confirmedRaw).toBe(0);
    const current = JSON.parse(readFileSync(join(s.trialDir, "grade.json"), "utf8")) as Grade;
    expect(current.scoringVersion).toBe("2");
    expect(current.rawScore).toBe(0);
    expect(readJsonl<{ grade: Grade }>(join(s.trialDir, "grade-history.jsonl"))[0]!.grade).toEqual(previous);
  });

  it("历史写入失败时不覆盖当前 Grade", async () => {
    const s = await answered();
    const gp = join(s.trialDir, "grade.json");
    const original = readFileSync(gp, "utf8");
    const grade = JSON.parse(original) as Grade;
    mkdirSync(join(s.trialDir, "grade-history.jsonl"));
    expect(() => writeGradeFile(s.params.runsRoot, s.runId, s.trialId, { ...grade, scoringVersion: "2" })).toThrow();
    expect(readFileSync(gp, "utf8")).toBe(original);
  });
});

describe("必需图片与附件范围", () => {
  it("图片在导入后不可用时，批量入口记录错误并且不发送", async () => {
    const s = setup();
    writeFileSync(join(s.publicDir, "q.md"), s.markdown + "\n![图](fig.png)\n");
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    writeFileSync(join(s.publicDir, "fig.png"), png);
    const realResolve = attachmentPaths.resolvePublicAttachment;
    let calls = 0;
    const spy = vi.spyOn(attachmentPaths, "resolvePublicAttachment").mockImplementation((...args) => {
      calls++;
      // 导入的存在性、解码、摘要读取都成功，发送前模拟文件不可用。
      if (calls >= 4) throw new Error("attachment became unavailable");
      return realResolve(...args);
    });
    try {
      const result = await runBatch(s.params);
      expect(s.faux.state.callCount).toBe(0);
      expect(result.byMode.without_tool!.report.perQuestion[0]!.executionStatus).toBe("unsupported_input");
    } finally {
      spy.mockRestore();
    }
  });

  it("损坏图片直接报错，不返回不完整的图片列表", async () => {
    const root = workspace();
    writeFileSync(join(root, "fig.png"), "not an image");
    const q = PublicQuestionSchema.parse({ id: "q", version: "1", subject: "math", answerKind: "open", stem: "图", assets: [{ ref: "fig.png", mediaType: "image/png", role: "figure" }] });
    await expect(loadQuestionImages(q, root)).rejects.toThrow("required image fig.png");
  });

  it("导入与原图发送都拒绝附件父目录 junction", async () => {
    const s = setup();
    const other = join(s.root, "other");
    mkdirSync(other);
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    writeFileSync(join(other, "fig.png"), png);
    symlinkSync(other, join(s.publicDir, "figures"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(s.publicDir, "q.md"), s.markdown + "\n![图](figures/fig.png)\n");
    const imported = await importDataset({ datasetId: "demo", publicDir: s.publicDir, scoringDir: s.scoringDir });
    const entry = imported.entries[0]!;
    expect(entry.errors.some((e) => e.includes("parent link"))).toBe(true);
    await expect(loadQuestionImages(entry.question!, s.publicDir)).rejects.toThrow("parent link");
    const result = await runBatch(s.params);
    expect(result.questionCount).toBe(0);
    expect(s.faux.state.callCount).toBe(0);
  });
});
