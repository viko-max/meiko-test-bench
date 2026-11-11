import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
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

function ctx(workDir: string, publicDir: string, questionFiles: string[] = []): ToolContext {
  return { workDir, publicDir, questionFiles, pythonInterpreter: "python", tscEntry: "tsc", nodePath: "node", limits: { perToolTimeoutMs: 60000, maxOutputBytes: 262144, maxImagePixels: 16777216 } };
}

describe("P2-7 tool file boundary: no cross-question reach via links", () => {
  it("rejects a work-dir link to ANOTHER question's public file", () => {
    const workDir = tmp("p2-7-");
    const publicDir = tmp("p2-7-");
    mkdirSync(join(publicDir, "q2"), { recursive: true });
    writeFileSync(join(publicDir, "q2", "fig.png"), "x"); // another question's attachment
    const link = join(workDir, "linkdir");
    try {
      symlinkSync(join(publicDir, "q2"), link, "junction"); // no admin needed on Windows
    } catch {
      return; // privilege unavailable: skip
    }
    const c = ctx(workDir, publicDir, []); // THIS question allows no public files
    expect(() => resolveToolRef(c, "linkdir/fig.png")).toThrow(PathEscapeError);
  });

  it("still allows THIS question's allow-listed attachment and a real work-dir file", () => {
    const workDir = tmp("p2-7-");
    const publicDir = tmp("p2-7-");
    const qf = join(publicDir, "fig.png");
    writeFileSync(qf, "x");
    writeFileSync(join(workDir, "gen.txt"), "hi");
    const c = ctx(workDir, publicDir, [qf]);
    expect(resolveToolRef(c, "fig.png")).toContain("fig.png");
    expect(resolveToolRef(c, "gen.txt")).toContain("gen.txt");
    // a DIFFERENT public file (not allow-listed) is still rejected
    writeFileSync(join(publicDir, "secret.png"), "x");
    expect(() => resolveToolRef(c, "secret.png")).toThrow(PathEscapeError);
  });
});
