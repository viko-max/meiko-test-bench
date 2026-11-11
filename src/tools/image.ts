/** view_image + process_image: native image results (sharp). Scope: current question + work dir.
 *
 *  R2-1 protection:
 *   - view_image REFUSES an image over the pixel limit (the model must downscale
 *     via process_image) so a huge attachment can never blow up the payload.
 *   - process_image clamps crop to the image bounds and applies scale to the
 *     CROPPED size (not the original); output over the pixel limit is rejected.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./context.js";
import { resolveToolRef } from "./context.js";

export function viewImageTool(ctx: ToolContext): AgentTool {
  return {
    name: "view_image",
    label: "View Image",
    description: "Return an image (current-question attachment or attempt-generated) as a native image with its real dimensions. Images over the pixel limit are refused; downscale with process_image.",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, args) => {
      const { path } = args as { path: string };
      try {
        const abs = resolveToolRef(ctx, path);
        const buf = readFileSync(abs);
        const meta = await sharp(buf).metadata();
        if (!meta.width || !meta.height) throw new Error("undecodable image");
        const format = meta.format ?? "png";
        const pixels = meta.width * meta.height;
        if (pixels > ctx.limits.maxImagePixels) {
          return {
            content: [{ type: "text", text: `view_image: ${meta.width}x${meta.height} (${pixels} px) exceeds pixel limit ${ctx.limits.maxImagePixels}; use process_image to crop/downscale first.` }],
            details: { path: abs, width: meta.width, height: meta.height, pixels, maxImagePixels: ctx.limits.maxImagePixels },
            isError: true,
          };
        }
        return {
          content: [
            { type: "text", text: `image ${path}: ${meta.width}x${meta.height} ${format}` },
            { type: "image", data: buf.toString("base64"), mimeType: `image/${format}` },
          ],
          details: { path: abs, width: meta.width, height: meta.height, format },
        };
      } catch (e) {
        return { content: [{ type: "text", text: `view_image error: ${(e as Error).message}` }], details: {}, isError: true };
      }
    },
  };
}

export function processImageTool(ctx: ToolContext): AgentTool {
  return {
    name: "process_image",
    label: "Process Image",
    description: "Crop and/or scale an image; returns the processed image as a native image. Crop is clamped to bounds; scale applies to the cropped size. The original is preserved.",
    parameters: Type.Object({
      path: Type.String(),
      crop: Type.Optional(Type.Object({ left: Type.Number(), top: Type.Number(), width: Type.Number(), height: Type.Number() })),
      scale: Type.Optional(Type.Number()),
    }),
    execute: async (_id, args) => {
      const { path, crop, scale } = args as {
        path: string;
        crop?: { left: number; top: number; width: number; height: number };
        scale?: number;
      };
      try {
        const abs = resolveToolRef(ctx, path);
        let pipeline = sharp(readFileSync(abs));
        const before = await pipeline.metadata();
        const bw = before.width ?? 0;
        const bh = before.height ?? 0;
        if (!bw || !bh) throw new Error("undecodable image");

        // Crop first, clamped to the image bounds (never let sharp throw on an
        // out-of-range extract). Track the cropped width for the scale step.
        let cropW = bw;
        let cropH = bh;
        if (crop) {
          const left = Math.min(Math.max(0, Math.floor(crop.left)), Math.max(0, bw - 1));
          const top = Math.min(Math.max(0, Math.floor(crop.top)), Math.max(0, bh - 1));
          const width = Math.min(Math.max(1, Math.floor(crop.width)), bw - left);
          const height = Math.min(Math.max(1, Math.floor(crop.height)), bh - top);
          pipeline = pipeline.extract({ left, top, width, height });
          cropW = width;
          cropH = height;
        }
        // Scale applies to the CROPPED size.
        let outW = cropW;
        let outH = cropH;
        if (scale && scale > 0) {
          outW = Math.max(1, Math.round(cropW * scale));
          outH = Math.max(1, Math.round(cropH * scale));
          pipeline = pipeline.resize(outW);
        }
        // P2-7: reject on the ESTIMATED output size BEFORE allocating a big buffer.
        if (outW * outH > ctx.limits.maxImagePixels) {
          throw new Error(`estimated output ${outW}x${outH} (${outW * outH} px) exceeds pixel limit ${ctx.limits.maxImagePixels}`);
        }
        const out = await pipeline.png().toBuffer();
        const meta = await sharp(out).metadata();
        const pixels = (meta.width ?? 0) * (meta.height ?? 0);
        if (pixels > ctx.limits.maxImagePixels) {
          throw new Error(`processed image ${meta.width}x${meta.height} (${pixels} px) exceeds pixel limit ${ctx.limits.maxImagePixels}`);
        }
        const outPath = join(ctx.workDir, `processed_${Date.now()}.png`);
        writeFileSync(outPath, out);
        return {
          content: [
            { type: "text", text: `processed ${path}: ${meta.width}x${meta.height} png` },
            { type: "image", data: out.toString("base64"), mimeType: "image/png" },
          ],
          details: { source: abs, output: outPath, width: meta.width, height: meta.height, crop, scale },
        };
      } catch (e) {
        return { content: [{ type: "text", text: `process_image error: ${(e as Error).message}` }], details: {}, isError: true };
      }
    },
  };
}
