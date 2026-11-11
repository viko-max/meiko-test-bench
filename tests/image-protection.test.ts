import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { processImageTool, viewImageTool } from "../src/tools/image.js";
import type { ToolContext } from "../src/tools/context.js";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function ctx(workDir: string, publicDir: string, maxImagePixels = 1_000_000): ToolContext {
  return {
    workDir,
    publicDir,
    questionFiles: [],
    pythonInterpreter: "python",
    tscEntry: "tsc",
    nodePath: "node",
    limits: { perToolTimeoutMs: 60000, maxOutputBytes: 262144, maxImagePixels },
  };
}

async function run(tool: ReturnType<typeof processImageTool>, args: Record<string, unknown>) {
  const r = await tool.execute("t", args as never);
  return r as { content: Array<{ type: string; text?: string }>; details: Record<string, unknown>; isError?: boolean };
}

async function makePng(path: string, w: number, h: number): Promise<void> {
  await sharp({ create: { width: w, height: h, channels: 3, background: { r: 12, g: 34, b: 56 } } })
    .png()
    .toFile(path);
}

describe("R2-1 image protection: crop-then-scale + pixel cap", () => {
  it("scale applies to the CROPPED size, not the original", async () => {
    const workDir = tmp("pi-img-");
    await makePng(join(workDir, "src.png"), 200, 200);
    const r = await run(processImageTool(ctx(workDir, workDir)), { path: "src.png", crop: { left: 0, top: 0, width: 100, height: 100 }, scale: 0.5 });
    expect(r.isError).toBeFalsy();
    // cropped 100x100 then scaled 0.5 -> 50x50 (NOT 100x100 from scaling the original width)
    expect(r.details.width).toBe(50);
    expect(r.details.height).toBe(50);
  });

  it("crop is clamped to the image bounds (no sharp throw)", async () => {
    const workDir = tmp("pi-img-");
    await makePng(join(workDir, "src.png"), 80, 60);
    const r = await run(processImageTool(ctx(workDir, workDir)), { path: "src.png", crop: { left: 40, top: 30, width: 999, height: 999 } });
    expect(r.isError).toBeFalsy();
    expect(r.details.width).toBe(40); // 80-40
    expect(r.details.height).toBe(30); // 60-30
  });

  it("view_image refuses an image over the pixel limit (must downscale via process_image)", async () => {
    const workDir = tmp("pi-img-");
    await makePng(join(workDir, "big.png"), 1200, 1200); // 1.44M px
    const r = await run(viewImageTool(ctx(workDir, workDir, 500_000)), { path: "big.png" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/pixel limit|exceeds/i);
  });

  it("process_image refuses output over the pixel limit", async () => {
    const workDir = tmp("pi-img-");
    await makePng(join(workDir, "src.png"), 1000, 1000); // 1M px
    const r = await run(processImageTool(ctx(workDir, workDir, 500_000)), { path: "src.png", scale: 1 }); // no downscale
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/pixel limit|exceeds/i);
  });

  it("process_image CAN downscale an over-limit image under the cap", async () => {
    const workDir = tmp("pi-img-");
    await makePng(join(workDir, "src.png"), 1000, 1000); // 1M px
    const r = await run(processImageTool(ctx(workDir, workDir, 500_000)), { path: "src.png", scale: 0.5 }); // -> 500x500 = 250k
    expect(r.isError).toBeFalsy();
    expect(r.details.width).toBe(500);
  });
});
