import { readFileSync } from "node:fs";
import sharp from "sharp";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { PublicQuestion } from "../shared/contracts.js";
import { resolvePublicAttachment } from "../tools/paths.js";

// 作答与独立裁判共用原图读取路径；不重采样，也不读取私有评分附件。
export async function loadQuestionImages(q: PublicQuestion, publicDir: string): Promise<ImageContent[]> {
  const out: ImageContent[] = [];
  for (const asset of q.assets) {
    if (!asset.mediaType.startsWith("image/")) continue;
    try {
      const bytes = readFileSync(resolvePublicAttachment(publicDir, asset.ref));
      const metadata = await sharp(bytes).metadata();
      if (!metadata.width || !metadata.height) throw new Error("undecodable image");
      out.push({ type: "image", data: bytes.toString("base64"), mimeType: asset.mediaType });
    } catch (error) {
      throw new Error(`required image ${asset.ref} could not be loaded: ${(error as Error).message}`);
    }
  }
  return out;
}
