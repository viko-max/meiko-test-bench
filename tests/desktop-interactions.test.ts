import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { TuiAltScreen, stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";
import { ExamTui } from "../src/tui/controller.js";
import { ExamApp } from "../src/tui/app.js";
import { prepareMascotImage } from "../src/tui/mascot.js";
import { loadQuestionImage } from "../src/service/question-image.js";

beforeAll(prepareMascotImage);
afterEach(() => vi.restoreAllMocks());

// 只替代物理终端；鼠标字节解析、手势合成和组件分派使用真实 Pi 实现。
class TestTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  input?: (data: string) => void;
  resize?: () => void;
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() { this.input = undefined; this.resize = undefined; }
  async drainInput() {}
  write(_data: string) {}
  moveBy(_lines: number) {}
  hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
  setTitle(_title: string) {} setProgress(_active: boolean) {}
  setProgramStatus(_status: Parameters<Terminal["setProgramStatus"]>[0]) {}
  mouse(x: number, y: number, release = false, button = 0) { this.input?.(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`); }
}

function fixture() {
  mkdirSync(resolve(".work"), { recursive: true });
  const root = mkdtempSync(resolve(".work", "desktop-interactions-"));
  const publicDir = join(root, "datasets", "demo", "public");
  mkdirSync(publicDir, { recursive: true }); mkdirSync(join(root, "datasets", "demo", "scoring"));
  writeFileSync(join(publicDir, "q1.md"), '---\nid: q1\nversion: "1"\nsubject: math\nanswer_kind: open\n---\n说明条件。\n');
  const tui = new ExamTui({ datasetsRoot: join(root, "datasets"), importRoot: join(root, "drafts"), modelsConfigPath: "unused", runsRoot: join(root, "runs"), workRoot: join(root, "work"), toolsVersion: "v1", pythonInterpreter: "python", animation: false });
  tui.loadDatasets();
  const app = new ExamApp(tui);
  const terminal = new TestTerminal();
  vi.spyOn(app as any, "termRows").mockImplementation(() => terminal.rows);
  const alt = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false });
  app.rerender = () => alt.requestRender();
  alt.setLayoutRoot(app); alt.setFocus(app); alt.start(); alt.renderNow();
  const row = (text: string) => {
    alt.renderNow();
    const y = alt.getScreenLines().findIndex((line) => stripTerminalSequences(line).includes(text));
    if (y < 0) throw new Error(`没有找到可见操作：${text}`);
    return y;
  };
  const dispose = () => { app.dispose(); alt.stop({ preserveScreen: true }); };
  return { root, tui, app, terminal, alt, row, dispose };
}
async function flush() { await new Promise<void>((done) => setImmediate(done)); }

describe("真实 Pi 鼠标分派与图片显示", () => {
  it("列表按下不执行，松开后仅进入一次；跨事件循环也不重复", async () => {
    const s = fixture();
    const check = vi.spyOn(s.tui, "checkDataset");
    try {
      const y = s.row("demo");
      s.terminal.mouse(5, y); await flush();
      expect(check).not.toHaveBeenCalled();
      expect(s.tui.getState().screen.kind).toBe("datasets");
      s.terminal.mouse(5, y, true);
      await vi.waitFor(() => expect(s.tui.getState().screen.kind).toBe("check"));
      expect(check).toHaveBeenCalledTimes(1);
    } finally { s.dispose(); }
  });

  it("命令候选按下不导航，松开只执行一次，右键不会执行", async () => {
    const s = fixture();
    const tasks = vi.spyOn(s.tui, "openTasks");
    try {
      s.app.handleInput("/"); const y = s.row("/tasks");
      s.terminal.mouse(4, y, false, 2); s.terminal.mouse(4, y, true, 2); await flush();
      expect(tasks).not.toHaveBeenCalled();
      s.terminal.mouse(4, y); await flush(); expect(tasks).not.toHaveBeenCalled();
      s.terminal.mouse(4, y, true);
      await vi.waitFor(() => expect(tasks).toHaveBeenCalledTimes(1));
      expect(s.tui.getState().screen.kind).toBe("tasks");
    } finally { s.dispose(); }
  });

  it("按下后拖出列表行取消操作，随后正常点击仍可执行", async () => {
    const s = fixture();
    const check = vi.spyOn(s.tui, "checkDataset");
    try {
      const y = s.row("demo");
      s.terminal.mouse(5, y); s.terminal.mouse(5, y + 1, false, 32); s.terminal.mouse(5, y + 1, true); await flush();
      expect(check).not.toHaveBeenCalled();
      s.terminal.mouse(5, y); s.terminal.mouse(5, y, true);
      await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    } finally { s.dispose(); }
  });

  it("原图按钮经缩放后仍可命中，按下和拖出不打开查看器", async () => {
    const s = fixture();
    const open = vi.spyOn(s.tui, "openOriginalImage").mockResolvedValue();
    try {
      await sharp({ create: { width: 40, height: 20, channels: 3, background: "#236bad" } }).png().toFile(join(s.root, "figure.png"));
      const source = join(s.root, "source.json");
      writeFileSync(source, JSON.stringify([{ id: "q1", question: "核对图片。", assets: [{ ref: "figure.png" }] }]));
      const draft = s.tui.getImporter().importSource(source, { datasetId: "image-demo" });
      await s.tui.openDraftImage(draft.draftId, 0);
      for (const [width, height] of [[140, 40], [80, 24]]) {
        s.terminal.columns = width; s.terminal.rows = height; s.terminal.resize?.();
        const y = s.row("打开系统原图查看器");
        const before = open.mock.calls.length;
        s.terminal.mouse(5, y); await flush(); expect(open).toHaveBeenCalledTimes(before);
        s.terminal.mouse(5, y, true); await flush(); expect(open).toHaveBeenCalledTimes(before + 1);
      }
    } finally { s.dispose(); }
  });

  it("EXIF 旋转照片的显示尺寸、PNG 和缩略图朝向一致", async () => {
    const s = fixture();
    try {
      const path = join(s.root, "rotated.jpg");
      await sharp({ create: { width: 80, height: 40, channels: 3, background: "#d45a21" } }).jpeg().withMetadata({ orientation: 6 }).toFile(path);
      const image = await loadQuestionImage(path, "rotated.jpg");
      const decoded = await sharp(Buffer.from(image.png, "base64")).metadata();
      expect([image.width, image.height]).toEqual([40, 80]);
      expect([decoded.width, decoded.height]).toEqual([40, 80]);
      expect(image.thumbnail.width).toBeLessThan(image.thumbnail.height);
    } finally { s.dispose(); }
  });
});
