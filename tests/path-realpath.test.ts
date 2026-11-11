import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
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
  return {
    workDir,
    publicDir,
    questionFiles,
    pythonInterpreter: "python",
    tscEntry: "tsc",
    nodePath: "node",
    limits: { perToolTimeoutMs: 60000, maxOutputBytes: 262144, maxImagePixels: 16777216 },
  };
}

describe("R2-2 resolveToolRef realpath hardening", () => {
  it("still resolves a real work-dir file and a question attachment", () => {
    const workDir = tmp("pi-work-");
    const publicDir = tmp("pi-pub-");
    writeFileSync(join(workDir, "gen.txt"), "hi");
    const qf = join(publicDir, "fig.png");
    writeFileSync(qf, "x");
    const c = ctx(workDir, publicDir, [qf]);
    expect(resolveToolRef(c, "gen.txt")).toContain("gen.txt");
    expect(resolveToolRef(c, "fig.png")).toContain("fig.png");
  });

  it("rejects a file that is neither a question attachment nor in the work dir", () => {
    const workDir = tmp("pi-work-");
    const publicDir = tmp("pi-pub-");
    writeFileSync(join(publicDir, "other.png"), "x"); // in public dir but NOT allow-listed
    const c = ctx(workDir, publicDir, []); // no allow-list
    expect(() => resolveToolRef(c, "other.png")).toThrow(PathEscapeError);
  });

  it("rejects a symlink/junction inside the work dir that escapes it", () => {
    const workDir = tmp("pi-work-");
    const publicDir = tmp("pi-pub-");
    const outside = tmp("pi-out-");
    writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
    const link = join(workDir, "linkdir");
    try {
      symlinkSync(outside, link, "junction"); // junction: no admin needed on Windows; symlink on POSIX
    } catch {
      return; // privilege unavailable: skip (cannot create the escape to test)
    }
    const c = ctx(workDir, publicDir);
    expect(() => resolveToolRef(c, "linkdir/secret.txt")).toThrow(PathEscapeError);
  });
});
