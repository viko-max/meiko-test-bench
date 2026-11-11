import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { PublicQuestionSchema, ScoringSpecSchema, TrialSchema } from "../src/shared/contracts.js";
import { gradeTrial, gradeIsStale } from "../src/grading/grade.js";
import { assertScoring } from "../src/grading/scoring.js";
import { buildModeReport } from "../src/reporting/report.js";
import { ImportService, parseMarkdownSource } from "../src/import/import-service.js";
import { publicQuestion } from "../src/import/validation.js";
import { buildUserContent } from "../src/runner/prompt.js";
import { importDataset } from "../src/dataset/import.js";
import { checkDraft } from "../src/import/convert-check.js";

const question = PublicQuestionSchema.parse({ id: "q1", version: "1", subject: "math", answerKind: "single_choice", stem: "2+2?", options: { A: "3", B: "4" } });
const scoring = ScoringSpecSchema.parse({ questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 5, reference: "B" });
const trial = TrialSchema.parse({ trialId: "t1", datasetId: "demo", datasetVersion: "1", questionId: "q1", questionVersion: "1", provider: "offline", modelId: "offline", mode: "without_tool", configDigest: "offline", promptVersion: "v2", toolsVersion: "v1", executionStatus: "completed", finalAnswerSheet: "Final answer: B" });
function root() { mkdirSync(resolve(".work"), { recursive: true }); return mkdtempSync(resolve(".work", "material-consistency-")); }

describe("材料与评分一致性", () => {
  it("评分摘要覆盖同版本答案、分值和细则变化；旧成绩仍可读但不计分", () => {
    const grade = gradeTrial(trial, question, scoring).grade!;
    expect(gradeIsStale(grade, scoring)).toBe(false);
    for (const change of [{ reference: "A" }, { maxScore: 10 }, { tolerance: 0.2 }, { rubric: [{ points: 5, evidence: "新依据", acceptAlternatives: [] }] }]) expect(gradeIsStale(grade, { ...scoring, ...change })).toBe(true);
    const legacy = { ...grade }; delete legacy.scoringDigest;
    const report = (g = grade, s = scoring) => buildModeReport({ mode: "without_tool", trials: [trial], grades: [g], questions: new Map([[question.id, question]]), scorings: new Map([[s.questionId, s]]), plannedMaxScore: s.maxScore });
    expect(report(legacy).coverage["grade:stale"]).toBe(1);
    expect(report(legacy).totals.confirmedRaw).toBe(0);
    expect(report(grade, { ...scoring, maxScore: 1 }).totals.confirmedRaw).toBe(0);
    expect(report().totals.confirmedRaw).toBe(5);
  });
  it.each([-5, Infinity, NaN])("拒绝非法分项分值 %s", (points) => {
    expect(() => ScoringSpecSchema.parse({ ...scoring, rubric: [{ points }, { points: 10 }] })).toThrow();
  });
  it("统一拒绝细则合计、题型和小问不一致", () => {
    expect(() => assertScoring({ ...scoring, rubric: [{ points: 4, acceptAlternatives: [] }] }, question)).toThrow("分值之和");
    expect(() => assertScoring({ ...scoring, answerKind: "open" }, question)).toThrow("题型");
    expect(() => assertScoring({ ...scoring, rubric: [{ partLabel: "missing", points: 5, acceptAlternatives: [] }] }, question)).toThrow("小问");
  });
  it("选项在题面中只显示一次，不一致时阻止转换", () => {
    const draft = parseMarkdownSource("Question?\n\n- A. alpha\n- B. beta", "synthetic.md")[0]!;
    const content = buildUserContent(publicQuestion(draft));
    expect(content.match(/A\. alpha/g)).toHaveLength(1);
    expect(() => buildUserContent({ ...publicQuestion(draft), options: { A: "changed", B: "beta" } })).toThrow("不一致");
    expect(checkDraft({ datasetId: "demo", questions: [{ ...draft, options: { A: "changed", B: "beta" } }] } as never).ok).toBe(false);
  });
  it("含图标准题目包再次导入时校验、预览和发布使用同一附件位置", async () => {
    const base = root(), source = join(base, "source"); mkdirSync(source);
    const file = join(source, "questions.json");
    writeFileSync(file, JSON.stringify([{ id: "q1", question: "Read the figure.", answer_kind: "open", assets: [{ ref: "fig.png" }] }]));
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).png().toFile(join(source, "fig.png"));
    const service = new ImportService(join(base, "datasets"), join(base, "drafts"));
    const first = await service.confirmDraft(service.importSource(file, { datasetId: "first" }).draftId);
    const draft = service.importSource(first.path, { datasetId: "second" });
    expect(service.check(draft.draftId).ok).toBe(true);
    expect(service.reviewAsset(draft.draftId, 0, 0).path).toContain("public");
    const second = await service.confirmDraft(draft.draftId);
    expect(readFileSync(join(first.path, "public", "fig.png"))).toEqual(readFileSync(join(second.path, "public", "fig.png")));
  });
  it("相同题号的多份评分文件不会静默覆盖", async () => {
    const base = root(), pub = join(base, "public"), score = join(base, "scoring"); mkdirSync(pub); mkdirSync(score);
    writeFileSync(join(pub, "q1.md"), '---\nid: q1\nversion: "1"\nsubject: math\nanswer_kind: single_choice\noptions: {A: "3", B: "4"}\n---\n2+2?');
    writeFileSync(join(score, "a.json"), JSON.stringify(scoring)); writeFileSync(join(score, "b.json"), JSON.stringify({ ...scoring, reference: "A" }));
    const loaded = await importDataset({ datasetId: "demo", publicDir: pub, scoringDir: score });
    expect(loaded.ok).toBe(false); expect(JSON.stringify(loaded.entries)).toContain("duplicate scoring");
    expect(loaded.entries.find((entry) => entry.questionId === "q1")?.errors.join(" ")).toContain("duplicate scoring");
  });
});
