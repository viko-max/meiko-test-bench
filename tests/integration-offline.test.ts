import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, createModels } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { importDataset } from "../src/dataset/import.js";
import { buildSnapshot } from "../src/dataset/snapshot.js";
import { makeExamStreamFn } from "../src/providers/stream-fn.js";
import { runOneTrial } from "../src/runner/trial-service.js";
import { gradeTrial } from "../src/grading/grade.js";
import { buildModeReport } from "../src/reporting/report.js";
import { ProtectionLimitsSchema, PublicQuestionSchema, type AnswerMode, type Grade, type PublicQuestion, type RunSpec, type ScoringSpec, type Trial } from "../src/shared/contracts.js";

let root: string;
afterAll(() => root && rmSync(root, { recursive: true, force: true }));

function fauxStream(answer: string): { streamFn: StreamFn; model: ReturnType<ReturnType<typeof fauxProvider>["getModel"]> } {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(answer)]);
  return { streamFn: makeExamStreamFn(models), model: faux.getModel() };
}

describe("offline end-to-end: import -> two modes -> grade -> report (faux, no network)", () => {
  it("runs both modes independently and reports raw sums per mode", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-e2e-"));
    const publicDir = join(root, "public");
    const scoringDir = join(root, "scoring");
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(scoringDir, { recursive: true });

    writeFileSync(
      join(publicDir, "q1.md"),
      `---\nid: q1\nversion: "1"\nsubject: mathematics\nanswer_kind: single_choice\n---\n\n2+2=?\n\n- A. 3\n- B. 4\n- C. 5\n`,
    );
    writeFileSync(join(scoringDir, "q1.json"), JSON.stringify({ questionId: "q1", questionVersion: "1", scoringVersion: "1", answerKind: "single_choice", maxScore: 5, reference: "B", deterministicLocked: true }));
    writeFileSync(join(publicDir, "q2.md"), `---\nid: q2\nversion: "1"\nsubject: physics\nanswer_kind: numeric_unit\n---\n\nFind F for m=2,a=3.\n`);
    writeFileSync(join(scoringDir, "q2.json"), JSON.stringify({ questionId: "q2", questionVersion: "1", scoringVersion: "1", answerKind: "numeric_unit", maxScore: 10, reference: "6", tolerance: 0.01, units: ["N"], deterministicLocked: true }));

    const imported = await importDataset({ datasetId: "demo", publicDir, scoringDir });
    expect(imported.ok).toBe(true);
    const snap = buildSnapshot("demo", "1", imported.entries, "confirmed", "2026-10-08T00:00:00Z");
    expect(snap.questionIds).toEqual(["q1", "q2"]);

    const questions = new Map<string, PublicQuestion>();
    const scorings = new Map<string, ScoringSpec>();
    for (const e of imported.entries) {
      if (e.question) questions.set(e.questionId, e.question);
      if (e.scoring) scorings.set(e.questionId, e.scoring);
    }

    const runsRoot = join(root, "runs");
    const workRoot = join(root, "work");
    const limits = ProtectionLimitsSchema.parse({});
    const answers: Record<string, string> = { q1: "The answer is B.", q2: "F = 6 N" };

    const allTrials: Trial[] = [];
    const allGrades: Grade[] = [];
    const modes: AnswerMode[] = ["without_tool", "with_tool"];

    for (const mode of modes) {
      for (const qid of ["q1", "q2"]) {
        const q = questions.get(qid)!;
        const spec: RunSpec = {
          datasetId: "demo",
          datasetVersion: "1",
          questionId: q.id,
          questionVersion: q.version,
          provider: "faux",
          modelId: "faux-1",
          mode,
          promptVersion: "v1",
          toolsVersion: "v1",
          limits,
        };
        const { streamFn, model } = fauxStream(answers[qid]!);
        const { trial } = await runOneTrial({ runSpec: spec, question: q, index: 0, streamFn, model, tools: [], toolsVersion: "v1", runsRoot, workRoot });
        allTrials.push(trial);
        const g = gradeTrial(trial, q, scorings.get(qid), "2026-10-08T00:00:00Z");
        if (g.grade) allGrades.push(g.grade);
      }
    }

    const plannedMax = [...scorings.values()].reduce((a, s) => a + s.maxScore, 0); // 15
    for (const mode of modes) {
      const report = buildModeReport({ mode, trials: allTrials, grades: allGrades, questions, scorings, plannedMaxScore: plannedMax });
      // Each mode independently: q1 correct (5) + q2 correct (10) = 15 / 15.
      expect(report.totals.confirmedRaw).toBe(15);
      expect(report.totals.confirmedMax).toBe(15);
      expect(report.totals.plannedMax).toBe(15);
      expect(report.bySubject["mathematics"]).toEqual({ raw: 5, max: 5, counted: 1 });
      expect(report.bySubject["physics"]).toEqual({ raw: 10, max: 10, counted: 1 });
    }

    // Modes are separate records: 4 trials total (2 questions x 2 modes), one answer each.
    expect(allTrials).toHaveLength(4);
    expect(new Set(allTrials.map((t) => t.trialId)).size).toBe(4);
    expect(allTrials.every((t) => t.executionStatus === "completed")).toBe(true);
    expect(PublicQuestionSchema.safeParse(questions.get("q1")).success).toBe(true);
  });
});
