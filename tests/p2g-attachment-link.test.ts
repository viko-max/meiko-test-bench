import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("P2-G a declared attachment that is itself a LINK is not auto-authorized", () => {
  it("rejects a whitelisted attachment whose real target is a link (simulated via lstat)", () => {
    const workDir = tmp("p2g-");
    const publicDir = tmp("p2g-");
    const fig = join(publicDir, "fig.png");
    writeFileSync(fig, "x");
    // Simulate fig.png being a symbolic link to some other file.
    const c = ctx(workDir, publicDir, [fig], (p) => ({ isSymbolicLink: () => p.endsWith("fig.png") }));
    expect(() => resolveToolRef(c, "fig.png")).toThrow(PathEscapeError);
  });

  it("a regular (non-link) declared attachment still resolves", () => {
    const workDir = tmp("p2g-");
    const publicDir = tmp("p2g-");
    const fig = join(publicDir, "fig.png");
    writeFileSync(fig, "x");
    const c = ctx(workDir, publicDir, [fig], () => ({ isSymbolicLink: () => false }));
    expect(resolveToolRef(c, "fig.png")).toContain("fig.png");
  });
});
