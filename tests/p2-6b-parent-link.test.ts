import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveToolRef, type ToolContext } from "../src/tools/context.js";
import { PathEscapeError } from "../src/shared/errors.js";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function ctx(workDir: string, publicDir: string, questionFiles: string[], lstat?: ToolContext["lstat"]): ToolContext {
  return {
    workDir, publicDir, questionFiles, pythonInterpreter: "python", tscEntry: "tsc", nodePath: "node",
    limits: { perToolTimeoutMs: 60000, maxOutputBytes: 262144, maxImagePixels: 16777216 },
    ...(lstat ? { lstat } : {}),
  };
}

describe("P2-6b a parent-directory link must not smuggle an out-of-scope attachment", () => {
  it("rejects figures/fig.png when figures is a junction to another dir", () => {
    const workDir = tmp("p2-6-");
    const publicDir = tmp("p2-6-");
    const otherDir = tmp("p2-6-");
    writeFileSync(join(otherDir, "fig.png"), "x"); // real file, outside publicDir's declared tree
    const figures = join(publicDir, "figures");
    try {
      symlinkSync(otherDir, figures, "junction"); // junction: no admin needed on Windows
    } catch {
      return; // privilege unavailable: skip
    }
    const attachment = join(figures, "fig.png"); // declared as publicDir/figures/fig.png (through the junction)
    const c = ctx(workDir, publicDir, [attachment]);
    expect(() => resolveToolRef(c, "figures/fig.png")).toThrow(PathEscapeError);
  });

  it("a genuine nested attachment (no parent link) still resolves", () => {
    const workDir = tmp("p2-6-");
    const publicDir = tmp("p2-6-");
    mkdirSync(join(publicDir, "figures"), { recursive: true });
    const fig = join(publicDir, "figures", "fig.png");
    writeFileSync(fig, "x");
    const c = ctx(workDir, publicDir, [fig]);
    expect(resolveToolRef(c, "figures/fig.png")).toContain("fig.png");
  });
});
