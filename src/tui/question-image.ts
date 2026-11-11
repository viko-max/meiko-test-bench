import { allocateImageId, getCapabilities, Image } from "@earendil-works/pi-tui";
import type { QuestionImage } from "../service/question-image.js";

const nativeIds = new WeakMap<QuestionImage, number>();
/** 图片协议不可用时提供明确标注的缩略图，精细内容通过原图核对。 */
export function renderQuestionImage(image: QuestionImage, columns: number, rows: number): string[] {
  if (getCapabilities().images === "kitty") {
    let imageId = nativeIds.get(image);
    if (imageId === undefined) { imageId = allocateImageId(); nativeIds.set(image, imageId); }
    // 同一张原图在窗口缩放后需要重新按当前可用空间布局。
    return new Image(image.png, "image/png", { fallbackColor: (s) => s }, { maxWidthCells: columns, maxHeightCells: rows, imageId }).render(columns);
  }
  const thumb = image.thumbnail;
  const ratio = Math.min(columns / thumb.width, rows * 2 / thumb.height, 1);
  const width = Math.max(1, Math.floor(thumb.width * ratio));
  const height = Math.max(1, Math.floor(thumb.height * ratio));
  const color = (x: number, y: number) => {
    const offset = (Math.min(thumb.height - 1, Math.floor(y / ratio)) * thumb.width + Math.min(thumb.width - 1, Math.floor(x / ratio))) * 3;
    return `${thumb.pixels[offset]};${thumb.pixels[offset + 1]};${thumb.pixels[offset + 2]}`;
  };
  const lines: string[] = [];
  for (let y = 0; y < height; y += 2) {
    let line = "";
    for (let x = 0; x < width; x++) line += `\x1b[38;2;${color(x, y)}m\x1b[48;2;${color(x, Math.min(y + 1, height - 1))}m▀`;
    lines.push(line + "\x1b[0m");
  }
  return lines;
}
