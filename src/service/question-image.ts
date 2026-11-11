import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { mediaTypeForRef } from "../dataset/parse.js";
import { sha256OfBytes } from "../shared/hashing.js";

export interface QuestionImage {
  path: string; ref: string; digest: string; width: number; height: number;
  png: string; thumbnail: { pixels: Buffer; width: number; height: number };
}

export async function loadQuestionImage(path: string, ref: string): Promise<QuestionImage> {
  if (!mediaTypeForRef(ref)) throw new Error("仅能核对 PNG、JPEG、GIF、WebP 原图，不能打开其他类型附件。");
  const source = readFileSync(path);
  const image = sharp(source, { limitInputPixels: 40_000_000 });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || !["png", "jpeg", "webp", "gif"].includes(metadata.format ?? "")) throw new Error("原图无法解码或格式不受支持。");
  const png = await image.clone().rotate().png().toBuffer({ resolveWithObject: true });
  const thumb = await image.clone().rotate().resize({ width: 96, height: 48, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  return { path, ref, digest: sha256OfBytes(source), width: png.info.width, height: png.info.height, png: png.data.toString("base64"),
    thumbnail: { pixels: thumb.data, width: thumb.info.width, height: thumb.info.height } };
}

export async function openQuestionImage(image: QuestionImage): Promise<void> {
  if (sha256OfBytes(readFileSync(image.path)) !== image.digest) throw new Error("原图已变化，请重新打开图片核对页面。");
  const program = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, [image.path], { windowsHide: true, stdio: "ignore", shell: false });
    child.once("error", (error) => reject(new Error(`无法打开原图：${error.message}`)));
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
