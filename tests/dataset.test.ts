import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { importDataset } from "../src/dataset/import.js";
import { buildSnapshot } from "../src/dataset/snapshot.js";

let root: string;
let publicDir: string;
let scoringDir: string;

async function tinyPng(): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png()
    .toBuffer();
}

function q(id: string, extra = ""): string {
  return `---\nid: ${id}\nversion: "1"\nsubject: physics\nanswer_kind: numeric_unit\n---\n\nFind the force.${extra}\n`;
}
function scoring(id: string, max = 10, rubricPoints = 10): string {
  return JSON.stringify({
    questionId: id,
    questionVersion: "1",
    scoringVersion: "1",
    answerKind: "numeric_unit",
    maxScore: max,
    reference: "6 N",
    rubric: [{ partLabel: "1", points: rubricPoints, acceptAlternatives: [] }],
    deterministicLocked: true,
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-ds-"));
  publicDir = join(root, "public");
  scoringDir = join(root, "scoring");
  mkdirSync(join(publicDir, "figures"), { recursive: true });
  mkdirSync(scoringDir, { recursive: true });

  writeFileSync(join(publicDir, "a.md"), q("q-a"));
  writeFileSync(join(scoringDir, "a.json"), scoring("q-a"));

  writeFileSync(join(publicDir, "b.md"), q("q-b", "\n\n![fig](figures/fig.png)\n"));
  writeFileSync(join(publicDir, "figures", "fig.png"), await tinyPng());
  writeFileSync(join(scoringDir, "b.json"), scoring("q-b", 10, 10));

  // duplicate id
  writeFileSync(join(publicDir, "dup1.md"), q("q-dup"));
  writeFileSync(join(publicDir, "dup2.md"), q("q-dup"));

  // missing attachment
  writeFileSync(join(publicDir, "miss.md"), q("q-miss", "\n\n![x](figures/nope.png)\n"));

  // undecodable image (garbage bytes)
  writeFileSync(join(publicDir, "bad.md"), q("q-bad", "\n\n![x](figures/bad.png)\n"));
  writeFileSync(join(publicDir, "figures", "bad.png"), Buffer.from("not a real png"));

  // scoring maxScore mismatch
  writeFileSync(join(publicDir, "mm.md"), q("q-mm"));
  writeFileSync(join(scoringDir, "mm.json"), scoring("q-mm", 10, 7));

  // unscored (no scoring file) -> warning only
  writeFileSync(join(publicDir, "uns.md"), q("q-uns"));

  // format error: no id
  writeFileSync(join(publicDir, "fmt.md"), `---\nversion: "1"\nsubject: physics\nanswer_kind: open\n---\n\nno id\n`);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function entry(res: Awaited<ReturnType<typeof importDataset>>, id: string) {
  return res.entries.find((e) => e.questionId === id)!;
}

describe("dataset import + validation", () => {
  it("imports valid text + image questions, blocks broken ones", async () => {
    const res = await importDataset({ datasetId: "demo", publicDir, scoringDir });

    const a = entry(res, "q-a");
    expect(a.errors).toEqual([]);
    expect(a.question?.subject).toBe("physics");
    expect(a.question?.assets).toHaveLength(0);
    expect(a.scoring?.maxScore).toBe(10);

    const b = entry(res, "q-b");
    expect(b.errors).toEqual([]);
    expect(b.question?.assets[0]?.ref).toBe("figures/fig.png");
    expect(b.question?.assets[0]?.mediaType).toBe("image/png");
  });

  it("flags duplicate id", async () => {
    const res = await importDataset({ datasetId: "demo", publicDir, scoringDir });
    const dups = res.entries.filter((e) => e.questionId === "q-dup");
    expect(dups.some((e) => e.errors.some((m) => m.includes("duplicate")))).toBe(true);
  });

  it("flags missing attachment and undecodable image", async () => {
    const res = await importDataset({ datasetId: "demo", publicDir, scoringDir });
    expect(entry(res, "q-miss").errors.some((m) => m.includes("missing attachment"))).toBe(true);
    expect(entry(res, "q-bad").errors.some((m) => m.includes("undecodable"))).toBe(true);
  });

  it("flags scoring point inconsistency", async () => {
    const res = await importDataset({ datasetId: "demo", publicDir, scoringDir });
    expect(entry(res, "q-mm").errors.some((m) => m.includes("!= maxScore"))).toBe(true);
  });

  it("marks unscored as a warning, not an error", async () => {
    const res = await importDataset({ datasetId: "demo", publicDir, scoringDir });
    const uns = entry(res, "q-uns");
    expect(uns.errors).toEqual([]);
    expect(uns.warnings.some((w) => w.startsWith("unscored"))).toBe(true);
    expect(uns.scoring).toBeUndefined();
  });

  it("rejects a question with malformed front-matter", async () => {
    const res = await importDataset({ datasetId: "demo", publicDir, scoringDir });
    const fmt = res.entries.find((e) => e.questionId === "fmt.md")!;
    expect(fmt.errors.length).toBeGreaterThan(0);
    expect(fmt.question).toBeUndefined();
  });

  it("builds a confirmed snapshot from error-free entries only", async () => {
    const res = await importDataset({ datasetId: "demo", publicDir, scoringDir });
    const snap = buildSnapshot("demo", "1", res.entries, "confirmed", "2026-10-08T00:00:00Z");
    expect(snap.status).toBe("confirmed");
    expect(snap.questionIds).toContain("q-a");
    expect(snap.questionIds).toContain("q-b");
    expect(snap.questionIds).not.toContain("q-mm"); // blocked by scoring error
    expect(snap.questionIds).not.toContain("q-miss");
    expect(snap.scoringVersion).toBe("1");
    expect(snap.publicDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
