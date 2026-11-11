import type { MascotColorway } from "./mascot.js";

type Rgb = readonly [number, number, number];
const COLORS: Record<Exclude<MascotColorway, "orange">, readonly Rgb[]> = {
  pink: [[235, 136, 172], [193, 75, 120], [126, 36, 82], [214, 101, 146], [81, 36, 62]],
  black: [[46, 53, 72], [27, 32, 49], [15, 20, 37], [76, 91, 121], [12, 17, 29]],
};
const HAIR_COLORS = new Map<string, number>([
  ["252,106,17", 0], ["207,48,1", 1], ["171,21,1", 2],
  ["251,106,17", 0], ["208,48,1", 1], ["171,22,2", 2], ["223,84,30", 3], ["106,42,27", 4],
]);

function faceFeature(x: number, y: number): boolean {
  // 眼睛和嘴与头发共享橙色色阶；按母稿坐标保护，不能全图替换同色像素。
  return y >= 38 && y < 45 && (x >= 22 && x < 30 || x >= 37 && x < 45) ||
    y >= 45 && y < 49 && x >= 31 && x < 35;
}

/** 终端色板只改变发色与花瓣；原稿、像素位置和 Alpha 全部保留。 */
export function nativePalette(data: Buffer, width: number, height: number, colorway: MascotColorway): Buffer {
  if (![48, 64].includes(width) || height !== width || data.length !== width * height * 4) {
    throw new Error("原生色板需要 48/64 正方形 RGBA 定稿。");
  }
  const output = Buffer.from(data);
  if (colorway === "orange") return output;
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (!data[offset + 3] || faceFeature((x + 0.5) * 64 / width, (y + 0.5) * 64 / height)) continue;
      const index = HAIR_COLORS.get(`${data[offset]},${data[offset + 1]},${data[offset + 2]}`);
      if (index === undefined) continue;
      output.set(COLORS[colorway][index]!, offset);
      changed++;
    }
  }
  if (!changed) throw new Error("角色母稿色板已变化，需要先核对发色色阶。");
  return output;
}
