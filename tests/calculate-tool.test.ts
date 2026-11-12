import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtectionLimitsSchema } from "../src/shared/contracts.js";
import { makeToolContext, buildExamTools } from "../src/tools/index.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const root = mkdtempSync(join(tmpdir(), "pi-calc-"));
mkdirSync(join(root, "work"), { recursive: true });
mkdirSync(join(root, "public"), { recursive: true });
const ctx = makeToolContext({
  workDir: join(root, "work"),
  publicDir: join(root, "public"),
  questionFiles: [],
  pythonInterpreter: "python",
  limits: ProtectionLimitsSchema.parse({ perToolTimeoutMs: 1500, maxOutputBytes: 65536 }),
});
const tool: AgentTool = buildExamTools(ctx).find((t) => t.name === "calculate")!;

afterAll(() => rmSync(root, { recursive: true, force: true }));

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

async function valueOf(expression: string, variables?: Record<string, number>): Promise<number> {
  const res = await tool.execute("t", variables === undefined ? { expression } : { expression, variables });
  expect(res.isError, textOf(res)).toBeUndefined();
  const match = /^result = (\S+)$/.exec(textOf(res).trim());
  expect(match, textOf(res)).toBeTruthy();
  return Number(match![1]);
}

async function expectError(args: unknown): Promise<void> {
  const res = await tool.execute("t", args);
  expect(res.isError, `expected error, got: ${textOf(res)}`).toBe(true);
  expect(textOf(res)).toContain("calculate error:");
}

describe("calculate tool: real evaluation", () => {
  it("正式工具集顺序为 calculate + read_file + view_image + process_image，且不包含 exec 工具", () => {
    expect(buildExamTools(ctx).map((t) => t.name)).toEqual(["calculate", "read_file", "view_image", "process_image"]);
  });

  it("运算符优先级与括号", async () => {
    expect(await valueOf("2 + 3 * 4")).toBe(14);
    expect(await valueOf("(2 + 3) * 4")).toBe(20);
    expect(await valueOf("10 - 2 - 3")).toBe(5);
    expect(await valueOf("100 % 7")).toBe(2);
  });

  it("负数与幂", async () => {
    expect(await valueOf("-3 + 1")).toBe(-2);
    expect(await valueOf("(-3) ** 2")).toBe(9);
    expect(await valueOf("2 ** 10")).toBe(1024);
    expect(await valueOf("1 - -2")).toBe(3);
  });

  it("变量与 pi/e 常量", async () => {
    expect(await valueOf("a * b + c", { a: 2, b: 3, c: 1 })).toBe(7);
    expect(await valueOf("2 * pi")).toBeCloseTo(2 * Math.PI);
    expect(await valueOf("e")).toBeCloseTo(Math.E);
  });

  it("sqrt/sin/log/log10（弧度制与自然对数）", async () => {
    expect(await valueOf("sqrt(2)")).toBeCloseTo(Math.SQRT2);
    expect(await valueOf("sin(pi / 2)")).toBeCloseTo(1);
    expect(await valueOf("log(e)")).toBeCloseTo(1);
    expect(await valueOf("ln(e ** 2)")).toBeCloseTo(2);
    expect(await valueOf("log10(1000)")).toBeCloseTo(3);
  });

  it("min/max/pow", async () => {
    expect(await valueOf("min(3, 1, 2)")).toBe(1);
    expect(await valueOf("max(4)")).toBe(4);
    expect(await valueOf("pow(2, 10)")).toBe(1024);
    expect(await valueOf("abs(-5)")).toBe(5);
    expect(await valueOf("round(2.5)")).toBe(3);
    expect(await valueOf("floor(-1.5)")).toBe(-2);
  });

  it("sum/mean/median/variance/stddev（总体公式）", async () => {
    expect(await valueOf("sum([1, 2, 3])")).toBe(6);
    expect(await valueOf("mean([1, 2, 3, 4])")).toBe(2.5);
    expect(await valueOf("median([1, 3, 2])")).toBe(2);
    expect(await valueOf("median([4, 1, 2, 3])")).toBe(2.5);
    expect(await valueOf("variance([2, 4, 4, 4, 5, 5, 7, 9])")).toBeCloseTo(4);
    expect(await valueOf("stddev([2, 4, 4, 4, 5, 5, 7, 9])")).toBeCloseTo(2);
    expect(await valueOf("stddev([x * 2, x * 4, x * 4, x * 4, x * 5, x * 5, x * 7, x * 9])", { x: 1 })).toBeCloseTo(2);
  });

  it("成功 details 包含 expression 和 result", async () => {
    const res = await tool.execute("t", { expression: "1 + 1" });
    expect(res.details).toEqual({ expression: "1 + 1", result: 2 });
  });

  it("非有限结果（开负数、除零、负底数分数幂）", async () => {
    await expectError({ expression: "sqrt(-1)" });
    await expectError({ expression: "1 / 0" });
    await expectError({ expression: "pow(-1, 0.5)" });
    await expectError({ expression: "0 / 0" });
  });

  it("未知变量与未知函数", async () => {
    await expectError({ expression: "zz + 1" });
    await expectError({ expression: "nosuchfn(1)" });
    await expectError({ expression: "Math.sqrt(4)" });
    await expectError({ expression: "foo.bar(1)" });
  });

  it("错误 arity 与空数组", async () => {
    await expectError({ expression: "pow(2)" });
    await expectError({ expression: "pow(2, 3, 4)" });
    await expectError({ expression: "sqrt(1, 2)" });
    await expectError({ expression: "min()" });
    await expectError({ expression: "sum()" });
    await expectError({ expression: "sum([1], 2)" });
    await expectError({ expression: "sum([])" });
    await expectError({ expression: "mean([])" });
    await expectError({ expression: "sum(1)" });
  });

  it("非法 variables（数量、命名、值）", async () => {
    await expectError({ expression: "1", variables: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`v${i}`, 1])) });
    await expectError({ expression: "1", variables: { "not a name": 1 } });
    await expectError({ expression: "1", variables: { bad: "1" } });
    await expectError({ expression: "1", variables: { bad: Infinity } });
    await expectError({ expression: "1", variables: { bad: NaN } });
    await expectError({ expression: "1", variables: [1, 2] });
    await expectError({ expression: "1", variables: "nope" });
  });

  it("超限输入：长度、深度、节点数", async () => {
    await expectError({ expression: "1 + 1 + 1".padEnd(4100, " + 1") });
    await expectError({ expression: "(".repeat(70) + "1" + ")".repeat(70) });
    await expectError({ expression: Array.from({ length: 600 }, () => "1").join(" + ") });
  });

  it("超长数组拒绝", async () => {
    const big = `[${Array.from({ length: 1025 }, (_, i) => i).join(",")}]`;
    await expectError({ expression: `sum(${big})` });
  });
});

describe("calculate tool: hostile input is rejected without execution", () => {
  const hostile: Array<[string, unknown]> = [
    ["process.env", { expression: "process.env" }],
    ["require('fs')", { expression: "require('fs')" }],
    ["import('node:fs')", { expression: "import('node:fs')" }],
    ["fetch URL", { expression: "fetch('http://127.0.0.1')" }],
    ["Math.random()", { expression: "Math.random()" }],
    ["globalThis", { expression: "globalThis" }],
    ["constructor", { expression: "constructor" }],
    ["arrow IIFE", { expression: "(()=>1)()" }],
    ["assignment", { expression: "x=1", variables: { x: 1 } }],
    ["element access", { expression: "[1][0]" }],
    ["object literal", { expression: "{a:1}" }],
    ["new expression", { expression: "new Date()" }],
    ["this", { expression: "this" }],
    ["await", { expression: "await 1" }],
    ["string literal", { expression: "'abc'" }],
    ["template literal", { expression: "`abc ${1}`" }],
    ["conditional", { expression: "true ? 1 : 2" }],
    ["spread in array", { expression: "sum([...[1, 2]])" }],
    ["sequence/semicolon", { expression: "1; 2" }],
    ["typeof", { expression: "typeof 1" }],
  ];

  for (const [label, args] of hostile) {
    it(`rejects ${label}`, async () => {
      await expectError(args);
    });
  }
});
