import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ProtectionLimitsSchema } from "../src/shared/contracts.js";
import { makeToolContext, buildExamTools } from "../src/tools/index.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";

let root: string;
let workDir: string;
let publicDir: string;
let tools: Record<string, AgentTool>;

const PY = process.env.PI_EXAM_TEST_PYTHON ?? "python";

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-tools-"));
  workDir = join(root, "work");
  publicDir = join(root, "public");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(publicDir, { recursive: true });

  writeFileSync(join(publicDir, "data.txt"), "col\n1\n2\n3\n");
  writeFileSync(join(publicDir, "fig.png"), await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer());
  writeFileSync(join(publicDir, "other_question_secret.txt"), "OTHER QUESTIONS DATA"); // must NOT be readable (P2-7)
  writeFileSync(join(publicDir, "other.png"), await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 1, b: 1 } } }).png().toBuffer());

  const ctx = makeToolContext({
    workDir,
    publicDir,
    questionFiles: [join(publicDir, "data.txt"), join(publicDir, "fig.png")],
    pythonInterpreter: PY,
    limits: ProtectionLimitsSchema.parse({ perToolTimeoutMs: 1500, maxOutputBytes: 65536 }),
  });
  const list = buildExamTools(ctx);
  tools = Object.fromEntries(list.map((t) => [t.name, t]));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("local tools: real execution", () => {
  it("正式工具名精确为四个，且不含 execute_python/execute_typescript", () => {
    expect(Object.keys(tools).sort()).toEqual(["calculate", "process_image", "read_file", "view_image"]);
  });

  it("calculate evaluates arithmetic and returns result = <number>", async () => {
    const res = await tools["calculate"]!.execute("c0", { expression: "(2 + 3) * 4" });
    expect(textOf(res)).toContain("result = 20");
    expect(res.isError).toBeUndefined();
  });

  it("calculate rejects host access (no eval, no subprocess)", async () => {
    const res = await tools["calculate"]!.execute("c0b", { expression: "process.env" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("calculate error:");
  });

  it("read_file reads an allowed current-question attachment", async () => {
    const ok = await tools["read_file"]!.execute("c5", { path: "data.txt" });
    expect(textOf(ok)).toContain("col");
    expect(ok.isError).toBeUndefined();
  });

  it("P2-7: read_file rejects ANOTHER question's file and path escapes", async () => {
    const other = await tools["read_file"]!.execute("c6", { path: "other_question_secret.txt" });
    expect(other.isError).toBe(true);
    const esc = await tools["read_file"]!.execute("c6b", { path: "../secret.txt" });
    expect(esc.isError).toBe(true);
  });

  it("view_image returns a native image + dimensions", async () => {
    const res = await tools["view_image"]!.execute("c7", { path: "fig.png" });
    const img = res.content.find((c) => c.type === "image") as { type: "image"; data: string; mimeType: string } | undefined;
    expect(img).toBeTruthy();
    expect(img!.mimeType).toBe("image/png");
    expect(textOf(res)).toContain("8x8");
  });

  it("view_image rejects another question's image", async () => {
    const res = await tools["view_image"]!.execute("c7b", { path: "other.png" });
    expect(res.isError).toBe(true);
  });

  it("process_image scales and preserves the original", async () => {
    const before = statSync(join(publicDir, "fig.png")).size;
    const res = await tools["process_image"]!.execute("c8", { path: "fig.png", scale: 0.5 });
    const img = res.content.find((c) => c.type === "image");
    expect(img).toBeTruthy();
    expect(textOf(res)).toContain("4x4");
    expect(statSync(join(publicDir, "fig.png")).size).toBe(before);
  });
});
