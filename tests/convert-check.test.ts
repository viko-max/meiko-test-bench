import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { ImportService } from "../src/import/import-service.js";
import { checkDraft, scoringComplete } from "../src/import/convert-check.js";

let root: string;

function fresh(): { svc: ImportService; datasetsRoot: string } {
  mkdirSync(resolve(".work"), { recursive: true });
  root = mkdtempSync(resolve(".work", "conversion-check-"));
  const datasetsRoot = join(root, "datasets");
  mkdirSync(datasetsRoot, { recursive: true });
  return { svc: new ImportService(datasetsRoot, join(root, ".import")), datasetsRoot };
}

const draftOf = (questions: unknown[]): Parameters<typeof checkDraft>[0] =>
  ({ draftId: "d", datasetId: "demo", version: "1", status: "draft", format: "json", source: "/x", questions, warnings: [], createdAt: "now" }) as Parameters<typeof checkDraft>[0];

describe("convert-check (Next_Plan §3 step 5)", () => {
  it("scoringComplete requires a positive maxScore AND a reference", () => {
    expect(scoringComplete({ maxScore: 5, reference: "B" })).toBe(true);
    expect(scoringComplete({ maxScore: 5 })).toBe(false);
    expect(scoringComplete({ reference: "B" })).toBe(false);
    expect(scoringComplete({ maxScore: 0, reference: "B" })).toBe(false);
    expect(scoringComplete(undefined)).toBe(false);
  });

  it("flags empty stem / duplicate id / unscored / broken LaTeX / missing figure", () => {
    const check = checkDraft(
      draftOf([
        { id: "q1", version: "1", subject: "m", answerKind: "open", stem: "", sourceFile: "f" },
        { id: "q1", version: "1", subject: "m", answerKind: "open", stem: "ok $x$", sourceFile: "f" },
        { id: "q2", version: "1", subject: "m", answerKind: "open", stem: "broken $x", sourceFile: "f" },
        { id: "q3", version: "1", subject: "m", answerKind: "open", stem: "see ![d](fig.png)", assets: [{ ref: "fig.png" }], sourceFile: "f" },
      ]),
      { sourceDir: "/nonexistent" },
    );
    expect(check.ok).toBe(false);
    const all = check.questions.flatMap((q) => q.issues);
    expect(all.some((i) => i.includes("题面为空"))).toBe(true);
    expect(all.some((i) => i.includes("题号重复"))).toBe(true);
    expect(all.some((i) => i.includes("$ 不成对"))).toBe(true);
    expect(all.some((i) => i.includes("缺图"))).toBe(true);
    for (const id of ["q1", "q2", "q3"]) expect(check.warnings.some((warning) => warning.includes(id) && warning.includes("未评分"))).toBe(true);
  });

  it("a clean scored question passes with no issues", () => {
    const check = checkDraft(
      draftOf([{ id: "q1", version: "1", subject: "m", answerKind: "single_choice", stem: "2+2? $x=4$", options: { A: "3", B: "4" }, scoring: { maxScore: 5, reference: "B" }, sourceFile: "f" }]),
    );
    expect(check.ok).toBe(true);
    expect(check.questions).toHaveLength(0);
  });
});

describe("ImportService asset preservation + version record (Next_Plan §3)", () => {
  it("confirmDraft copies referenced figures into public/, keeps originals, writes VERSION.json, isolates scoring", async () => {
    const { svc, datasetsRoot } = fresh();
    const srcDir = join(root, "src");
    mkdirSync(srcDir, { recursive: true });
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toFile(join(srcDir, "fig.png"));
    const original = readFileSync(join(srcDir, "fig.png"));
    writeFileSync(
      join(srcDir, "q.json"),
      JSON.stringify([{ id: "q1", answer_kind: "open", question: "看图 ![d](fig.png) 作答", assets: [{ ref: "fig.png" }], maxScore: 5, answer: "x" }]),
      "utf8",
    );
    const draft = svc.importSource(srcDir, { datasetId: "demo" });
    expect(svc.check(draft.draftId).questions).toHaveLength(0); // figure found in sourceDir

    const res = await svc.confirmDraft(draft.draftId);
    expect(res.assetsCopied).toBe(1);
    // figure available in public/ (the answering input); original untouched
    expect(readFileSync(join(datasetsRoot, "demo", "public", "fig.png"))).toEqual(original);
    expect(readFileSync(join(srcDir, "fig.png"))).toEqual(original);
    // version record with a content digest
    const ver = JSON.parse(readFileSync(join(datasetsRoot, "demo", "VERSION.json"), "utf8"));
    expect(ver.status).toBe("confirmed");
    expect(ver.questionIds).toEqual(["q1"]);
    expect(ver.publicDigest).toBeTruthy();
    // scoring isolated in scoring/, NOT in the answering input (public/)
    expect(existsSync(join(datasetsRoot, "demo", "scoring", "q1.json"))).toBe(true);
    expect(existsSync(join(datasetsRoot, "demo", "public", "q1.json"))).toBe(false);
  });

  it("a shared figure referenced by two questions is copied once and both keep the ref", async () => {
    const { svc, datasetsRoot } = fresh();
    const srcDir = join(root, "src");
    mkdirSync(srcDir, { recursive: true });
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).png().toFile(join(srcDir, "shared.png"));
    writeFileSync(
      join(srcDir, "q.json"),
      JSON.stringify([
        { id: "q1", answer_kind: "open", question: "a ![s](shared.png)", assets: [{ ref: "shared.png" }], maxScore: 3, answer: "x" },
        { id: "q2", answer_kind: "open", question: "b ![s](shared.png)", assets: [{ ref: "shared.png" }], maxScore: 3, answer: "y" },
      ]),
      "utf8",
    );
    const draft = svc.importSource(srcDir, { datasetId: "shared" });
    const res = await svc.confirmDraft(draft.draftId);
    expect(res.assetsCopied).toBe(1); // deduped
    expect(existsSync(join(datasetsRoot, "shared", "public", "shared.png"))).toBe(true);
    const q1md = readFileSync(join(datasetsRoot, "shared", "public", "q1.md"), "utf8");
    const q2md = readFileSync(join(datasetsRoot, "shared", "public", "q2.md"), "utf8");
    expect(q1md).toContain("shared.png");
    expect(q2md).toContain("shared.png");
  });
});
