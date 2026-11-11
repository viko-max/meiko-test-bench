export const PROJECT_NAME = "Meiko Test-Bench";

const FONT = {
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  N: ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  "-": ["000", "000", "000", "111", "000", "000", "000"],
  " ": ["000", "000", "000", "000", "000", "000", "000"],
} as const;
const SMALL_FONT = {
  M: ["101", "111", "111", "101", "101"], E: ["111", "100", "110", "100", "111"],
  I: ["111", "010", "010", "010", "111"], K: ["101", "110", "100", "110", "101"],
  O: ["111", "101", "101", "101", "111"], T: ["111", "010", "010", "010", "010"],
  S: ["111", "100", "111", "001", "111"], B: ["110", "101", "110", "101", "110"],
  N: ["101", "111", "111", "111", "101"], C: ["111", "100", "100", "100", "111"],
  H: ["101", "101", "111", "101", "101"],
  "-": ["0", "0", "1", "0", "0"],
} as const;

export interface Wordmark {
  text: typeof PROJECT_NAME;
  width: number;
  lines: string[];
  pixels: string[];
}

/** 字标采用明确的像素字形，宽窗口一行、侧栏两行、窄窗口使用普通文字。 */
export function renderWordmark(maxWidth: number, reveal = 1, emphasized = false): Wordmark {
  if (maxWidth < 37) {
    const text = PROJECT_NAME.slice(0, Math.max(1, maxWidth));
    const shown = text.slice(0, Math.floor(text.length * Math.max(0, Math.min(1, reveal)))).padEnd(text.length);
    return { text: PROJECT_NAME, width: text.length, lines: [`\x1b[1m\x1b[38;2;111;211;204m${shown}\x1b[0m`], pixels: [] };
  }
  const prominent = emphasized && maxWidth >= 58;
  const font = maxWidth >= 57 ? FONT : SMALL_FONT;
  const words = !prominent && maxWidth >= 91 ? ["MEIKO TEST-BENCH"] : ["MEIKO", "TEST-BENCH"];
  const wordScale = (index: number) => prominent && index === 0 ? 2 : 1;
  const wordPixels = (word: string, row: number) =>
    Array.from(word, (char) => font[char as keyof typeof font][row]).join("0");
  const width = Math.max(...words.map((word, index) => wordPixels(word, 0).length * wordScale(index)));
  const pixels: string[] = [];
  for (const [index, word] of words.entries()) {
    if (pixels.length) pixels.push("0".repeat(width), "0".repeat(width));
    const scale = wordScale(index);
    for (let row = 0; row < font.M.length; row++) {
      // 横纵同时整数放大，避免只拉高字形造成细长失衡。
      const line = Array.from(wordPixels(word, row), (pixel) => pixel.repeat(scale)).join("").padEnd(width, "0");
      for (let repeat = 0; repeat < scale; repeat++) pixels.push(line);
    }
  }
  if (pixels.length % 2) pixels.push("0".repeat(width));
  const shownColumns = Math.floor(width * Math.max(0, Math.min(1, reveal)));
  for (let row = 0; row < pixels.length; row++) pixels[row] = pixels[row]!.slice(0, shownColumns).padEnd(width, "0");
  const lines: string[] = [];
  for (let row = 0; row < pixels.length; row += 2) {
    let line = "";
    for (let col = 0; col < width; col++) {
      const top = col < shownColumns && pixels[row]![col] === "1";
      const bottom = col < shownColumns && pixels[row + 1]![col] === "1";
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    lines.push(`\x1b[0m\x1b[38;2;111;211;204m${line}\x1b[0m`);
  }
  return { text: PROJECT_NAME, width, lines, pixels };
}
