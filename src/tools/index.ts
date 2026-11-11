/** Exam tool set assembly (AGENTS.md §9). */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./context.js";
import { executePythonTool } from "./exec-python.js";
import { executeTypeScriptTool } from "./exec-typescript.js";
import { readFileTool } from "./read-file.js";
import { processImageTool, viewImageTool } from "./image.js";

const require = createRequire(import.meta.url);

export function resolveTscEntry(): string {
  const pkgJson = require.resolve("typescript/package.json");
  return join(dirname(pkgJson), "bin", "tsc");
}

export interface ToolContextInit {
  workDir: string;
  publicDir: string;
  questionFiles: string[]; // current question's allowed attachment paths
  pythonInterpreter: string;
  limits: ToolContext["limits"];
  tscEntry?: string;
  nodePath?: string;
}

export function makeToolContext(init: ToolContextInit): ToolContext {
  return {
    workDir: resolve(init.workDir),
    publicDir: resolve(init.publicDir),
    questionFiles: init.questionFiles.map((f) => resolve(f)),
    pythonInterpreter: isPathLike(init.pythonInterpreter) ? resolve(init.pythonInterpreter) : init.pythonInterpreter,
    limits: init.limits,
    tscEntry: init.tscEntry ?? resolveTscEntry(),
    nodePath: init.nodePath ?? process.execPath,
  };
}

function isPathLike(p: string): boolean {
  return p.includes("/") || p.includes("\\") || p.startsWith(".");
}

export const EXAM_TOOLS_VERSION = "v1";

export function buildExamTools(ctx: ToolContext): AgentTool[] {
  return [executePythonTool(ctx), executeTypeScriptTool(ctx), readFileTool(ctx), viewImageTool(ctx), processImageTool(ctx)];
}
