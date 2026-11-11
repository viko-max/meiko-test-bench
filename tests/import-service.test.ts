import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ImportService } from "../src/import/import-service.js";
import { importDataset } from "../src/dataset/import.js";

let root: string;

function fresh(): { svc: ImportService; datasetsRoot: string; importRoot: string } {
  mkdirSync(resolve(".work"), { recursive: true });
  root = mkdtempSync(resolve(".work", "import-service-"));
  const datasetsRoot = join(root, "datasets");
  const importRoot = join(root, ".import");
  mkdirSync(datasetsRoot, { recursive: true });
  return { svc: new ImportService(datasetsRoot, importRoot), datasetsRoot, importRoot };
}

const MD = `## 1\nWhat is 2+2?\n\n- A. 3\n- B. 4\n- C. 5\n\n## 2\nExplain why the sky is blue.\n`;

describe("ImportService (Next_Plan §3): draft staging never touches the formal bank", () => {
  it("imports a Markdown source into a STAGED draft; datasets/ stays clean until confirm", async () => {
    const { svc, datasetsRoot } = fresh();
    const src = join(root, "src.md");
    writeFileSync(src, MD, "utf8");
    const draft = svc.importSource(src, { datasetId: "demo" });
    expect(draft.status).toBe("draft");
    expect(draft.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(draft.questions[0]!.answerKind).toBe("single_choice");
    expect(Object.keys(draft.questions[0]!.options ?? {})).toEqual(["A", "B", "C"]);
    expect(draft.questions[1]!.answerKind).toBe("open");
    // unscored -> warnings, and NO formal dataset written yet
    expect(draft.warnings.some((w) => w.includes("缺少完整评分依据"))).toBe(true);
    expect(existsSync(join(datasetsRoot, "demo"))).toBe(false);
    expect(svc.listDrafts().map((d) => d.draftId)).toContain(draft.draftId);
  });

  it("confirmDraft writes canonical public/scoring readable by importDataset", async () => {
    const { svc, datasetsRoot } = fresh();
    const src = join(root, "src.json");
    writeFileSync(
      src,
      JSON.stringify({
        questions: [
          { id: "q1", subject: "math", answer_kind: "single_choice", question: "2+2?", options: { A: "3", B: "4" }, answer: "B", maxScore: 5 },
          { id: "q2", subject: "physics", answer_kind: "open", question: "Explain gravity." },
        ],
      }),
      "utf8",
    );
    const draft = svc.importSource(src, { datasetId: "demo" });
    expect(draft.questions[0]!.scoring?.maxScore).toBe(5);
    expect(draft.questions[1]!.scoring).toBeUndefined(); // unscored, not guessed

    const res = await svc.confirmDraft(draft.draftId);
    expect(res).toMatchObject({ datasetId: "demo", questions: 2, scored: 1 });
    expect(existsSync(join(datasetsRoot, "demo", "public", "q1.md"))).toBe(true);
    expect(existsSync(join(datasetsRoot, "demo", "scoring", "q1.json"))).toBe(true);
    expect(existsSync(join(datasetsRoot, "demo", "scoring", "q2.json"))).toBe(false); // unscored

    // round-trip: the formal bank reads back cleanly with the scoring basis intact
    const imported = await importDataset({ datasetId: "demo", publicDir: join(datasetsRoot, "demo", "public"), scoringDir: join(datasetsRoot, "demo", "scoring") });
    const q1 = imported.entries.find((e) => e.questionId === "q1")!;
    expect(q1.errors).toEqual([]);
    expect(q1.question?.answerKind).toBe("single_choice");
    expect(q1.scoring?.maxScore).toBe(5);
    expect(q1.scoring?.reference).toBe("B");
    const q2 = imported.entries.find((e) => e.questionId === "q2")!;
    expect(q2.scoring).toBeUndefined();
    expect(q2.warnings.some((w) => /unscored/.test(w))).toBe(true);

    // bank listing reflects the confirmed dataset
    expect(svc.listBank()).toContainEqual({ datasetId: "demo", questions: 2 });
  });

  it("discardDraft archives the draft and preserves its files; the formal bank is never polluted", () => {
    const { svc, datasetsRoot, importRoot } = fresh();
    const src = join(root, "src.md");
    writeFileSync(src, MD, "utf8");
    const draft = svc.importSource(src, { datasetId: "demo" });
    svc.discardDraft(draft.draftId);
    expect(existsSync(join(importRoot, draft.draftId))).toBe(true);
    expect(svc.getDraft(draft.draftId)?.status).toBe("discarded");
    expect(existsSync(join(datasetsRoot, "demo"))).toBe(false); // cancel -> nothing in the bank
    expect(svc.listDrafts()).toHaveLength(0);
  });

  it("confirming an already-confirmed draft is refused (no double promote)", async () => {
    const { svc } = fresh();
    const src = join(root, "src.json");
    writeFileSync(src, JSON.stringify([{ id: "q1", answer_kind: "open", question: "hi", maxScore: 3, answer: "x" }]), "utf8");
    const draft = svc.importSource(src, { datasetId: "demo" });
    await svc.confirmDraft(draft.draftId);
    await expect(svc.confirmDraft(draft.draftId)).rejects.toThrow(/already confirmed/);
  });
});
