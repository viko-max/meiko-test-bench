import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
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
  it("execute_python really runs and returns stdout + exit 0", async () => {
    const res = await tools["execute_python"]!.execute("c1", { code: "print('py', 2+3)" });
    expect(textOf(res)).toContain("py 5");
    expect(textOf(res)).toContain("exit=0");
    expect(res.isError).toBeUndefined();
  });

  it("execute_python can import the project compute libs (numpy/sympy)", async () => {
    const res = await tools["execute_python"]!.execute("c1b", {
      code: "import numpy, sympy\nx=sympy.symbols('x')\nprint('roots', sympy.solve(sympy.Eq(x**2-4,0), x))\nprint('numpy', numpy.__version__)",
    });
    expect(textOf(res)).toContain("roots");
    expect(textOf(res)).toContain("numpy");
    expect(res.isError).toBeUndefined();
  });

  it("execute_typescript compiles with project tsc and runs in node", async () => {
    const res = await tools["execute_typescript"]!.execute("c3", { code: "const x: number = 21 * 2;\nconsole.log('ts', x);" });
    expect(textOf(res)).toContain("ts 42");
    expect(textOf(res)).toContain("exit=0");
  });

  it("execute_typescript reports compile diagnostics", async () => {
    const res = await tools["execute_typescript"]!.execute("c4", { code: "const x: number = 'nope';" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("compile FAILED");
  });

  it("P2-8: execute_typescript runs import/export code inside the project .work (ESM)", async () => {
    const rel = ".work/_tsesm";
    mkdirSync(rel, { recursive: true });
    try {
      const ctx = makeToolContext({ workDir: rel, publicDir, questionFiles: [], pythonInterpreter: PY, limits: ProtectionLimitsSchema.parse({ perToolTimeoutMs: 120000 }) });
      const [, tsTool] = buildExamTools(ctx);
      const res = await tsTool.execute("esm", { code: "export const mod = (n: number): number => n + 1;\nconsole.log('esm-ok', mod(41));" });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain("esm-ok 42");
    } finally {
      rmSync(rel, { recursive: true, force: true });
    }
  }, 30000);

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

  it("strips harness API-key env vars from the subprocess", async () => {
    process.env.PI_EXAM_FAKE_API_KEY = "secret123";
    try {
      const res = await tools["execute_python"]!.execute("c9", {
        code: "import os; print('KEY=' + str(os.environ.get('PI_EXAM_FAKE_API_KEY')))",
      });
      expect(textOf(res)).toContain("KEY=None");
    } finally {
      delete process.env.PI_EXAM_FAKE_API_KEY;
    }
  });

  it("times out and kills the whole process tree (Windows taskkill /T /F)", async () => {
    const hb = join(workDir, "hb.txt");
    const code =
      "import subprocess, sys, time, os\n" +
      `hb = ${JSON.stringify(hb)}\n` +
      "child = subprocess.Popen([sys.executable, '-c', \"import time\\nwhile True:\\n    open(hb,'a').write('x')\\n    time.sleep(0.03)\"])\n" +
      "time.sleep(30)\n";
    const res = await tools["execute_python"]!.execute("c10", { code });
    expect(textOf(res)).toContain("timedOut=true");
    const size1 = existsSync(hb) ? statSync(hb).size : 0;
    await new Promise((r) => setTimeout(r, 500));
    const size2 = existsSync(hb) ? statSync(hb).size : 0;
    expect(size2).toBe(size1);
  }, 15000);

  it("regression: execute_python works with a RELATIVE workDir (batch uses workRoot='.work')", async () => {
    const rel = "tests/.tmp-relwork";
    mkdirSync(rel, { recursive: true });
    try {
      const ctx = makeToolContext({ workDir: rel, publicDir, questionFiles: [], pythonInterpreter: PY, limits: ProtectionLimitsSchema.parse({ perToolTimeoutMs: 60000 }) });
      const [py] = buildExamTools(ctx);
      const res = await py.execute("crel", { code: "print('relok', 6*7)" });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain("exit=0");
      expect(textOf(res)).toContain("relok 42");
    } finally {
      rmSync(rel, { recursive: true, force: true });
    }
  }, 20000);
});
