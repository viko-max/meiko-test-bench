import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { Image, allocateImageId, getCapabilities } from "@earendil-works/pi-tui";
import { nativePalette } from "./native-palette.js";

/** 两种显示尺寸都取自同一张像素吉祥物原稿。 */
export const MASCOT_W = 48;
export const MASCOT_H = 48;
export const COMPACT_MASCOT_W = 32;
export const COMPACT_MASCOT_H = 32;

type Color = [number, number, number];

const PALETTE: Record<string, Color | undefined> = {
  o: [242, 104, 37], // 橙发
  O: [185, 58, 21], // 发丝阴影
  Y: [255, 178, 42], // 花饰与金色细节
  n: [22, 32, 67], // 深蓝描边
  b: [44, 70, 136], // 深蓝衣裙
  B: [106, 143, 198], // 鲸鱼尾巴高光
  w: [248, 246, 250], // 白色头饰与围裙
  s: [255, 221, 198], // 肤色
  S: [220, 171, 151], // 肤色阴影
  e: [62, 44, 55], // 眼睛与深色细节
  r: [225, 83, 103], // 嘴部
  g: [255, 202, 83], // 亮色点缀
};

const LARGE_RAW = [
  "...........nnn..................................",
  "..........noooe.................................",
  ".........noonooo................................",
  "........nn.....onnwwwwnwn.......................",
  "........nn.....newwwwwwww.......................",
  ".............nwwwwnSwnwwSww.....................",
  "............wnwwnwwwwwnSSwwn....................",
  "...........nwwnwnnoooonwwwsnon..................",
  "..........wnwnwoooOOoooonwwwono.................",
  "..........wwnnooOoOooOooonwnoOon................",
  "..........nSwooOoOoOoooooownoOOo................",
  ".........nwnoooooooooooYYoooOwOn................",
  ".........nwnYoOYOoooOoYooooOOYOob...............",
  "..........noYOoYOYYYoooOoonoOoonnn..............",
  ".........OsOoOooOoYoosooOoonoonnbn..............",
  "........ssSooooOoooosOoooooonbnnn...............",
  "........nssOoooOOooooesooOoonYbYnbn.............",
  ".......nsseoooosseOoOSnnenoooObYYnbbn...........",
  "......nnnSbooOonnnesoeeeeeoOeOYnn.BBn...........",
  ".....nbnbbYooOOweewssswYwoooesnOYnnn............",
  ".....bbbYYneOoOwOYwssssSOoOowssOOe..............",
  ".....nBBnnbnoooswOsssrsSOOoeeOwseOn.............",
  "........nbbbooOeSsssrssseoeOOOwnweo.............",
  ".........bbbnnooessssseOOeooOOonOSoo.............",
  "........oobbbnnOowwnSOwOonoooOooOe.no............",
  "......nooeonnnnoownbbnbnwwoooeoooO..no...........",
  ".....non.noOOnooenwnsnnswnnooooOoon..n............",
  "....no..nooOeooonwwwwnwSwbbnOoeoooon.nn...........",
  "....on..ooOoeOoenswwwwwwnbbnOooooooooo............",
  "....onnooOooOeoeOnnnnnnonbnOeoeOooOooo............",
  ".....nooOooOOOOenbbbbbbnsbbeeeOOooooooon..........",
  ".....ooOoOooOOnwswwwwwSbnbbeeYnOoOoOonoo..nb......",
  "....nonnoooOOnnwwwSwwswSnneYYegOOoooonoo.bbb......",
  "....no.noOoOnbwSwwwwwwwSsbnYYenOOoooono.bbbb.......",
  ".....o..oOOnbbnSwwwwwwBwwnbneYOOoooOoo.nbbbb......",
  "......oeoonbYnwSwwwbbbwsnbbbnnOOoooon.nBbbbn.....",
  "........obBnYYnwwwwbwbwwwbOnYnOoOoOOo.nbbbb......",
  ".....noonwnYbBSsSwwwwswnnYYbwnOOonnonbbbb......",
  "......nn.wsnbbnwwwwwwwnbnnnwwOOOon...nbn........",
  "..........nwwnnYnssnwBnbYnnwwwOOOeon..bb..........",
  "...........nwwsnnYYYYYbnnwwwnnnnOe...bbb..........",
  "............nnwwwwwwnwsswwnnnnbbbnnbbbBn........",
  "...............nOwSwwwOSnnbnnbbbbbbbbb...........",
  "................sssn..sswnbBbbbbbbbbbB............",
  "...............nwswn.nsBn.nnBBbbbbbBBn............",
  "................nww...wnY....nnnnnnn..............",
  ".................Obnn..bbn.........................",
  ".................nbbn..bn..........................",
];

const COMPACT_RAW = [
  ".......nnn......................",
  "......nooo......................",
  ".....n....onwwww................",
  ".........wnwnwnwnw..............",
  ".......nwSnwnnnnwwo.............",
  ".......nwnnoooonwSno............",
  "......nwnoOoOoOoowoOn...........",
  "......wboooOoooYYoowo...........",
  "......BeYOoogOooYOoYon..........",
  "......nSooooYoeOoonoobn.........",
  ".....nsOooOooosoOoOonYn..........",
  ".....ssooosOoOsnnoonnnbn.........",
  "....nsOooowooonewooObnnbn........",
  "...bbbbnoewesssYeoosnY.n..........",
  "...nBnbboosesssSoowOwnn...........",
  "......bbnossssseooOOosnn..........",
  ".....oenbnoOnnnnwooOOO..o.........",
  "...oo.ooOoowbwnsnnooooo..n........",
  "..n..OooeOewwwwwbbeoeooono.........",
  "..o.ooooOoOnnnnobnOoOoooon.........",
  "...oooooOOnwYbbwnbYnOooOooo........",
  "..no.ooOOnwwwwwwnnYenoOoono.b......",
  "..nn.oOOnwwwwwwSnneeOOoooo.Bb.......",
  "...onnOnbwwwwbwwnbnnOoOon.bbb.......",
  "....nowbnnSwwwbwnObnOOoOn.bbb.......",
  "....nonsnbwSsSwwnnbwOOo.nnbn.........",
  ".......wwnOnnwBbbnswOOon.bb........",
  "........nSwnnbnSwnnnbnOnbbn........",
  "..........nOSnwSnbnbbbbbbn..........",
  "..........bss.BsnnBbbbbbB............",
  "..........nww.nnn...nnn.............",
  "...........bb.nn....................",
];

export const TERMINAL_BACKGROUND: Color = [0, 42, 50];

export const ACTION_FRAMES = ["idle", "stepLeft", "stepRight", "waveIn", "waveOut", "blink"] as const;
export type ActionFrame = typeof ACTION_FRAMES[number];
export const MASCOT_COLORWAYS = ["orange", "pink", "black"] as const;
export type MascotColorway = typeof MASCOT_COLORWAYS[number];
const ENTRANCE_POSES = {
  orange: ["idle", "tailMid", "tailUp", "halfBlink", "blink"],
  pink: ["idle", "waveIn", "waveOut"],
  black: ["idle", "lookRight", "nod"],
} as const;
export type EntrancePose = (typeof ENTRANCE_POSES)[MascotColorway][number];
export type MascotArtwork = "full" | "portrait" | "home" | "native" | "entrance";
type RenderPose = ActionFrame | EntrancePose;
type FrameImage = { data: Buffer; width: number; height: number; png: string };
const sourceImages = new Map<string, Map<RenderPose, FrameImage>>();
const portraitImages = new Map<MascotColorway, FrameImage>();
const homeImages = new Map<number, FrameImage>();
const nativeColorImages = new Map<string, FrameImage>();
const entranceImages = new Map<string, FrameImage>();
const renderedImages = new Map<string, string[]>();
const nativeImages = new Map<string, Image>();

async function loadEntranceFrames(colorway: MascotColorway): Promise<Array<[string, FrameImage]>> {
  const poses = ENTRANCE_POSES[colorway];
  const size = 640;
  const file = fileURLToPath(new URL(`../../src/tui/meiko-entrance-${colorway}.png`, import.meta.url));
  const sheet = sharp(file);
  const metadata = await sheet.metadata();
  if (!metadata.hasAlpha || metadata.height !== size || metadata.width !== size * poses.length) {
    throw new Error(`吉祥物 ${colorway} 的入场素材必须包含 ${poses.length} 张 640×640 透明帧。`);
  }
  const pixels = await sheet.ensureAlpha().raw().toBuffer();
  const raw = { width: metadata.width, height: size, channels: 4 as const };
  return Promise.all(poses.map(async (pose, i) => {
    const png = await sharp(pixels, { raw }).extract({ left: i * size, top: 0, width: size, height: size }).png().toBuffer();
    const data = await sharp(png).raw().toBuffer();
    return [`${colorway}:${pose}`, { data, width: size, height: size, png: png.toString("base64") }];
  }));
}

export async function prepareMascotImage(): Promise<void> {
  const loaded = new Map<string, Map<RenderPose, FrameImage>>();
  const portraits = new Map<MascotColorway, FrameImage>();
  const native = new Map<string, FrameImage>();
  const homePath = fileURLToPath(new URL("../../src/tui/meiko-home-64-v3.png", import.meta.url));
  const homeMetadata = await sharp(homePath).metadata();
  if (homeMetadata.width !== 64 || homeMetadata.height !== 64 || !homeMetadata.hasAlpha) {
    throw new Error("首页角色必须使用含透明通道的 64×64 定稿。");
  }
  const home = new Map<number, FrameImage>();
  const homePng = await sharp(homePath).png().toBuffer();
  const full = await sharp(homePng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  home.set(64, { data: full.data, width: full.info.width, height: full.info.height, png: homePng.toString("base64") });
  const compactPath = fileURLToPath(new URL("../../src/tui/meiko-home-48-v3.png", import.meta.url));
  const compactMetadata = await sharp(compactPath).metadata();
  if (compactMetadata.width !== 48 || compactMetadata.height !== 48 || !compactMetadata.hasAlpha) {
    throw new Error("首页紧凑角色必须使用含透明通道的 48×48 定稿。");
  }
  const compactPng = await sharp(compactPath).png().toBuffer();
  const compact = await sharp(compactPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  home.set(48, { data: compact.data, width: compact.info.width, height: compact.info.height, png: compactPng.toString("base64") });
  let portraitSize: number | undefined;
  for (const colorway of MASCOT_COLORWAYS) {
    for (const size of [64, 48]) {
      const base = home.get(size)!;
      const data = nativePalette(base.data, size, size, colorway);
      const png = await sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
      native.set(`${colorway}:${size}`, { data, width: size, height: size, png: png.toString("base64") });
    }
    const filename = `meiko-portrait-${colorway}-v2.png`;
    const portraitSource = sharp(fileURLToPath(new URL(`../../src/tui/${filename}`, import.meta.url)));
    if (!(await portraitSource.metadata()).hasAlpha) throw new Error(`角色胸像 ${filename} 缺少透明通道。`);
    const portrait = await portraitSource.png().toBuffer();
    const { data, info } = await sharp(portrait).raw().toBuffer({ resolveWithObject: true });
    if (info.width !== info.height || info.channels !== 4 || (portraitSize !== undefined && info.width !== portraitSize)) {
      throw new Error(`角色胸像 ${filename} 必须使用相同尺寸的正方形 RGBA 画布。`);
    }
    portraitSize = info.width;
    portraits.set(colorway, { data, width: info.width, height: info.height, png: portrait.toString("base64") });
    for (const size of [48, 32]) {
      const filename = colorway === "orange" ? `meiko-actions-v3-${size === 48 ? "large" : "compact"}.png` : `meiko-actions-${colorway}.png`;
      const path = fileURLToPath(new URL(`../../src/tui/${filename}`, import.meta.url));
      const metadata = await sharp(path).metadata();
      if (!metadata.width || !metadata.height || metadata.width % 3 || metadata.height % 2 || metadata.width / 3 !== metadata.height / 2 || !metadata.hasAlpha) {
        throw new Error(`角色动作图 ${filename} 必须是含 Alpha 的三列两行正方形帧图。`);
      }
      const cell = metadata.width / 3;
      const frames = new Map<RenderPose, FrameImage>();
      for (const [index, name] of ACTION_FRAMES.entries()) {
        // 不逐帧裁剪透明边缘，避免各帧头部和脚下基线随动作跳动。
        const png = await sharp(path).extract({ left: index % 3 * cell, top: Math.floor(index / 3) * cell, width: cell, height: cell }).png().toBuffer();
        // 保留原稿像素；实际终端尺寸只采样一次，不能先缩成 48 再放大。
        const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        frames.set(name, { data, width: info.width, height: info.height, png: png.toString("base64") });
      }
      loaded.set(`${colorway}:${size}`, frames);
    }
  }
  const entrances = (await Promise.all(MASCOT_COLORWAYS.map(loadEntranceFrames))).flat();
  sourceImages.clear();
  for (const [size, frames] of loaded) sourceImages.set(size, frames);
  portraitImages.clear();
  for (const [colorway, portrait] of portraits) portraitImages.set(colorway, portrait);
  homeImages.clear();
  for (const [size, image] of home) homeImages.set(size, image);
  nativeColorImages.clear();
  for (const [key, image] of native) nativeColorImages.set(key, image);
  entranceImages.clear();
  for (const [key, image] of entrances) entranceImages.set(key, image);
  renderedImages.clear();
  nativeImages.clear();
}

function sourceFor(width: number, rows: number, frame: RenderPose, colorway: MascotColorway, artwork: MascotArtwork): FrameImage {
  if (artwork === "entrance") {
    if (![48, 64].includes(width) || rows * 2 !== width) throw new Error("入场角色需要完整的 48/64 显示网格。");
    const source = entranceImages.get(`${colorway}:${frame}`);
    if (!source) throw new Error(`吉祥物动作帧未加载：${colorway}/${frame}。`);
    return source;
  }
  if (artwork === "native") {
    if (frame !== "idle") throw new Error("原生定稿仅支持 idle 底图。");
    if (![48, 64].includes(width) || rows * 2 !== width) throw new Error("原生角色只能按完整的 48/64 网格显示。");
    const source = nativeColorImages.get(`${colorway}:${width}`);
    if (!source) throw new Error("原生吉祥物配色尚未加载。");
    return source;
  }
  if (artwork === "home") {
    if (frame !== "idle" || colorway !== "orange") throw new Error("首页定稿仅支持橙色 idle 底图。");
    if (![48, 64].includes(width) || rows * 2 !== width) throw new Error("首页定稿只能按完整的 48/64 原生网格显示。");
    const source = homeImages.get(width);
    if (!source) throw new Error("首页吉祥物尚未加载。");
    return source;
  }
  if (artwork === "portrait") {
    // 胸像只有一张已检查的底图，不能套用旧动作帧导致人物或肢体变化。
    if (frame !== "idle") throw new Error("胸像仅支持 idle 底图。");
    const source = portraitImages.get(colorway);
    if (!source) throw new Error("吉祥物胸像尚未加载。");
    return source;
  }
  const size = Math.min(width, rows * 2) >= 48 ? 48 : 32;
  const source = sourceImages.get(`${colorway}:${size}`)?.get(frame);
  if (!source) throw new Error("像素吉祥物动作图片尚未加载或帧名无效。");
  return source;
}

/** 替代屏仅在 Kitty 协议下使用原生图片，普通终端使用专用色块稿。 */
export function renderMascotDisplay(width: number, rows: number, frame: RenderPose = "idle", colorway: MascotColorway = "orange", artwork: MascotArtwork = "full"): string[] {
  if (getCapabilities().images !== "kitty") return renderMascotImage(width, rows, TERMINAL_BACKGROUND, frame, colorway, artwork);
  const source = sourceFor(width, rows, frame, colorway, artwork);
  const sizeKey = `${width}x${rows}`;
  const key = `${sizeKey}:${colorway}:${frame}:${artwork}`;
  let component = nativeImages.get(key);
  if (!component) {
    // 每个姿势使用独立 Kitty ID，回到待机时终端缓存能找回正确的原帧。
    component = new Image(source.png, "image/png", { fallbackColor: (value) => value }, {
      maxWidthCells: width, maxHeightCells: rows, imageId: allocateImageId(),
    });
    nativeImages.set(key, component);
  }
  const imageLines = component.render(width + 2);
  return Array.from({ length: rows }, (_, row) => (imageLines[row] ?? "") + " ".repeat(width));
}

/** 色块绘制和视觉预览共用同一份 RGB 像素，避免预览与实际采样不同。 */
export function rasterizeMascot(width: number, rows: number, bg: Color = TERMINAL_BACKGROUND, frame: RenderPose = "idle", colorway: MascotColorway = "orange", artwork: MascotArtwork = "full"): { data: Buffer; alpha: Buffer; width: number; height: number } {
  if (!Number.isInteger(width) || !Number.isInteger(rows) || width < 1 || rows < 1) {
    throw new Error("像素吉祥物渲染宽度和行数必须为正整数。");
  }
  const sourceImage = sourceFor(width, rows, frame, colorway, artwork);
  const pixelHeight = rows * 2;
  const scale = Math.min(width / sourceImage.width, pixelHeight / sourceImage.height);
  const imageWidth = Math.max(1, Math.round(sourceImage.width * scale));
  const imageHeight = Math.max(1, Math.round(sourceImage.height * scale));
  const left = Math.floor((width - imageWidth) / 2);
  const top = Math.floor((pixelHeight - imageHeight) / 2);
  const data = Buffer.alloc(width * pixelHeight * 3);
  const alpha = Buffer.alloc(width * pixelHeight);
  for (let y = 0; y < pixelHeight; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      const px = x - left;
      const py = y - top;
      if (px < 0 || py < 0 || px >= imageWidth || py >= imageHeight) {
        data.set(bg, pixel * 3);
        continue;
      }
      const sx = Math.floor((px + 0.5) * sourceImage.width / imageWidth);
      const sy = Math.floor((py + 0.5) * sourceImage.height / imageHeight);
      const source = (sy * sourceImage.width + sx) * 4;
      alpha[pixel] = sourceImage.data[source + 3]!;
      const opacity = alpha[pixel]! / 255;
      for (let channel = 0; channel < 3; channel++) {
        data[pixel * 3 + channel] = Math.round(sourceImage.data[source + channel]! * opacity + bg[channel]! * (1 - opacity));
      }
    }
  }
  return { data, alpha, width, height: pixelHeight };
}

export function renderMascotImage(width: number, rows: number, bg: Color = TERMINAL_BACKGROUND, frame: RenderPose = "idle", colorway: MascotColorway = "orange", artwork: MascotArtwork = "full"): string[] {
  const key = `${width}x${rows}:${bg.join(",")}:${frame}:${colorway}:${artwork}`;
  const cached = renderedImages.get(key);
  if (cached) return cached;
  const raster = rasterizeMascot(width, rows, bg, frame, colorway, artwork);
  const transparent = artwork === "native" || artwork === "home" || artwork === "entrance";
  const colorCode = (channel: 38 | 48, x: number, y: number): string => {
    const offset = (y * width + x) * 3;
    return `\x1b[${channel};2;${raster.data[offset]};${raster.data[offset + 1]};${raster.data[offset + 2]}m`;
  };
  const lines = Array.from({ length: rows }, (_, row) => {
    let line = "";
    for (let column = 0; column < width; column++) {
      const topVisible = !transparent || raster.alpha[(row * 2) * width + column] !== 0;
      const bottomVisible = !transparent || raster.alpha[(row * 2 + 1) * width + column] !== 0;
      // 原生稿的透明像素使用终端背景，不能把透明画布绘成固定颜色的方框。
      if (!topVisible && !bottomVisible) line += "\x1b[0m ";
      else if (!bottomVisible) line += "\x1b[0m" + colorCode(38, column, row * 2) + HALF;
      else if (!topVisible) line += "\x1b[0m" + colorCode(38, column, row * 2 + 1) + "▄";
      else line += colorCode(38, column, row * 2) + colorCode(48, column, row * 2 + 1) + HALF;
    }
    return line + "\x1b[0m";
  });
  renderedImages.set(key, lines);
  return lines;
}

export function normalize(grid: string[], width = MASCOT_W, height = MASCOT_H): string[] {
  return Array.from({ length: height }, (_, row) => (grid[row] ?? "").padEnd(width, ".").slice(0, width));
}

export function downsample(grid: string[], step = 2): string[] {
  const out: string[] = [];
  for (let r = 0; r < grid.length; r += step) {
    let row = "";
    for (let c = 0; c < grid[r]!.length; c += step) row += grid[r]![c] ?? ".";
    out.push(row);
  }
  return out;
}

export function idleFrame(compact = false): string[] {
  return compact ? normalize(COMPACT_RAW, COMPACT_MASCOT_W, COMPACT_MASCOT_H) : normalize(LARGE_RAW);
}

export function blinkFrame(compact = false): string[] {
  const grid = idleFrame(compact);
  const eyeRows = compact ? [8, 9] : [18, 19, 20];
  return grid.map((row, index) => eyeRows.includes(index) ? row.replaceAll("e", "s") : row);
}

export function waveFrame(compact = false): string[] {
  const grid = idleFrame(compact).map((row) => row.split(""));
  // 抬高手部外侧的一格，配合开场横向步进形成清楚的挥手动作。
  const [row, column] = compact ? [7, 4] : [14, 8];
  if (grid[row]?.[column] === ".") grid[row]![column] = "s";
  return grid.map((line) => line.join(""));
}

export type MascotFrame = "idle" | "blink" | "wave";

export function mascotFrame(name: MascotFrame, compact = false): string[] {
  if (name === "blink") return blinkFrame(compact);
  if (name === "wave") return waveFrame(compact);
  return idleFrame(compact);
}

const HALF = "▀";

export function renderMascot(grid: string[], opts: { bg?: Color } = {}): string[] {
  const bg = opts.bg ?? TERMINAL_BACKGROUND;
  const width = Math.max(1, ...grid.map((row) => row.length));
  const rows = grid.length % 2 === 0 ? grid : [...grid, ".".repeat(width)];
  const out: string[] = [];
  for (let r = 0; r < rows.length; r += 2) {
    let line = "";
    for (let c = 0; c < width; c++) {
      const top = PALETTE[rows[r]?.[c] ?? "."] ?? bg;
      const bottom = PALETTE[rows[r + 1]?.[c] ?? "."] ?? bg;
      line += `\x1b[38;2;${top[0]};${top[1]};${top[2]}m\x1b[48;2;${bottom[0]};${bottom[1]};${bottom[2]}m${HALF}`;
    }
    out.push(line + "\x1b[0m");
  }
  return out;
}
