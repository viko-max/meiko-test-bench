/** calculate: safe arithmetic evaluation by walking a TypeScript AST. No eval, no
 *  Function, no transpile-to-JS, no subprocess — only ts.createSourceFile parsing
 *  plus a hand-written recursive evaluator over a small whitelist of node kinds. */
import ts from "typescript";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./context.js";
import { boundedUtf8 } from "../shared/utf8.js";

const MAX_EXPRESSION_CHARS = 4096;
const MAX_VARIABLES = 64;
const MAX_DEPTH = 64;
const MAX_NODES = 512;
const MAX_ARRAY_ITEMS = 1024;
const MAX_ERROR_CHARS = 256;

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const UNARY: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  ln: Math.log, log: Math.log, log10: Math.log10,
};
const STATS = new Set(["sum", "mean", "median", "variance", "stddev"]);

class CalcError extends Error {}

interface EvalEnv {
  vars: Record<string, number>;
  nodes: number;
}

function enter(env: EvalEnv, depth: number): number {
  env.nodes += 1;
  if (env.nodes > MAX_NODES) throw new CalcError(`expression too complex (node limit ${MAX_NODES})`);
  if (depth > MAX_DEPTH) throw new CalcError(`expression too deep (depth limit ${MAX_DEPTH})`);
  return depth + 1;
}

function finite(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CalcError(`${what} is not a finite number`);
  return value;
}

function evalNumber(node: ts.Expression, env: EvalEnv, depth: number): number {
  const next = enter(env, depth);
  switch (node.kind) {
    case ts.SyntaxKind.NumericLiteral: {
      const value = Number(node.getText());
      if (!Number.isFinite(value)) throw new CalcError(`invalid numeric literal: ${node.getText()}`);
      return value;
    }
    case ts.SyntaxKind.ParenthesizedExpression:
      return evalNumber((node as ts.ParenthesizedExpression).expression, env, next);
    case ts.SyntaxKind.PrefixUnaryExpression: {
      const unary = node as ts.PrefixUnaryExpression;
      const operand = finite(evalNumber(unary.operand, env, next), "operand");
      if (unary.operator === ts.SyntaxKind.PlusToken) return operand;
      if (unary.operator === ts.SyntaxKind.MinusToken) return finite(-operand, "result");
      throw new CalcError("only unary + and - are allowed");
    }
    case ts.SyntaxKind.BinaryExpression: {
      const binary = node as ts.BinaryExpression;
      const left = finite(evalNumber(binary.left, env, next), "operand");
      const right = finite(evalNumber(binary.right, env, next), "operand");
      switch (binary.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: return finite(left + right, "result");
        case ts.SyntaxKind.MinusToken: return finite(left - right, "result");
        case ts.SyntaxKind.AsteriskToken: return finite(left * right, "result");
        case ts.SyntaxKind.SlashToken: return finite(left / right, "result");
        case ts.SyntaxKind.PercentToken: return finite(left % right, "result");
        case ts.SyntaxKind.AsteriskAsteriskToken: return finite(left ** right, "result");
        default: throw new CalcError(`operator not allowed: ${binary.operatorToken.getText()}`);
      }
    }
    case ts.SyntaxKind.Identifier: {
      const name = (node as ts.Identifier).text;
      if (Object.hasOwn(CONSTANTS, name)) return CONSTANTS[name]!;
      if (Object.hasOwn(env.vars, name)) return finite(env.vars[name]!, `variable ${name}`);
      throw new CalcError(`unknown variable: ${name}`);
    }
    case ts.SyntaxKind.CallExpression:
      return evalCall(node as ts.CallExpression, env, next);
    default:
      throw new CalcError(`expression element not allowed: ${ts.SyntaxKind[node.kind]}`);
  }
}

function evalCall(call: ts.CallExpression, env: EvalEnv, depth: number): number {
  if (call.expression.kind !== ts.SyntaxKind.Identifier) {
    throw new CalcError("only direct calls to whitelisted functions are allowed");
  }
  const name = (call.expression as ts.Identifier).text;
  const args = call.arguments;
  if (Object.hasOwn(UNARY, name)) {
    if (args.length !== 1) throw new CalcError(`${name} expects exactly 1 argument, got ${args.length}`);
    return finite(UNARY[name]!(finite(evalNumber(args[0]!, env, depth), "argument")), `${name} result`);
  }
  if (name === "pow") {
    if (args.length !== 2) throw new CalcError(`pow expects exactly 2 arguments, got ${args.length}`);
    const base = finite(evalNumber(args[0]!, env, depth), "argument");
    const exponent = finite(evalNumber(args[1]!, env, depth), "argument");
    return finite(base ** exponent, "pow result");
  }
  if (name === "min" || name === "max") {
    if (args.length < 1) throw new CalcError(`${name} expects at least 1 argument`);
    const values = args.map((arg) => finite(evalNumber(arg, env, depth), "argument"));
    return finite(name === "min" ? Math.min(...values) : Math.max(...values), `${name} result`);
  }
  if (STATS.has(name)) {
    if (args.length !== 1) throw new CalcError(`${name} expects exactly 1 array argument, got ${args.length}`);
    return finite(applyStat(name, evalNumberArray(args[0]!, env, depth)), `${name} result`);
  }
  throw new CalcError(`unknown function: ${name}`);
}

function evalNumberArray(node: ts.Expression, env: EvalEnv, depth: number): number[] {
  if (node.kind !== ts.SyntaxKind.ArrayLiteralExpression) {
    throw new CalcError(`${ts.SyntaxKind[node.kind]} is not a numeric array literal`);
  }
  const elements = (node as ts.ArrayLiteralExpression).elements;
  if (elements.length === 0) throw new CalcError("array must not be empty");
  if (elements.length > MAX_ARRAY_ITEMS) throw new CalcError(`array too long (limit ${MAX_ARRAY_ITEMS} items)`);
  const values: number[] = [];
  for (const element of elements) {
    enter(env, depth);
    values.push(finite(evalNumber(element, env, depth + 1), "array element"));
  }
  return values;
}

function applyStat(name: string, values: number[]): number {
  const n = values.length;
  const sum = values.reduce((acc, v) => acc + v, 0);
  switch (name) {
    case "sum": return sum;
    case "mean": return sum / n;
    case "median": {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = n >> 1;
      return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    }
    case "variance": {
      const mean = sum / n;
      return values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
    }
    case "stddev": {
      const mean = sum / n;
      return Math.sqrt(values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n);
    }
    default:
      throw new CalcError(`unknown function: ${name}`);
  }
}

function validateVariables(raw: unknown): Record<string, number> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CalcError("variables must be an object of name -> finite number");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_VARIABLES) throw new CalcError(`too many variables (limit ${MAX_VARIABLES})`);
  const vars: Record<string, number> = {};
  for (const [name, value] of entries) {
    if (!/^[$A-Z_a-z][$\w]*$/.test(name)) throw new CalcError(`invalid variable name: ${name}`);
    if (typeof value !== "number" || !Number.isFinite(value)) throw new CalcError(`variable ${name} must be a finite number`);
    vars[name] = value;
  }
  return vars;
}

export function calculateTool(ctx: ToolContext): AgentTool {
  return {
    name: "calculate",
    label: "Calculate",
    description:
      "Evaluate ONE mathematical expression and return `result = <number>`. Allowed: arithmetic " +
      "operators + - * / % **, parentheses, numeric variables, the constants pi and e, and direct calls to " +
      "sqrt abs exp floor ceil round; sin cos tan asin acos atan (angles in RADIANS); ln and log (natural " +
      "logarithm) and log10 (common logarithm); pow(x, n); min and max; and sum mean median variance stddev " +
      "over one numeric array argument. variance/stddev are the POPULATION variance/stddev. Nothing else is " +
      "accepted: no property/element access, no strings, objects, assignments, arrows, new, this, await, " +
      "import, require, conditionals or any other syntax.",
    parameters: Type.Object({
      expression: Type.String(),
      variables: Type.Optional(Type.Record(Type.String(), Type.Number())),
    }),
    execute: async (_id, args) => {
      const { expression, variables } = args as { expression?: unknown; variables?: unknown };
      try {
        if (typeof expression !== "string") throw new CalcError("expression must be a string");
        if (expression.length > MAX_EXPRESSION_CHARS) {
          throw new CalcError(`expression too long (limit ${MAX_EXPRESSION_CHARS} characters)`);
        }
        const env: EvalEnv = { vars: validateVariables(variables), nodes: 0 };
        const source = ts.createSourceFile("calc.ts", expression, ts.ScriptTarget.ES2022, /* setParentNodes */ true);
        const parseDiagnostics = (source as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
        if (parseDiagnostics.length > 0) {
          throw new CalcError(`invalid expression: ${ts.flattenDiagnosticMessageText(parseDiagnostics[0]!.messageText, " ")}`);
        }
        if (source.statements.length !== 1 || !ts.isExpressionStatement(source.statements[0]!)) {
          throw new CalcError("expression must be exactly one arithmetic expression");
        }
        const result = finite(evalNumber(source.statements[0]!.expression, env, 1), "result");
        const text = boundedUtf8(`result = ${result}`, ctx.limits.maxOutputBytes).text;
        return { content: [{ type: "text", text }], details: { expression, result } };
      } catch (e) {
        const message = e instanceof CalcError ? e.message : `unexpected error: ${(e as Error).message ?? String(e)}`;
        const capped = message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
        const text = boundedUtf8(`calculate error: ${capped}`, ctx.limits.maxOutputBytes).text;
        return { content: [{ type: "text", text }], details: {}, isError: true };
      }
    },
  };
}
