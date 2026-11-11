import { describe, expect, it, vi } from "vitest";
import { buildGraderPrompt, confirmGrade, gradeWithModel } from "../src/grading/model-grader.js";
import { GradeSchema, PublicQuestionSchema, ScoringSpecSchema, TrialSchema } from "../src/shared/contracts.js";
import type { GraderRequest } from "../src/grading/model-grader.js";

const question = PublicQuestionSchema.parse({ id: "q1", version: "1", subject: "physics", answerKind: "open", stem: "共享材料：$F=ma$。", options: { A: "选项完整甲", B: "选项完整乙" }, parts: [{ label: "a", prompt: "第一小问完整文字" }, { label: "b", prompt: "第二小问完整文字" }], assets: [] });
const scoring = ScoringSpecSchema.parse({ questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "open", maxScore: 5, reference: { a: "PRIVATE-REF-A", b: "PRIVATE-REF-B" }, rubric: [{ partLabel: "a", points: 3, evidence: "第一项证据", acceptAlternatives: ["评分项其他解释"] }, { partLabel: "b", points: 2 }], units: ["N"], tolerance: 0.01, acceptableAlternatives: ["其他整体解释"], reviewConditions: "检查单位与图中标注" });
const trial = TrialSchema.parse({ trialId: "q1__without_tool__t__0", datasetId: "demo", datasetVersion: "1", questionId: "q1", questionVersion: "1", provider: "hidden-provider", modelId: "hidden-model", mode: "without_tool", configDigest: "d", promptVersion: "v1", toolsVersion: "v1", executionStatus: "completed", finalAnswerSheet: "完整学生答卷，包含两个小问。" });
const old = GradeSchema.parse({ gradeId: "old", trialId: trial.trialId, questionId: "q1", scoringVersion: "1", graderKind: "model", rawScore: 3, maxScore: 5, items: [{ partLabel: "a", points: 2, evidence: "旧第一项证据" }, { partLabel: "b", points: 1, evidence: "旧第二项证据" }], reviewStatus: "model_preliminary", createdAt: "offline" });
const figure = { ref: "figure.png", mediaType: "image/png", role: "figure", alt: "图中横轴为时间" };
const image = { type: "image" as const, data: "offline-native-image", mimeType: "image/png" };

describe("完整裁判输入与人工评分一致性", () => {
  it("裁判收到完整选项、小问、公式、评分项、单位、容差及完整答卷，不收到被测模型身份", () => {
    const prompt = buildGraderPrompt(question, scoring, trial.finalAnswerSheet!);
    for (const text of ["$F=ma$", "选项完整甲", "选项完整乙", "第一小问完整文字", "第二小问完整文字", "PRIVATE-REF-A", "评分项其他解释", "其他整体解释", "0.01", "检查单位与图中标注", trial.finalAnswerSheet!]) expect(prompt).toContain(text);
    expect(prompt).not.toContain("hidden-model"); expect(prompt).not.toContain("hidden-provider"); expect(prompt).not.toContain("without_tool");
  });

  it("原图与文字关联且按原图顺序传给声明图片能力的适配器", async () => {
    const q = PublicQuestionSchema.parse({ ...question, assets: [figure, { ...figure, ref: "second.png" }] });
    const complete = vi.fn(async (_request: GraderRequest) => '{"score":3,"evidence":"核对两张原图"}');
    const result = await gradeWithModel({ trial, question: q, scoring, questionImages: [image, { ...image, data: "second-native-image" }], graderComplete: { supportsImages: true, complete } });
    expect(result.grade?.reviewStatus).toBe("model_preliminary");
    const request = complete.mock.calls[0]![0];
    expect(request.images.map((item) => item.data)).toEqual(["offline-native-image", "second-native-image"]);
    expect(request.prompt).toContain("figure.png"); expect(request.prompt).toContain("second.png"); expect(request.prompt).toContain(figure.alt);
  });

  it("缺图、额外图片、图片类型不匹配均不调用裁判", async () => {
    const q = PublicQuestionSchema.parse({ ...question, assets: [figure] });
    for (const questionImages of [[], [image, image], [{ ...image, mimeType: "image/jpeg" }]]) {
      const complete = vi.fn(async () => '{"score":5}');
      expect((await gradeWithModel({ trial, question: q, scoring, questionImages, graderComplete: { supportsImages: true, complete } })).skipped).toContain("images");
      expect(complete).not.toHaveBeenCalled();
    }
  });

  it("旧文本回调和未声明图片能力的适配器都不能忽略原图评分", async () => {
    const q = PublicQuestionSchema.parse({ ...question, assets: [figure] });
    const complete = vi.fn(async () => '{"score":5}');
    for (const graderComplete of [complete, { supportsImages: false, complete }]) {
      expect((await gradeWithModel({ trial, question: q, scoring, questionImages: [image], graderComplete })).skipped).toContain("image support");
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it("非图片附件及题目版本不匹配进入人工检查，不发出不完整评分请求", async () => {
    const complete = vi.fn(async () => '{"score":5}');
    const q = PublicQuestionSchema.parse({ ...question, assets: [{ ref: "data.csv", mediaType: "text/csv", role: "data" }] });
    expect((await gradeWithModel({ trial, question: q, scoring, graderComplete: complete })).skipped).toContain("non-image");
    expect((await gradeWithModel({ trial, question: { ...question, version: "2" }, scoring, graderComplete: complete })).skipped).toContain("identity");
    expect(complete).not.toHaveBeenCalled();
  });

  it("总分修订生成单个总分项，旧分项不被篡改或错误重新分配", () => {
    const before = JSON.stringify(old);
    const grade = confirmGrade(old, { by: "meiko", score: 4, note: "复核总分" });
    expect(grade.rawScore).toBe(4); expect(grade.items).toHaveLength(1);
    expect(grade.items[0]!.points).toBe(4); expect(grade.items[0]!.partLabel).toBeUndefined();
    expect(grade.items[0]!.evidence).toBeUndefined(); expect(grade.items[0]!.note).toContain("未逐项重新评分");
    expect(JSON.stringify(old)).toBe(before);
  });

  it("明确逐项评分保留对应证据、分项合计等于总分，分配变化改变评分标识", () => {
    const items = [{ partLabel: "a", points: 3, evidence: "新第一项证据" }, { partLabel: "b", points: 1, evidence: "新第二项证据" }];
    const grade = confirmGrade(old, { by: "meiko", score: 4, items });
    expect(grade.items.reduce((sum, item) => sum + item.points, 0)).toBe(grade.rawScore);
    expect(grade.items[1]!.evidence).toBe("新第二项证据");
    expect(confirmGrade(old, { by: "meiko", score: 4, items: [{ partLabel: "a", points: 2 }, { partLabel: "b", points: 2 }] }).gradeId).not.toBe(grade.gradeId);
  });

  it("空分项、负分、合计错误及无效人工总分直接拒绝", () => {
    for (const items of [[], [{ points: -1 }, { points: 5 }], [{ points: 1 }]]) expect(() => confirmGrade(old, { by: "meiko", score: 4, items })).toThrow();
    for (const score of [-1, 6, Number.NaN, Infinity]) expect(() => confirmGrade(old, { by: "meiko", score })).toThrow();
    expect(() => confirmGrade(old, { by: " " })).toThrow("确认人");
  });

  it("逐项评分可推导总分，并容忍正常浮点求和误差", () => {
    const grade = confirmGrade(old, { by: "meiko", score: 0.3, items: [{ points: 0.1 }, { points: 0.2 }] });
    expect(grade.rawScore).toBe(0.3);
    expect(confirmGrade(old, { by: "meiko", items: [{ points: 2 }, { points: 1 }] }).rawScore).toBe(3);
  });
});
