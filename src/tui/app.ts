/**
 * pi-tui rendering layer (TUI-2). A thin view over the ExamTui controller: it
 * renders the controller's current screen and forwards keys/clicks — NO business
 * logic (AGENTS.md §3).
 *
 * Input model (idiomatic pi-tui): setFocus(app) routes every key to
 * app.handleInput AND auto-repaints afterwards (tui.js:746-749). A global
 * addInputListener is intentionally NOT used — consuming there skips that
 * auto-repaint, which made state changes invisible. Mouse clicks map to per-row
 * "hot zones" recorded during render.
 *
 * Model selection is two-level: provider (pi built-in catalog + custom) -> model.
 * Long lists use a scrolling window that follows the selection, since pi-tui
 * clips whatever exceeds the terminal height. Next_Plan §1/§2/§3/§4: a skippable
 * mascot intro, a HOME screen + slash commands, and a 题库/导入 flow over the
 * ImportService (draft staging -> preview -> confirm/discard).
 */
import { ProcessTerminal, TuiAltScreen, matchesKey, Key, visibleWidth, truncateToWidth, sliceByColumn, decodeKittyPrintable, isKittyProtocolActive, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { AnswerMode } from "../shared/contracts.js";
import { Input, Editor, stripTerminalSequences, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { ExamTui, type ExamTuiConfig, type Screen, type Setup, type ProviderGroup } from "./controller.js";
import { prepareMascotImage, renderMascotDisplay, type EntrancePose, type MascotColorway } from "./mascot.js";
import { CommandBar, type CommandName } from "./command-bar.js";
import { PROJECT_NAME, renderWordmark, type Wordmark } from "./wordmark.js";
import { openingBeat, OPENING_DURATION_MS, OPENING_TICK_MS, pageEntrancePose, PAGE_ENTRANCE_DURATION_MS } from "./opening.js";
import { seconds, summaryLines, requestLines, coverageLines, STATE_LABELS, TERMINATION_LABELS } from "./metrics-view.js";
import type { DraftEditField } from "../import/import-service.js";
import { renderQuestionImage } from "./question-image.js";
import { mediaTypeForRef } from "../dataset/parse.js";
import { stopExamTerminal } from "./terminal-lifecycle.js";
import { summarizeRequests } from "../shared/metrics.js";
import { CollectionView } from "./collection-view.js";
import { ChatView } from "./chat-view.js";
import { MASCOT_ACCENTS, mascotStatus, runtimeStatusLine } from "./mascot-status.js";
import { OFFLINE_DEMO_LABEL } from "../shared/offline-demo.js";

// ── ANSI styling (terminals render these; visibleWidth keeps padding correct) ──
const S = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  rev: "\x1b[7m",
  red: "\x1b[38;2;236;137;145m",
  green: "\x1b[38;2;139;202;172m",
  yellow: "\x1b[38;2;219;187;119m",
  blue: "\x1b[38;2;128;177;232m",
  magenta: "\x1b[38;2;232;157;181m",
  cyan: "\x1b[38;2;111;211;204m",
  white: "\x1b[38;2;222;234;238m",
  gray: "\x1b[38;2;137;170;174m",
};
function paint(text: string, ...codes: string[]): string {
  return codes.length ? codes.join("") + text + S.reset : text;
}
const KEYDEBUG = Boolean(process.env.PI_TUI_KEYDEBUG);
export const SLOGAN = "Creative Is All You Need";
const HOME_FOOTER = "/ 命令 · Tab 补全 · Ctrl+C 退出";
const COMMAND_FOOTER = "↑↓ 选择 · Tab 补全 · Enter 执行 · Esc 收起 · Ctrl+C 退出";
const terminalText = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\t/g, "    ");
export const PAGE_MASCOTS: Record<Screen["kind"], MascotColorway> = {
  opening: "orange", home: "orange", settings: "orange",
  bank: "pink", datasets: "pink", check: "pink", importPreview: "pink",
  collection: "pink",
  chat: "orange",
  draftQuestion: "pink", draftImage: "pink",
  setup: "black", pickmodel: "black", confirm: "black", run: "black",
  tasks: "black", detail: "black", report: "black", review: "black", reviewImage: "black",
  exceptions: "black", usage: "black",
  judge: "black", judgeConfirm: "black", judgeRun: "black", calibration: "black", calibrationSample: "black",
};
const MASCOT_OVERVIEWS = new Set<Screen["kind"]>(["bank", "datasets", "importPreview", "setup", "pickmodel", "tasks", "settings"]);

interface HotZone {
  y: number;
  x0?: number;
  x1?: number;
  run: () => void;
}

interface BankItem {
  kind: "dataset" | "draft";
  id: string;
  label: string;
  extra: string;
}

interface HomeLayout {
  size: number;
  artX: number;
  artY: number;
  brandX: number;
  brandY: number;
  brandWidth: number;
  emphasizedBrand: boolean;
  brand: Wordmark;
  details: string[];
}

export class ExamApp implements Component {
  private menuIndex = 0;
  private scrollTop = 0;
  private onQuit?: () => void | Promise<void>;
  private keyLog: string[] = [];
  private hot: HotZone[] = [];
  private pending?: Promise<void>;
  private quitting = false;
  private width = 80;
  private reviewTab: "question" | "answer" | "scoring" = "question";
  private fieldInput?: Input;
  private draftEditor?: { field: DraftEditField; component: Editor };
  private bodyRows = 20;
  private readonly commands: CommandBar;
  private commandTop = 0;
  private commandLeft = 0;
  private commandHeight = 0;
  // 同一时间线播放动作帧、标题出现和首页过渡。
  private openingElapsed = 0;
  private openingTimers: ReturnType<typeof setTimeout>[] = [];
  private readonly playedPageColors = new Set<MascotColorway>();
  private pageMotion?: { screen: Screen["kind"]; startedAt: number; timer: ReturnType<typeof setInterval> };
  private runTimer?: ReturnType<typeof setInterval>;
  private runExpanded = false;
  private collectionView?: CollectionView;
  private chatView?: ChatView;
  private chatUnsubscribe?: () => void;
  private collectionUnsubscribe?: () => void;
  private collectionLeft = 0;
  private collectionTop = 0;
  private chatPane(): ChatView {
    if (!this.chatView) {
      const workspace = this.tui.getChatWorkspace(), view = new ChatView(workspace);
      view.onBack = () => this.perform(() => this.tui.gotoHome()); view.onChange = () => this.rerender?.();
      this.chatUnsubscribe = workspace.subscribe(() => this.rerender?.()); this.chatView = view;
    }
    return this.chatView;
  }
  private collectionPane(): CollectionView {
    if (!this.collectionView) {
      const workspace = this.tui.getCollectionWorkspace();
      const view = new CollectionView(workspace);
      view.onBack = () => this.perform(() => this.tui.gotoHome());
      view.onEditDraft = (id) => this.perform(() => this.tui.editCollectionDraft(id));
      view.onRun = (dataset) => this.perform(() => this.tui.checkDataset(dataset));
      view.onChange = () => this.rerender?.();
      this.collectionUnsubscribe = workspace.subscribe(() => this.rerender?.()); this.collectionView = view;
    }
    return this.collectionView;
  }

  // pi-tui 只在按键返回时刷新；异步操作完成后必须再次请求刷新。
  private perform(action: () => void | Promise<unknown>): void {
    if (this.pending || this.quitting) return;
    const before = this.tui.getState().screen.kind;
    this.pending = Promise.resolve().then(action).then(() => {}, (error: unknown) => {
      this.tui.setMessage(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (this.tui.getState().screen.kind !== before) {
        this.menuIndex = 0;
        this.scrollTop = 0;
      }
      this.pending = undefined;
      this.rerender?.();
    });
  }

  constructor(private readonly tui: ExamTui) {
    this.commands = new CommandBar((command) => !this.tui.demoSource || !["chat", "model", "collect", "judge"].includes(command));
    this.commands.onText = (text) => this.perform(async () => { await this.tui.stopChatAndWait(); this.tui.openChat(text); });
    this.commands.onExecute = (command) => {
      if (command === "quit") { void this.quit(); return; }
      this.perform(() => this.executeCommand(command));
    };
  }

  private async executeCommand(command: CommandName): Promise<void> {
    if (!["chat", "model", "help"].includes(command)) await this.tui.stopChatAndWait();
    switch (command) {
      case "chat": this.tui.openChat(); break;
      case "model": this.tui.openChatModels(); break;
      case "home": await this.tui.gotoHome(); break;
      case "bank": this.tui.gotoBank(); break;
      case "run": this.tui.gotoDatasets(); break;
      case "collect": this.tui.openCollection(); break;
      case "import": this.editImportPath(); break;
      case "tasks": await this.tui.openTasks(); break;
      case "results": await this.tui.nav("scores"); break;
      case "review": await this.tui.nav("review"); break;
      case "judge": this.tui.openJudge(); break;
      case "settings": this.tui.gotoSettings(); break;
      case "current": this.tui.openCurrentTask(); break;
      case "help": this.commands.open(); break;
      case "quit": break;
    }
  }

  setQuitHandler(fn: () => void | Promise<void>): void {
    this.onQuit = fn;
  }

  /** P1-2: quitting stops the running task and waits for in-flight requests to
   *  abort + archives to flush BEFORE the terminal is torn down — otherwise the
   *  batch keeps calling the model after the UI is gone. */
  private async quit(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    this.clearOpeningTimers();
    this.clearPageMotion();
    try {
      await this.pending;
      await this.tui.stopAndWait();
      await this.onQuit?.();
    } catch (error) {
      this.quitting = false;
      this.tui.setMessage(`退出失败：${error instanceof Error ? error.message : String(error)}。请检查后重试退出。`);
      this.rerender?.();
    }
  }

  invalidate(): void {
    /* stateless render from controller */
  }

  private termRows(): number {
    const r = (process.stdout as { rows?: number }).rows;
    return typeof r === "number" && r > 0 ? r : 30;
  }

  // ── intro animation (Next_Plan §2) ────────────────────────────────────────
  startOpening(): void {
    this.clearOpeningTimers();
    this.openingElapsed = 0;
    const started = Date.now();
    const timer = setInterval(() => {
      if (this.tui.getState().screen.kind !== "opening") { this.clearOpeningTimers(); return; }
      this.openingElapsed = Math.min(OPENING_DURATION_MS, Date.now() - started);
      if (this.openingElapsed >= OPENING_DURATION_MS) { this.finishOpening(); return; }
      this.rerender?.();
    }, OPENING_TICK_MS);
    this.openingTimers = [timer];
  }

  private clearOpeningTimers(): void {
    for (const t of this.openingTimers) clearTimeout(t);
    this.openingTimers = [];
  }

  private finishOpening(): void {
    this.clearOpeningTimers();
    if (this.tui.getState().screen.kind === "opening") this.perform(() => this.tui.gotoHome());
  }

  private clearPageMotion(): void {
    if (!this.pageMotion) return;
    clearInterval(this.pageMotion.timer);
    this.pageMotion = undefined;
  }

  private pageMascotPose(screen: Screen["kind"], visible: boolean): EntrancePose {
    const color = PAGE_MASCOTS[screen];
    if (!visible || color === "orange" || !this.tui.animationEnabled() || this.quitting) {
      this.clearPageMotion();
      return "idle";
    }
    if (this.pageMotion?.screen !== screen) this.clearPageMotion();
    if (!this.pageMotion) {
      if (this.playedPageColors.has(color) || !this.rerender) return "idle";
      this.playedPageColors.add(color);
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (this.tui.getState().screen.kind !== screen || Date.now() - startedAt >= PAGE_ENTRANCE_DURATION_MS) {
          this.clearPageMotion();
        }
        this.rerender?.();
      }, OPENING_TICK_MS);
      this.pageMotion = { screen, startedAt, timer };
    }
    return pageEntrancePose(color, Date.now() - this.pageMotion.startedAt);
  }

  dispose(): void {
    this.collectionUnsubscribe?.();
    this.chatUnsubscribe?.();
    this.clearOpeningTimers();
    this.clearPageMotion();
    clearInterval(this.runTimer);
  }

  // ── render ───────────────────────────────────────────────────────────────
  render(width: number): string[] {
    this.hot = [];
    const w = Math.max(1, width);
    this.width = w;
    const screen = this.tui.getState().screen;
    if (screen.kind === "opening") return this.renderOpening(w);
    const live = screen.kind === "run" ? this.tui.getService().getStatus(screen.taskId) : undefined;
    const pageFooter = wrapTextWithAnsi(paint(" " + this.footer(), S.gray), w);
    const commandFooter = wrapTextWithAnsi(paint(" " + COMMAND_FOOTER, S.gray), w);
    const footer = this.commands.menuVisible ? commandFooter : pageFooter;
    while (footer.length < Math.max(pageFooter.length, commandFooter.length)) footer.unshift("");
    const metrics = live?.telemetry?.summary ?? (screen.kind === "report" ? screen.report.metrics?.summary : screen.kind === "chat" ? this.chatPane().workspace.metrics() : undefined);
    if (metrics) {
      const requested = live?.telemetry?.questions[this.scrollTop]?.requests.at(-1)?.requestedThinkingLevel;
      footer.unshift(truncateToWidth(paint(" " + runtimeStatusLine(metrics, screen.kind === "run" ? requested ?? null : undefined), S.gray), w));
    }
    const height = this.termRows();
    const labels: Record<Screen["kind"], string> = {
      opening: "", home: "", bank: "题库", datasets: "创建测评 / 题集", check: "创建测评 / 题集检查",
      setup: "创建测评 / 提供商", pickmodel: "创建测评 / 模型", confirm: "创建测评 / 确认",
      importPreview: "导入 / 预览", run: "当前任务", tasks: "历史任务", detail: "任务详情",
      draftQuestion: "导入 / 逐题核对", draftImage: "导入 / 原图核对",
      report: "成绩", review: "人工复核", reviewImage: "人工复核 / 原图核对", settings: "设置",
      exceptions: "异常结果", usage: "异常结果 / 用量核对",
      judge: "独立裁判 / 配置", judgeConfirm: "独立裁判 / 确认", judgeRun: "独立裁判 / 运行", calibration: "独立裁判 / 人工样本校准",
      calibrationSample: "人工样本校准 / 完整样本",
      collection: "对话搜题与组卷", chat: "普通对话",
    };
    const mascotColor = PAGE_MASCOTS[screen.kind];
    const colorway = this.fieldInput ? "pink" : mascotColor;
    const accent = MASCOT_ACCENTS[colorway];
    const badge = mascotStatus(live);
    const badgeColor = badge.tone === "error" ? S.red : badge.tone === "warning" ? S.yellow : badge.tone === "success" ? S.green : accent;
    const header = screen.kind === "home" ? [] : [paint(" " + PROJECT_NAME, S.bold, accent) + paint("  /  " + labels[screen.kind], S.gray) + (screen.kind === "run" ? paint(`  · ${badge.label}`, badgeColor) : ""), this.tui.demoSource ? paint(" " + OFFLINE_DEMO_LABEL, S.yellow) : screen.kind === "run" ? paint(" " + badge.detail, S.gray) : ""];
    // 首页角色和字标独立于命令菜单；候选项只占据右下输入区。
    const heroRows = Math.max(1, height - 3 - footer.length - (KEYDEBUG ? 1 : 0));
    const home = screen.kind === "home" ? this.homeLayout(screen, w, heroRows) : undefined;
    // 完整人物只用于概览页；阅读与答题页面使用全部宽度。按菜单展开后的空间判断，避免开关菜单改变人物。
    const menuSlots = Math.max(1, Math.min(5, height - header.length - footer.length - 7));
    const expandedDockTop = height - footer.length - (KEYDEBUG ? 1 : 0) - 3 - menuSlots;
    const sideSize = !MASCOT_OVERVIEWS.has(screen.kind) ? 0
      : w >= 148 && expandedDockTop >= 35 ? 64
      : w >= 128 && expandedDockTop >= 27 ? 48 : 0;
    const sidePose = this.pageMascotPose(screen.kind, !!sideSize && !this.fieldInput && !this.commands.active);
    const contentLeft = sideSize ? sideSize + 7 : 0;
    const slots = this.commands.menuVisible ? menuSlots : 0;
    const dockTop = height - footer.length - (KEYDEBUG ? 1 : 0) - 3 - slots;
    this.commandLeft = home && home.size && home.artY + home.size / 2 > dockTop ? home.brandX : 0;
    const dockWidth = Math.max(1, w - this.commandLeft - (this.commandLeft ? 2 : 0));
    const collection = screen.kind === "collection" ? this.collectionPane() : undefined;
    const chat = screen.kind === "chat" ? this.chatPane() : undefined;
    const dock = chat?.usesDock && !this.commands.active ? chat.renderDock(dockWidth, slots) : collection?.usesDock && !this.commands.active ? collection.renderDock(dockWidth, slots) : this.fieldInput
      ? [paint("─".repeat(dockWidth), S.gray), ...this.fieldInput.render(dockWidth), paint("─".repeat(dockWidth), S.gray), ...Array<string>(slots).fill("")]
      : this.commands.render(dockWidth, slots, screen.kind === "home", accent);
    this.commandHeight = dock.length;
    this.commandTop = Math.max(header.length, height - footer.length - (KEYDEBUG ? 1 : 0) - dock.length);
    this.bodyRows = home ? heroRows : Math.max(1, this.commandTop - header.length);
    this.width = Math.max(1, w - contentLeft - (contentLeft ? 2 : 0));
    this.collectionLeft = contentLeft; this.collectionTop = header.length;
    const body: string[] = [];
    this.renderScreen(body, this.width);
    const lines = Array.from({ length: height }, () => "");
    this.place(lines, header, 0, 0);
    this.place(lines, body.slice(0, this.bodyRows), contentLeft, header.length);
    this.hot = this.hot.filter((zone) => zone.y < this.bodyRows).map((zone) => ({
      ...zone, y: zone.y + header.length, x0: (zone.x0 ?? 0) + contentLeft, x1: (zone.x1 ?? this.width) + contentLeft,
    }));
    if (sideSize) {
      this.place(lines, renderMascotDisplay(sideSize, sideSize / 2, sidePose, mascotColor, "entrance"), 2, 2);
    }
    this.place(lines, dock, this.commandLeft, this.commandTop);
    this.place(lines, footer, 0, height - footer.length - (KEYDEBUG ? 1 : 0));
    if (KEYDEBUG) lines[height - 1] = paint(" [按键字节] " + (this.keyLog.slice(-4).join("   ") || "…"), S.gray);
    return lines.slice(0, height).map((line) => truncateToWidth(line, w));
  }

  /** 全屏开场：像素吉祥物入场，随后显示醒目的品牌标题。 */
  private renderOpening(w: number): string[] {
    const screen = this.tui.getState().screen;
    if (screen.kind !== "opening" || !screen.home) throw new Error("开场缺少已初始化的首页。");
    const height = this.termRows();
    const homeFooterRows = Math.max(wrapTextWithAnsi(paint(" " + HOME_FOOTER, S.gray), w).length, wrapTextWithAnsi(paint(" " + COMMAND_FOOTER, S.gray), w).length);
    const layout = this.homeLayout(screen.home, w, Math.max(1, height - 3 - homeFooterRows - (KEYDEBUG ? 1 : 0)));
    const beat = openingBeat(this.openingElapsed);
    const heroHeight = Math.max(layout.size / 2, layout.brand.lines.length + 2);
    const heroY = Math.max(0, Math.floor((height - heroHeight - 2) / 2));
    const target = (from: number, to: number) => Math.round(from + (to - from) * beat.settle);
    const artY = target(heroY, layout.artY);
    const artX = target(Math.max(0, layout.artX - Math.round(12 * (1 - beat.walk))), layout.artX);
    const brandY = target(heroY + Math.max(0, Math.floor((heroHeight - layout.brand.lines.length) / 2)), layout.brandY);
    const lines = Array.from({ length: height }, () => "");
    if (layout.size) this.place(lines, renderMascotDisplay(layout.size, layout.size / 2, beat.frame, "orange", "entrance"), artX, artY);
    this.place(lines, renderWordmark(layout.brandWidth, beat.reveal, layout.emphasizedBrand).lines, layout.brandX, brandY);
    if (beat.reveal === 1) this.place(lines, [paint(SLOGAN, S.cyan), paint("多学科模型测评", S.gray)], layout.brandX, brandY + layout.brand.lines.length + 1);
    const hint = "按任意键跳过 · Ctrl+C 退出";
    this.place(lines, [paint(hint, S.gray)], Math.max(0, Math.floor((w - visibleWidth(hint)) / 2)), height - 2);
    return lines.map((line) => truncateToWidth(line, w)).slice(0, height);
  }

  private place(canvas: string[], content: string[], x: number, y: number): void {
    for (const [index, line] of content.entries()) {
      const row = y + index;
      if (row < 0) continue;
      while (canvas.length <= row) canvas.push("");
      const base = canvas[row] ?? "";
      const left = sliceByColumn(base, 0, x);
      canvas[row] = left + " ".repeat(Math.max(0, x - visibleWidth(left))) + line + sliceByColumn(base, x + visibleWidth(line), Math.max(0, visibleWidth(base) - x - visibleWidth(line)));
    }
  }

  private footer(): string {
    if (this.draftEditor) return "Enter 换行 · Ctrl+S 保存草稿 · Esc 取消本次编辑 · Ctrl+C 退出";
    if (this.fieldInput) return "enter 保存字段 · esc 取消输入 · Ctrl+C 退出";
    const s = this.tui.getState().screen;
    if (s.kind === "opening") return "按任意键跳过";
    if (s.kind === "home") return HOME_FOOTER;
    if (s.kind === "collection") return this.collectionPane().footer();
    if (s.kind === "chat") return this.chatPane().footer();
    if (s.kind === "bank") return "↑↓/点击 选择 · Enter 打开 · /import 导入 · Esc 返回 · / 命令";
    if (s.kind === "datasets") return "↑↓/点击选择 · enter进入 · esc返回首页 · q退出";
    if (s.kind === "check") return "enter进入模型设置 · esc返回题集 · q退出";
    if (s.kind === "importPreview") return "↑↓ 选题 · v 核对/编辑 · Enter 校验入库 · d 归档 · Esc 返回";
    if (s.kind === "draftQuestion") return "Tab 视图 · n/p 换题 · ↑↓ 滚动 · e 题干 · f 元数据 · s 评分 · i 图片 · Esc 返回";
    if (s.kind === "draftImage") return "n/p 切换图片 · o 打开原图 · Esc 返回题目 · / 命令";
    if (s.kind === "reviewImage") return "n/p 切换图片 · o 打开原图 · Esc 返回复核 · / 命令";
    if (s.kind === "settings") return "enter/空格 切换动画 · esc 返回首页 · q 退出";
    if (s.kind === "judge") return s.stage === "config" ? "m 模型 · b 预算 · o 输出 · r/d 超时秒数 · t 推理 · ↑↓阅读 · Enter 保存 · Esc 返回" : "↑↓/点击 选择 · Enter 确认 · Esc 返回";
    if (s.kind === "judgeConfirm") return "↑↓ 阅读 · Enter 明确开始裁判（可能计费） · Esc 取消";
    if (s.kind === "judgeRun") return "↑↓ 阅读 · s 停止裁判 · Enter/Esc 完成后返回 · /current 回到任务";
    if (s.kind === "calibration") return s.confirming ? "y 保存样本检查 · Esc 取消 · ↑↓ 阅读摘要" : "n/p 换题 · 空格选 · r 人工核对 · f 样本 · j 请求 · v 离线 · c 检查人 e 依据 · a 摘要 · Esc 返回";
    if (s.kind === "calibrationSample") return s.image ? "n/p 切图 · Esc 返回样本文字 · Ctrl+C 退出" : "1题面 2答卷 3依据 4对照 · i 原图 · ↑↓阅读 · Esc 返回校准";
    if (s.kind === "run") return "↑↓/点击 选择 · Enter 请求明细 · Esc 返回 · s 停止 · / 命令";
    if (s.kind === "setup") return "↑↓/点击 选提供商 · enter 进入模型 · q 退出";
    if (s.kind === "pickmodel") return "↑↓/点击 选模型 · enter 确认 · esc 返回提供商 · m 模式 · +/- 并发 · a API";
    if (s.kind === "confirm") return this.tui.demoSource ? "Enter 执行离线演示 · Esc 返回 · ↑↓ 阅读 · m 模式" : s.recoveryDecision ? "Enter 明确补答一次（可能计费） · ↑↓ 阅读 · Esc 取消" : s.resume ? "Enter 确认续跑 · Esc 返回记录 · ↑↓ 阅读 · 未知结果不重发" : "Enter 开始(计费) · Esc 返回 · b 预算 · m 模式 · t 推理 · +/- 并发 · a API";
    if (s.kind === "report") return "m 切换 without_tool/with_tool · esc 返回 · q 退出";
    if (s.kind === "detail") return "↑↓ 浏览题目 · Enter 报告 · k 校准 · x 异常处理 · v 续跑 · Esc 历史";
    if (s.kind === "exceptions") return "n/p 换题 · ↑↓ 阅读 · c 决定人 · e 原因 · u 核对用量 · Enter 补答确认 · Esc 返回";
    if (s.kind === "usage") return s.confirming ? "y 保存用量核对 · Esc 返回 · ↑↓ 阅读" : "s Token数 · c 确认人 · e 依据 · Enter 检查摘要 · Esc 返回";
    if (s.kind === "review") return s.confirming ? "y 保存评分 · esc 取消确认 · ↑↓ 浏览摘要 · q 退出" : s.calibrationParent ? "校准人工核对 · 1题面 2答卷 3依据 · i图片 · s分数 c确认人 e理由 · Enter确认 · Esc返回校准" : "1题面 2答卷 3依据 · i图片 · j初评 · ↑↓滚动 · n/p换题 · s分数 c确认人 e理由 · Enter确认";
    return "q 退出 · ↑↓/滚轮 选择 · enter/点击 确认 · esc 返回";
  }

  private judgeBody(lines: string[], text: string, reserved: number): void {
    const body = wrapTextWithAnsi(terminalText(text), Math.max(1, this.width));
    const room = Math.max(1, this.bodyRows - lines.length - reserved);
    this.scrollTop = Math.min(this.scrollTop, Math.max(0, body.length - room));
    lines.push(...body.slice(this.scrollTop, this.scrollTop + room));
  }

  private row(lines: string[], selected: boolean, label: string, run: () => void | Promise<unknown>, extra = ""): void {
    const y = lines.length;
    const marker = selected ? paint(" ▶ ", S.green, S.bold) : "   ";
    const metadata = truncateToWidth(extra, Math.floor(this.width / 3));
    const available = Math.max(4, this.width - 3 - (metadata ? visibleWidth(metadata) + 2 : 0));
    // 长任务标识保留末尾的唯一编号，避免终端裁掉状态或把不同任务显示成同一行。
    const tailWidth = Math.min(18, Math.floor(available / 2));
    const shown = visibleWidth(label) > available
      ? truncateToWidth(label, available - tailWidth) + sliceByColumn(label, visibleWidth(label) - tailWidth, tailWidth)
      : label;
    const body = selected ? paint(shown, S.rev, S.bold) : paint(shown, S.bold);
    lines.push(marker + body + (metadata ? "  " + metadata : ""));
    this.hot.push({ y, run: () => this.perform(run) });
  }

  private action(lines: string[], label: string, run: () => void | Promise<unknown>, color = S.blue, selected = false): void {
    const y = lines.length;
    const marker = selected ? paint("▶ ", S.yellow, S.bold) : "  ";
    const text = selected ? paint(label, S.bold, S.white, S.rev) : paint(label, S.bold, color);
    lines.push(" " + marker + text);
    this.hot.push({ y, run: () => this.perform(run) });
  }

  /** Scrolling window over a long list; follows `selected`. pi-tui clips lines
   *  beyond the terminal height, so we only emit a page + ↑/↓ "more" hints. */
  private windowedList(lines: string[], total: number, selected: number, height: number, draw: (i: number, sel: boolean) => void, unit = "项"): void {
    const showHints = height >= 3;
    const size = Math.max(1, height - (showHints ? 2 : 0));
    if (total <= size) {
      for (let i = 0; i < total; i++) draw(i, i === selected);
      return;
    }
    let start = selected - Math.floor(size / 2);
    start = Math.max(0, Math.min(start, total - size));
    if (showHints && start > 0) lines.push(paint(`   ↑ ··· 上方还有 ${start} ${unit}`, S.gray));
    for (let k = 0; k < size; k++) draw(start + k, start + k === selected);
    const end = start + size;
    if (showHints && end < total) lines.push(paint(`   ↓ ··· 下方还有 ${total - end} ${unit}`, S.gray));
  }

  private bankItems(screen: Extract<Screen, { kind: "bank" }>): BankItem[] {
    const items: BankItem[] = [];
    for (const d of screen.datasets) items.push({ kind: "dataset", id: d.datasetId, label: d.datasetId, extra: `${d.questions} 题 · 已确认` });
    for (const dr of screen.drafts) items.push({ kind: "draft", id: dr.draftId, label: dr.draftId, extra: `${dr.datasetId} · ${dr.questions.length} 题 · 草稿${dr.warnings.length ? ` · ${dr.warnings.length} 警告` : ""}` });
    return items;
  }

  private renderScreen(lines: string[], _w: number): void {
    const screen = this.tui.getState().screen;
    const rows = this.bodyRows + 6;
    const message = this.tui.getState().message;
    if (message && screen.kind !== "home" && screen.kind !== "run" && screen.kind !== "review" && screen.kind !== "opening" && screen.kind !== "chat") lines.push(paint(truncateToWidth("   " + terminalText(message), this.width), S.yellow));
    switch (screen.kind) {
      case "opening":
        break; // full-screen intro handled in render()
      case "home":
        this.renderHome(lines, screen);
        break;
      case "settings":
        this.renderSettings(lines, screen);
        break;
      case "collection":
        lines.push(...this.collectionPane().render(this.width, this.bodyRows));
        break;
      case "chat":
        lines.push(...this.chatPane().render(this.width, this.bodyRows, message));
        break;
      case "judge": {
        lines.push(paint(" 独立裁判配置 · 保存不发送请求", S.bold, S.yellow));
        if (screen.stage === "provider") {
          this.windowedList(lines, screen.groups.length, screen.providerIndex, Math.max(1, this.bodyRows - lines.length - 1), (index, selected) => {
            const group = screen.groups[index]!;
            this.row(lines, selected, group.displayName, () => this.tui.chooseJudge(index), `${group.models.length} 模型 · ${group.runnable ? "凭据已配置" : "凭据未配置"}`);
          }, "家");
        } else if (screen.stage === "model") {
          const group = screen.groups[screen.providerIndex];
          this.windowedList(lines, group?.models.length ?? 0, screen.modelIndex, Math.max(1, this.bodyRows - lines.length - 1), (index, selected) => {
            const model = group!.models[index]!;
            this.row(lines, selected, model.modelId, () => this.tui.chooseJudge(index), `${model.imageInput ? "图片" : "文本"}${model.reasoning ? " · 推理" : ""}`);
          }, "个");
        } else {
          const d = screen.draft;
          this.judgeBody(lines, [`模型 ${d.profileId || "未选择"} / ${d.modelId || "未选择"}`,
            `每次裁判任务预算 ${d.maxTotalTokens ?? "必须填写"} Token [b]`, `每次请求最大输出 ${d.limits.maxOutputTokens} Token [o]`,
            `请求/流空闲 ${d.limits.requestTimeoutMs / 1000} 秒 [r] · 整体 ${d.limits.totalRunTimeMs / 1000} 秒 [d]`,
            `推理等级 ${d.thinkingLevel} [t]`, "未校准；初评不计入确认成绩。原图能力以端点证据为准。"].join("\n\n"), 2);
          this.action(lines, "选择裁判提供商与模型 [m] →", () => this.tui.judgePicker());
          this.action(lines, "✔ 保存独立裁判配置", () => this.tui.saveJudge(), S.green);
        }
        break;
      }
      case "judgeConfirm": {
        const p = screen.plan;
        lines.push(paint(" 明确确认裁判请求", S.bold, S.yellow));
        this.judgeBody(lines, [p.purpose === "calibration" ? "用途：与选定人工样本对照，不覆盖人工成绩。" : "用途：当前题初评，仍需人工确认。",
          `裁判 ${p.provider} / ${p.modelId}`, `实际端点 ${p.baseUrl}`, `图片能力 ${p.imageSupport} · 未校准`,
          `新请求 ${p.items.filter((i) => i.disposition === "request").length} · 复用 ${p.items.filter((i) => i.disposition === "reuse").length} · 阻止 ${p.items.filter((i) => i.disposition === "blocked").length}`,
          `任务预算 ${p.config.maxTotalTokens} Token · 最大输出 ${p.config.limits.maxOutputTokens} · 推理 ${p.config.thinkingLevel}`,
          "每题独立请求，无工具、无自动重试。Token 预留为本地估算，实际计费以供应商为准。",
          ...p.items.map((item) => `${item.questionId} · ${item.disposition}${item.reason ? ` · ${item.reason}` : ""}`)].join("\n\n"), 2);
        this.action(lines, "✔ 明确开始裁判（新请求可能计费）", () => this.onJudgeStart(), S.green);
        this.action(lines, "取消，保留原页面 →", () => this.tui.cancelJudgePlan(), S.gray); break;
      }
      case "judgeRun": {
        const status = this.tui.getJudgeService().getStatus(screen.jobId);
        lines.push(paint(` 独立裁判 · ${status?.state ?? "无记录"}`, S.bold, S.yellow));
        const b = status?.budget;
        this.judgeBody(lines, [`${screen.plan.provider} / ${screen.plan.modelId}`, status?.error ?? "初评结果不计入确认成绩。",
          b ? `Token 已知 ${b.knownTokens}/${b.maxTotalTokens} · 预留 ${b.reservedTokens} · 未知预留 ${b.unknownReservedTokens}` : "等待预算记录。",
          ...(status?.metrics ? summaryLines(summarizeRequests(status.metrics.requests)) : []),
          ...(status?.items.map((item) => `${item.questionId} · ${item.state}${item.score === undefined ? "" : ` · 初评 ${item.score}`}${item.error ? `\n${item.error}` : ""}${item.error && item.response ? `\n裁判返回文本 · 停止原因 ${item.response.stopReason}${item.response.containsToolCalls ? " · 含工具调用" : ""}\n${item.response.text || "（无文本）"}` : ""}`) ?? [])].join("\n\n"), 1);
        this.action(lines, status?.state === "running" ? "■ 停止裁判并保存" : "返回评分 / 校准页面 →", () => status?.state === "running" ? this.tui.getJudgeService().stop(screen.jobId) : this.tui.finishJudge(), S.green); break;
      }
      case "calibrationSample": {
        const sample = screen.sample;
        lines.push(paint(` 校准样本 ${sample.question.id} · 人工 ${sample.humanGrade.rawScore}/${sample.scoring.maxScore} · 裁判 ${sample.judgeGrade?.rawScore ?? sample.judgeState}`, S.bold, S.yellow));
        if (screen.image) {
          lines.push(truncateToWidth(terminalText(` 原图 ${screen.image.ref} · ${screen.image.width}×${screen.image.height}`), this.width));
          lines.push(...renderQuestionImage(screen.image, this.width, Math.max(1, this.bodyRows - lines.length))); break;
        }
        const gradeText = (label: string, grade: typeof sample.humanGrade | undefined) => grade ? [label, `${grade.rawScore}/${grade.maxScore} · ${grade.reviewStatus}`,
          ...grade.items.map((item, i) => `第${i + 1}项${item.partLabel ? ` ${item.partLabel}` : ""} ${item.points} 分\n原文证据 ${item.evidence || "未提供"}\n${item.note ?? ""}`)].join("\n\n") : `${label}\n${sample.judgeState}\n${sample.judgeError ?? "尚无有效结果"}`;
        const content = screen.tab === "question" ? [sample.question.stem, ...Object.entries(sample.question.options ?? {}).map(([key, value]) => `${key}. ${value}`), ...(sample.question.parts ?? []).map((part) => `${part.label} ${part.prompt}`), ...sample.question.assets.map((asset) => `${asset.mediaType.startsWith("image/") ? "原图" : "公开附件"} ${asset.ref} ${asset.alt ?? ""}`)].join("\n\n")
          : screen.tab === "answer" ? sample.answer : screen.tab === "basis" ? JSON.stringify(sample.scoring, null, 2)
          : `${gradeText("人工确认评分（总分确认可能没有逐项证据）", sample.humanGrade)}\n\n${gradeText("独立裁判分项与证据", sample.judgeGrade)}${!sample.judgeGrade && sample.judgeResponse ? `\n\n裁判返回文本 · 停止原因 ${sample.judgeResponse.stopReason}${sample.judgeResponse.containsToolCalls ? " · 含工具调用" : ""}\n${sample.judgeResponse.text || "（无文本）"}` : ""}`;
        this.judgeBody(lines, content, 1); this.action(lines, "返回校准列表，保留草稿 →", () => this.tui.closeCalibrationSample(), S.gray); break;
      }
      case "calibration": {
        lines.push(paint(" 人工样本校准 · 不自动计分", S.bold, S.yellow));
        if (screen.confirming && screen.report) {
          this.judgeBody(lines, [`确认仅保存这一组样本的人工检查`, `样本 ${screen.report.summary.compared}/${screen.report.summary.total}`,
            `最大绝对分差 ${screen.report.summary.maxAbsoluteError} · 检查人 ${screen.by}`, `依据 ${screen.reason}`,
            "范围仅限所列样本、材料及裁判配置，不推断全学科有效，不升级任何初评成绩。"].join("\n\n"), 1);
          this.action(lines, "✔ 明确保存这组样本检查", () => this.tui.confirmCalibration(), S.green); break;
        }
        const current = screen.candidates[screen.index]; const r = screen.report;
        const canReview = !!current && !current.humanConfirmed;
        this.judgeBody(lines, [`人工已确认 ${screen.candidates.filter((item) => item.humanConfirmed).length} · 可请求 ${screen.candidates.filter((item) => item.requestReady).length} · 已选 ${screen.selected.length}`,
          ...(screen.judgeIssue ? [screen.judgeIssue] : []),
          current ? `${screen.index + 1}/${screen.candidates.length} ${current.questionId} · ${current.subject}/${current.answerKind}\n${current.humanConfirmed ? `人工 ${current.humanScore}/${current.maxScore}` : "尚未人工确认，按 r 核对"} · ${screen.selected.includes(current.trialId) ? "已选" : "未选"}\n${current.requestReady ? "当前裁判可请求，仍需单独确认。" : current.requestBlockReason}` : "暂无完整答卷可供人工核对，请先检查任务材料。",
          `检查人 ${screen.by || "未填写"} · 依据 ${screen.reason || "未填写"}`,
          ...(r ? [`已对照 ${r.summary.compared}/${r.summary.total} · 完全一致 ${r.summary.exact}\n平均绝对分差 ${r.summary.meanAbsoluteError ?? "无结果"} · 最大 ${r.summary.maxAbsoluteError ?? "无结果"} · 偏差 ${r.summary.bias ?? "无结果"}`,
            ...(r.review ? [`本组人工检查已保存 · ${r.review.by}\n${r.review.reason}`] : []),
            ...r.rows.map((row) => `${row.questionId ?? row.trialId} · ${row.state} · 人工 ${row.humanScore ?? "不可用"} / 裁判 ${row.judgeScore ?? "未完成"}`),
            `学科分组 ${JSON.stringify(r.bySubject)}`, `题型分组 ${JSON.stringify(r.byAnswerKind)}`] : ["n/p 选择答卷，空格加入或移出；j 发起对照。人工分数不提供给裁判。"]),
          "仅对所选样本做比较；分数保持原始分值，不归一化或加权。"].join("\n\n"), canReview ? 3 : 2);
        this.action(lines, "检查所选样本的裁判请求 [j] →", () => this.tui.prepareJudge());
        this.action(lines, r ? "人工检查确认摘要 [a] →" : "离线读取已有对照 [v] →", () => r ? this.tui.confirmCalibration() : this.tui.loadCalibrationReport(), S.green);
        if (canReview) this.action(lines, "人工核对当前答卷 [r] →", () => this.tui.openCalibrationReview(), S.cyan);
        break;
      }
      case "bank":
        this.renderBank(lines, screen, rows);
        break;
      case "importPreview":
        this.renderImportPreview(lines, screen, rows);
        break;
      case "draftQuestion":
        this.renderDraftQuestion(lines, screen);
        break;
      case "draftImage":
      case "reviewImage": {
        const q = screen.kind === "draftImage" ? screen.review.draft.questions[screen.review.index]! : screen.parent.items[screen.parent.index]!.question!;
        const indices = (q.assets ?? []).flatMap((asset, index) => mediaTypeForRef(asset.ref) ? [index] : []);
        lines.push(paint(terminalText(` 原图核对 ${q.id} · ${indices.indexOf(screen.assetIndex) + 1}/${indices.length}`), S.bold, S.yellow));
        lines.push(truncateToWidth(terminalText(` ${screen.image.ref} · ${screen.image.width}×${screen.image.height} · SHA256 ${screen.image.digest}`), this.width));
        lines.push(paint(" 终端显示缩略预览；细小文字、曲线和标注请打开原图核对。", S.gray));
        lines.push(...renderQuestionImage(screen.image, this.width, Math.max(1, this.bodyRows - lines.length - 2)));
        this.action(lines, "打开系统原图查看器 [o]", () => this.tui.openOriginalImage(), S.green);
        break;
      }
      case "datasets": {
        lines.push(paint(" 选择题集", S.bold, S.yellow) + paint("  (↑↓/点击 选择 · enter 进入)", S.gray));
        const ds = this.tui.getState().datasets;
        if (ds.length === 0) lines.push(paint("   (无题集：datasets/ 下需有 public/ 与 scoring/)", S.gray));
        this.windowedList(lines, ds.length, this.menuIndex, Math.max(5, rows - 9), (i, sel) =>
          this.row(lines, sel, ds[i]!.id, () => {
            this.menuIndex = i;
            return this.tui.checkDataset(ds[i]!.id);
          }, paint(`${i + 1}`, S.gray)),
        );
        break;
      }
      case "check": {
        const r = screen.report;
        lines.push(paint(` 题集检查：${r.datasetId}`, S.bold, S.yellow));
        lines.push(`   题目 ${paint(String(r.total), S.bold)} · 可运行 ${paint(String(r.confirmed), S.green, S.bold)} · 计划满分 ${paint(String(r.plannedMax), S.cyan, S.bold)}`);
        const kinds = Object.entries(r.byAnswerKind).map(([k, n]) => `${k}×${n}`).join(" · ");
        lines.push(`   题型组成：${paint(kinds || "无", S.gray)} · 未评分 ${paint(String(r.missingScoring.length), r.missingScoring.length ? S.yellow : S.green, S.bold)} 题`);
        lines.push(`   缺评分文件：${r.missingScoring.length ? paint(r.missingScoring.join(", "), S.red) : paint("无", S.green)}`);
        lines.push(`   缺图/坏图：${r.missingImages.length ? paint(r.missingImages.join(", "), S.red) : paint("无", S.green)}`);
        if (r.errors.length) {
          lines.push(paint("   错误题面：", S.red));
          for (const e of r.errors.slice(0, 8)) lines.push(paint(`     ${e.questionId}: ${e.errors.join("; ")}`, S.gray));
        }
        this.action(lines, "进入模型与模式设置 →", () => this.tui.openSetup());
        break;
      }
      case "setup": {
        const catalog = this.tui.demoSource ? "  (本地脚本 · 无需 API Key)" : "  (pi 内置目录 + 自定义端点 · ↑↓/点击)";
        lines.push(paint(" 选择提供商", S.bold, S.yellow) + paint(catalog, S.gray));
        const gs = screen.groups;
        this.windowedList(lines, gs.length, screen.providerIndex, Math.max(5, rows - 12), (i, sel) => {
          const g = gs[i]!;
          const badge = g.runnable ? paint("✓ 可跑", S.green, S.bold) : paint(`未配 ${g.keyEnv ?? "KEY"}`, S.yellow);
          const src = g.source === "custom" ? paint("自定义", S.cyan) : paint("pi内置", S.gray);
          this.row(lines, sel, g.displayName, () => this.tui.highlightProvider(i), `${src} · ${g.models.length} 模型 · ${badge}`);
        }, "家");
        lines.push("");
        const s: Setup = screen.setup;
        lines.push(`   当前：${paint(s.profileId, S.cyan, S.bold)} / ${paint(s.modelId || "(未选)", S.bold)}`);
        lines.push(`   模式：${paint(s.mode === "both" ? "双模式（分别计分）" : s.mode, S.cyan, S.bold)} ${paint("[m]", S.gray)} · 答题并发 ${paint(String(s.concurrency), S.bold)} ${paint("[+/-]", S.gray)} · API并发 ${paint(String(s.apiConcurrency ?? "不限"), S.bold)} ${paint("[a]", S.gray)}`);
        this.action(lines, "进入该提供商的模型 →", () => this.tui.selectProvider(screen.providerIndex), S.green);
        break;
      }
      case "pickmodel": {
        const g: ProviderGroup = screen.group;
        lines.push(paint(` ${g.displayName} 的模型`, S.bold, S.yellow) + paint(`  (${g.models.length} 个 · ↑↓/点击 选 · enter 确认 · esc 返回)`, S.gray));
        this.windowedList(lines, g.models.length, screen.modelIndex, Math.max(5, rows - 12), (i, sel) => {
          const m = g.models[i]!;
          const tags = (m.imageInput ? paint("图", S.magenta, S.bold) : paint("文", S.gray)) + (m.reasoning ? paint(" 推理", S.blue) : "") + (m.contextWindow ? paint(` ${Math.round(m.contextWindow / 1000)}k`, S.gray) : "");
          this.row(lines, sel, m.modelId, () => this.tui.highlightModel(i), tags + (m.displayName && m.displayName !== m.modelId ? paint(`  ${m.displayName}`, S.gray) : ""));
        }, "个");
        lines.push("");
        const s: Setup = screen.setup;
        lines.push(`   已选：${paint(s.profileId, S.cyan, S.bold)} / ${paint(s.modelId, S.bold)}`);
        lines.push(`   模式：${paint(s.mode === "both" ? "双模式（分别计分）" : s.mode, S.cyan, S.bold)} ${paint("[m]", S.gray)} · 答题并发 ${paint(String(s.concurrency), S.bold)} ${paint("[+/-]", S.gray)} · API并发 ${paint(String(s.apiConcurrency ?? "不限"), S.bold)} ${paint("[a]", S.gray)}`);
        this.action(lines, "✔ 确认该模型 →", () => this.tui.selectModel(screen.modelIndex), S.green);
        this.action(lines, "← 返回提供商", () => this.tui.backToProviders(), S.gray);
        break;
      }
      case "confirm": {
        const s: Setup = screen.setup;
        lines.push(paint(screen.recoveryDecision ? " 明确重新作答一次（原记录保留）" : screen.resume ? " 确认历史续跑（保留原计划和配置）" : " 确认任务", S.bold, S.yellow));
        lines.push(`   提供商/模型：${paint(`${s.profileId} / ${s.modelId}`, S.cyan, S.bold)}`);
        lines.push(`   模式：${paint(s.mode === "both" ? "without_tool + with_tool（独立作答、分别计分）" : s.mode, S.cyan, S.bold)}   ${paint(screen.resume ? "" : "[m 切换]", S.gray)}`);
        lines.push(`   请求推理强度：${paint(s.thinkingLevel ?? "off", S.cyan)} ${paint(screen.resume ? "（原设置）" : "[t 切换 Pi 支持的等级]", S.gray)}`);
        lines.push(paint("   兼容端点支持情况以实际发送参数与服务端证据为准。", S.gray));
        lines.push(`   同时答题数：${paint(String(s.concurrency), S.bold)}   ${paint(screen.resume ? "（原设置）" : "[+/-]", S.gray)}`);
        lines.push(`   同时 API 请求数：${paint(String(s.apiConcurrency ?? "不限"), S.bold)}   ${paint(screen.resume ? "（原设置）" : "[a 切换 1/2/不限]", S.gray)}`);
        lines.push("");
        if (screen.resume) {
          lines.push(`   原计划 ${screen.resume.manifest.plannedQuestionIds.length} 题 · 待执行 ${screen.resume.queued} · 保留 ${screen.resume.retained} · 待决定 ${screen.resume.blocked}`);
          lines.push(paint("   只执行未开始或确认未发出的题；未知和中断题不重发。", S.yellow));
        }
        lines.push(`   批次 Token 上限：${s.batchTokenLimit ?? "未设置"}${screen.resume ? "（原额度，延续消耗）" : " [b 编辑，留空取消]"}`);
        lines.push(paint("   双模式共享额度；预留含估算输入和最大输出。未知用量停止新请求。", S.gray));
        if (screen.recoveryDecision) {
          const d = screen.recoveryDecision;
          lines.push(`   仅补答 ${d.questionId}；其余题不发送请求。`, terminalText(`   决定人 ${d.by} · 原因 ${d.reason}`),
            this.tui.demoSource ? "   补答写入新演示任务，保留原记录。" : "   原请求可能已计费。此次补答写入新任务，不覆盖原答卷，不取最好成绩。");
        }
        const body = wrapTextWithAnsi(lines.splice(1).join("\n"), this.width);
        const room = Math.max(1, this.bodyRows - 4);
        this.scrollTop = Math.min(this.scrollTop, Math.max(0, body.length - room));
        lines.push(...body.slice(this.scrollTop, this.scrollTop + room));
        lines.push(paint(` ↑↓ 阅读 ${this.scrollTop + 1}–${Math.min(body.length, this.scrollTop + room)}/${body.length}`, S.gray));
        const startLabel = this.tui.demoSource ? (screen.resume ? "✔ 续跑离线演示" : "✔ 执行离线演示")
          : screen.recoveryDecision ? "✔ 明确补答一次（可能再次计费）" : screen.resume ? "✔ 确认续跑（新请求可能计费）" : "✔ 开始任务（真实计费）";
        this.action(lines, startLabel, () => this.onStart(), S.green);
        this.action(lines, "← 返回", () => this.tui.backToModels(), S.gray);
        break;
      }
      case "run": {
        const st = this.tui.getState();
        const status = this.tui.getService().getStatus(screen.taskId);
        const stopSaved = status?.state === "stopped" && status.events.at(-1)?.type === "task_done";
        const label = status?.state === "error" ? "任务失败" : status?.state === "budget_paused" ? "预算保护已暂停（记录已保存）" : status?.state === "done" ? "任务完成" : stopSaved ? "已停止（记录已保存）" : status?.state === "stopped" ? "已请求停止" : "运行中";
        lines.push(paint(` ${label} task=${screen.taskId}`, S.bold, status?.state === "error" ? S.red : S.green) + (st.message ? paint("  · " + st.message, S.yellow) : ""));
        if (status?.error) lines.push(paint("   " + status.error, S.red));
        this.action(lines, "■ 停止任务", () => this.tui.stop(), S.red);
        const telemetry = status?.telemetry;
        if (!telemetry) {
          lines.push(paint("   等待任务记录；指标未提供", S.gray));
          for (const e of st.events.slice(-Math.max(1, this.bodyRows - lines.length))) lines.push("   " + this.eventLine(e));
          break;
        }
        lines.push(` ${telemetry.provider} / ${telemetry.modelId} · ${telemetry.mode}`);
        lines.push(` 已处理 ${telemetry.processed}/${telemetry.questions.length} · 载入 ${telemetry.reused} · 用时 ${seconds(telemetry.elapsedMs)}`);
        if (!this.runExpanded) lines.push(` 答题并发 ${telemetry.concurrency ?? "未记录"} · API 并发 ${telemetry.apiConcurrency === "unlimited" ? "不限" : telemetry.apiConcurrency ?? "未记录"} · 请求中 ${telemetry.activeRequests} · 工具 ${telemetry.toolCalls} / 错误 ${telemetry.toolErrors}`);
        if (telemetry.budget) {
          const b = telemetry.budget;
          lines.push(paint(` 预算 ${b.knownTokens}/${b.maxTotalTokens}（人工核对 ${b.reconciledTokens}） · 请求预留 ${b.reservedTokens} · 未知预留 ${b.unknownReservedTokens}（${b.unknownRequests} 条）`, S.yellow));
        }
        // 请求详情和题目选择优先占位，批次摘要按剩余行数展示；完整指标仍在底栏和报告中。
        const summaryRows = Math.max(0, Math.min(this.runExpanded ? 2 : 4, this.bodyRows - lines.length - (this.runExpanded ? 6 : 3)));
        lines.push(...summaryLines(telemetry.summary).slice(0, summaryRows).map((line) => " " + line));
        this.scrollTop = Math.min(this.scrollTop, Math.max(0, telemetry.questions.length - 1));
        const question = telemetry.questions[this.scrollTop];
        if (!question) break;
        if (this.runExpanded) {
          lines.push(paint(` ${question.questionId} · ${question.terminationCause ? TERMINATION_LABELS[question.terminationCause] ?? question.terminationCause : "请求明细"} · Esc 返回题目列表`, S.cyan));
          this.menuIndex = Math.min(this.menuIndex, Math.max(0, question.requests.length - 1));
          const request = question.requests[this.menuIndex];
          if (request) {
            lines.push(paint(` ↑↓ 切换请求 ${this.menuIndex + 1}/${question.requests.length}`, S.gray));
            lines.push(...requestLines(request).map((line) => " " + line));
          } else lines.push(paint(question.reused ? " 已载入历史记录，本次未发送请求。" : " 尚无模型请求记录。", S.gray));
        } else {
          const latest = question.requests.at(-1);
          if (latest) lines.push(paint(` 推理请求 ${latest.requestedThinkingLevel ?? "未记录"} · 发送 ${latest.sentThinking ?? "未记录参数"} · 回执 ${latest.reportedThinkingLevel ?? "未确认"}`, S.gray));
          lines.push(paint(" 逐题状态 · ↑↓/点击选择 · Enter 查看请求", S.cyan));
          const room = Math.max(1, this.bodyRows - lines.length - 1);
          this.windowedList(lines, telemetry.questions.length, this.scrollTop, room, (index, selected) => {
            const item = telemetry.questions[index]!;
            this.row(lines, selected, `${item.questionId} · ${STATE_LABELS[item.state] ?? item.state}${item.terminationCause ? ` · ${TERMINATION_LABELS[item.terminationCause] ?? item.terminationCause}` : ""}${item.toolName ? ` ${item.toolName}` : ""}${item.reused ? " · 历史记录" : ""}`,
              () => { this.scrollTop = index; this.runExpanded = true; this.menuIndex = 0; });
          }, "题");
        }
        break;
      }
      case "tasks": {
        lines.push(paint(" 历史任务", S.bold, S.yellow) + paint("  (↑↓/点击 查看)", S.gray));
        if (screen.tasks.length === 0) lines.push(paint("   (无)", S.gray));
        this.windowedList(lines, screen.tasks.length, this.menuIndex, Math.max(5, rows - 9), (i, sel) => {
          const t = screen.tasks[i]!;
          const mode = t.mode ? `${t.mode} · ` : "";
          this.row(lines, sel, t.runId, () => {
            this.menuIndex = i;
            return this.tui.openDetail(t.runId);
          }, paint(`${mode}${t.trialCount} 题${t.hasReport ? " · 有报告" : ""}${t.historyIssue ? " · 时间未确认" : ""}`, S.gray));
        }, "条");
        break;
      }
      case "detail": {
        const d = screen.detail;
        lines.push(paint(` 任务记录 ${screen.runId}`, S.bold, S.yellow));
        const selectedMetrics = d.questions[Math.min(this.scrollTop, Math.max(0, d.questions.length - 1))]?.metrics;
        if (selectedMetrics) {
          lines.push(paint(` 指标：${selectedMetrics.requests.length} 请求 · ${seconds(selectedMetrics.elapsedMs)} · 工具 ${selectedMetrics.toolCalls} 次 / 错误 ${selectedMetrics.toolErrors}`, S.gray));
          const last = selectedMetrics.requests.at(-1);
          if (last) lines.push(...requestLines(last).slice(1, 3).map((line) => " " + line));
        } else lines.push(paint(" 所选题目未记录指标（旧答卷保留原样）", S.gray));
        this.windowedList(lines, d.questions.length, this.scrollTop, Math.max(1, this.bodyRows - lines.length - 6), (i) => {
          const q = d.questions[i]!;
          const g = q.grade ? ` · ${q.grade.reviewStatus} ${q.grade.rawScore}/${q.grade.maxScore}` : "";
          lines.push(`   ${paint(q.executionStatus, q.executionStatus === "completed" ? S.green : S.yellow)}  ${q.questionId}${q.terminationCause ? ` · ${TERMINATION_LABELS[q.terminationCause] ?? q.terminationCause}` : ""}${q.truncated ? paint(" (截断)", S.gray) : ""}${g}${q.gradeHistory.length ? paint(` · 历史${q.gradeHistory.length}`, S.gray) : ""}`);
        }, "题");
        this.action(lines, "查看报告 →", () => this.tui.openReport(screen.runId));
        this.action(lines, "人工复核 →", () => this.tui.openReview(screen.runId), S.magenta);
        this.action(lines, "人工样本校准 [k] →", () => this.tui.openCalibration(screen.runId), S.cyan);
        this.action(lines, "异常结果 / 用量核对 [x] →", () => this.tui.openExceptions(screen.runId), S.yellow);
        this.action(lines, "续跑原计划 [v] →", () => this.tui.prepareResume(screen.runId), S.green);
        this.action(lines, "← 返回任务列表", () => this.tui.openTasks());
        break;
      }
      case "exceptions": {
        const item = screen.data.items[screen.index];
        lines.push(paint(` 异常结果 ${screen.index + (item ? 1 : 0)}/${screen.data.items.length} · n/p 换题`, S.bold, S.yellow));
        if (!item) { lines.push(" 无异常或未开始的题。"); break; }
        const q = item.question;
        const budget = screen.data.budget;
        const content = [
          `${item.questionId} · ${STATE_LABELS[q?.executionStatus ?? "queued"] ?? q?.executionStatus}`,
          q?.terminationCause ? TERMINATION_LABELS[q.terminationCause] ?? q.terminationCause : "尚未开始",
          q?.errorMessage ?? "", `决定人 ${screen.by || "未填写"} · 原因 ${screen.reason || "未填写"}`,
          item.recovery ? "可明确补答一次；原请求可能已计费。" : item.blockedReason,
          budget ? `预算 ${budget.knownTokens}/${budget.maxTotalTokens} · 预留 ${budget.reservedTokens} · 未知预留 ${budget.unknownReservedTokens}；u 核对供应商用量` : "原批次未设置 Token 预算。",
          "已有答卷（包括未完成片段）", q?.finalAnswerSheet ?? "无答卷",
          "请求与消耗", ...(q?.metrics ? summaryLines(summarizeRequests(q.metrics.requests)) : ["没有请求指标，不能推断费用为零。"]),
          ...(q?.metrics?.requests.flatMap(requestLines) ?? []),
        ].join("\n\n");
        const body = wrapTextWithAnsi(terminalText(content), this.width);
        const room = Math.max(1, this.bodyRows - lines.length - 2);
        this.scrollTop = Math.min(this.scrollTop, Math.max(0, body.length - room));
        lines.push(...body.slice(this.scrollTop, this.scrollTop + room));
        if (item.recovery) this.action(lines, "明确补答：检查决定摘要 →", () => this.tui.prepareExceptionRecovery(), S.yellow);
        this.action(lines, "保留现有记录，返回 →", () => this.tui.openDetail(screen.runId), S.gray);
        break;
      }
      case "usage": {
        lines.push(paint(" 核对未知用量（不发送模型请求）", S.bold, S.yellow));
        const content = [`请求 ${screen.requestId}`, `Token 总数 ${screen.total ?? "未填写"} · 确认人 ${screen.by || "未填写"}`, `依据 ${screen.reason || "未填写"}`,
          "请依据供应商用量记录填写 input + output 总数，推理和缓存不重复相加。不能把缺失值猜成零。",
          screen.confirming ? "按 y 明确保存。原预留和人工核对依据均保留。" : "填写字段后 Enter 检查确认摘要。"].join("\n\n");
        const body = wrapTextWithAnsi(terminalText(content), this.width);
        const room = Math.max(1, this.bodyRows - lines.length - 1);
        this.scrollTop = Math.min(this.scrollTop, Math.max(0, body.length - room));
        lines.push(...body.slice(this.scrollTop, this.scrollTop + room));
        this.action(lines, screen.confirming ? "✔ 明确保存人工核对用量" : "检查用量确认摘要 →", () => this.tui.confirmUsage(), S.green);
        break;
      }
      case "report": {
        const r = screen.report;
        const t = r.totals;
        lines.push(paint(` ${r.offlineDemo ? "演示成绩" : "成绩"} ${screen.mode}`, S.bold, S.yellow) + paint(`  · run=${screen.runId}`, S.gray));
        lines.push(`   确认得分：${paint(`${t.confirmedRaw} / ${t.confirmedMax}`, S.green, S.bold)}   (计划满分 ${paint(String(t.plannedMax), S.cyan)})`);
        lines.push(...coverageLines(r.coverage).flatMap((line) => wrapTextWithAnsi("   " + line, this.width)).map((line) => paint(line, S.gray)));
        if (r.metrics) {
          lines.push(paint(` 指标覆盖 ${r.metrics.recordedTrials}/${r.metrics.totalTrials} 题（包含复用答卷历史消耗）`, S.gray));
          lines.push(...summaryLines(r.metrics.summary).slice(0, 3).map((line) => " " + line));
        }
        const breakdown = [
          ...Object.entries(r.bySubject).map(([k, b]) => `   学科 ${k}: ${b.raw}/${b.max} (计 ${b.counted})`),
          ...Object.entries(r.byAnswerKind).map(([k, b]) => `   题型 ${k}: ${b.raw}/${b.max} (计 ${b.counted})`),
        ];
        this.windowedList(lines, breakdown.length, this.scrollTop, Math.max(1, this.bodyRows - lines.length - 2), (i) => lines.push(breakdown[i]!), "项");
        this.action(lines, "← 返回", () => this.tui.gotoDatasets());
        break;
      }
      case "review": {
        const items = screen.items;
        lines.push(paint(` ${screen.calibrationParent ? "校准人工核对" : "人工复核"} ${screen.mode} · ${items.length} 待复核`, S.bold, S.yellow));
        if (message) lines.push(truncateToWidth(paint("   " + message, S.yellow), this.width));
        if (items.length === 0) lines.push(paint("   (无待复核：已全部确认或仍由规则/模型处理)", S.green));
        const cur = items[screen.index];
        if (cur) {
          lines.push(truncateToWidth(`   ${screen.index + 1}/${items.length} ${cur.questionId} · ${cur.reviewStatus}${cur.truncated ? " · 答卷截断，请核对" : ""}`, this.width));
          lines.push(`   分数 ${screen.score ?? "未填写"}/${cur.scoring?.maxScore ?? "?"} · 确认人 ${truncateToWidth(screen.confirmer || "未填写", 20)}`);
          lines.push(truncateToWidth(`   复核依据：${screen.reason || "未填写"}`, this.width));
          let content: string;
          if (screen.confirming) {
            content = `确认保存\n题目 ${cur.questionId}\n模式 ${screen.mode}\n分数 ${screen.score}/${cur.scoring?.maxScore}\n确认人 ${screen.confirmer}\n复核依据 ${screen.reason}\n本次确认总分，未逐项重新评分；原分项保留在评分历史中。\n保存后记录为 human_confirmed，并保留原评分历史。\n按 y 保存；esc 返回修改。`;
          } else if (this.reviewTab === "question") {
            const q = cur.question;
            content = q ? ["完整题面", q.stem, ...Object.entries(q.options ?? {}).map(([label, text]) => `${label}. ${text}`), ...(q.parts ?? []).map((part) => `${part.label} ${part.prompt}`), ...q.assets.map((asset) => `附件 ${asset.ref}${asset.alt ? ` · ${asset.alt}` : ""}`)].join("\n\n") : "当前题面不可用，请重新打开队列。";
          } else if (this.reviewTab === "answer") {
            content = `完整答卷\n\n${cur.answerSheet ?? "无答卷"}`;
          } else {
            const scoring = cur.scoring;
            const reference = typeof scoring?.reference === "string" ? scoring.reference : Object.entries(scoring?.reference ?? {}).map(([key, value]) => `${key}: ${value}`).join("\n");
            content = ["完整评分依据", `评分版本 ${scoring?.scoringVersion ?? "未知"} · 满分 ${scoring?.maxScore ?? "未知"}`,
              `参考答案\n${reference || "未提供"}`,
              ...(scoring?.rubric ?? []).map((item, i) => `评分项 ${i + 1}${item.partLabel ? ` · ${item.partLabel}` : ""} · ${item.points} 分\n${item.evidence ?? ""}\n接受的其他答案：${item.acceptAlternatives.join("；") || "未提供"}`),
              `接受的其他答案：${scoring?.acceptableAlternatives.join("；") || "未提供"}`,
              `单位：${scoring?.units.join("、") || "未提供"} · 容差：${scoring?.tolerance ?? "未提供"}`,
              `复核条件：${scoring?.reviewConditions ?? "未提供"}`,
              "已有评分及证据", cur.currentGrade ? `${cur.currentGrade.rawScore}/${cur.currentGrade.maxScore} · ${cur.currentGrade.reviewStatus}` : "未评分",
              ...(cur.currentGrade?.reviewReason ? [`待复核原因：${cur.currentGrade.reviewReason}`] : []),
              ...(cur.currentGrade?.items ?? []).map((item) => `${item.points} 分\n${item.evidence ?? ""}\n${item.note ?? ""}`),
            ].join("\n\n");
          }
          const body = wrapTextWithAnsi(content, Math.max(10, this.width - 3));
          // 正文之外保留阅读状态和确认按钮，不能让外层裁剪吞掉保存入口。
          const size = Math.max(1, this.bodyRows - lines.length - 2);
          this.scrollTop = Math.min(this.scrollTop, Math.max(0, body.length - size));
          for (const line of body.slice(this.scrollTop, this.scrollTop + size)) lines.push("   " + line);
          lines.push(paint(`   阅读 ${this.scrollTop + 1}–${Math.min(body.length, this.scrollTop + size)}/${body.length} 行`, S.gray));
        }
        if (items.length > 0) this.action(lines, screen.confirming ? "✔ 明确确认保存" : "检查评分摘要 →", () => screen.confirming ? this.tui.submitReview() : this.tui.prepareReview(), S.green);
        break;
      }
    }
  }

  /** 题库 (Next_Plan §4): confirmed datasets + staged drafts + import action. */
  private renderBank(lines: string[], screen: Extract<Screen, { kind: "bank" }>, rows: number): void {
    const items = this.bankItems(screen);
    lines.push(paint(" 题库", S.bold, S.yellow) + paint(`  (${screen.datasets.length} 题集 · ${screen.drafts.length} 草稿 · ↑↓/点击 · enter 打开)`, S.gray));
    if (items.length === 0) lines.push(paint("   (空题库：用下方“导入新题集”从外部材料创建)", S.gray));
    this.windowedList(lines, items.length, this.menuIndex, Math.max(5, rows - 10), (i, sel) => {
      const it = items[i]!;
      this.row(lines, sel, it.label, () => {
        this.menuIndex = i;
        return it.kind === "dataset" ? this.tui.checkDataset(it.id) : this.tui.previewDraft(it.id);
      }, paint(it.extra, it.kind === "dataset" ? S.gray : S.yellow));
    }, "项");
    lines.push("");
    this.action(lines, "导入新题集… (选择文件/文件夹)", () => this.editImportPath(), S.magenta);
    this.action(lines, "← 返回首页", () => this.tui.gotoHome());
  }

  /** 导入预览 (Next_Plan §3): review the staged draft, then confirm or discard. */
  private renderImportPreview(lines: string[], screen: Extract<Screen, { kind: "importPreview" }>, rows: number): void {
    const d = screen.draft;
    const check = this.tui.getImporter().check(d.draftId);
    lines.push(paint(" 导入预览", S.bold, S.yellow) + paint(`  ${d.datasetId} · ${d.format} · ${d.questions.length} 题`, S.gray));
    lines.push(`   来源：${truncateToWidth(d.source, Math.max(10, this.width - 12))}`);
    this.windowedList(lines, d.questions.length, this.scrollTop, Math.max(3, rows - 15), (i, selected) => {
      const q = d.questions[i]!;
      const scored = q.scoring ? paint("有评分", S.green) : paint("未评分", S.yellow);
      this.row(lines, selected, q.id, () => this.tui.openDraftQuestion(d.draftId, i), `${q.answerKind} ${scored} ${paint(truncateToWidth(q.stem.replace(/\s+/g, " "), 40), S.gray)}`);
    }, "题");
    if (!check.ok) {
      lines.push(paint("   校验未通过，不能入库：", S.red));
      for (const issue of [...check.issues, ...check.questions.flatMap((q) => q.issues.map((issue) => `${q.questionId}: ${issue}`))].slice(0, 3)) lines.push(truncateToWidth("     " + issue, this.width));
    }
    if (check.warnings.length) lines.push(paint(`   ${check.warnings.length} 条未评分提示：可入库并收集答卷。`, S.yellow));
    lines.push("");
    this.action(lines, "逐题核对与编辑 [v]", () => this.tui.openDraftQuestion(d.draftId, Math.min(this.scrollTop, d.questions.length - 1)), S.cyan);
    this.action(lines, "✔ 确认入库", () => this.tui.confirmImport(), S.green);
    this.action(lines, "归档草稿（保留文件）", () => this.tui.discardImport(), S.yellow);
  }

  private renderDraftQuestion(lines: string[], screen: Extract<Screen, { kind: "draftQuestion" }>): void {
    const r = screen.review;
    const q = r.draft.questions[r.index]!;
    lines.push(paint(terminalText(` ${q.id} · ${r.index + 1}/${r.draft.questions.length} · ${q.subject} · ${q.answerKind}`), S.bold, S.yellow));
    if (this.draftEditor) {
      const label = this.draftEditor.field === "stem" ? "题干（Markdown 原文）" : this.draftEditor.field === "metadata" ? "公开元数据（JSON，不含评分）" : "私有评分依据（JSON；null 表示未提供）";
      lines.push(paint(` 编辑 ${label} · 未保存内容不会进入题库`, S.cyan));
      lines.push(...this.draftEditor.component.render(this.width));
      return;
    }
    const tabs = { compare: "对照", source: "完整原文", model: "模型输入", scoring: "私有评分", issues: "校验问题" } as const;
    lines.push(Object.entries(tabs).map(([key, label]) => paint(` ${label} `, ...(key === screen.tab ? [S.white, S.rev] : [S.gray]))).join(" · "));
    const clean = terminalText;
    const original = r.sourceError ? `无法核对原文：${r.sourceError}` : r.sourceText;
    const available = Math.max(1, this.bodyRows - lines.length - 1);
    if (screen.tab === "compare" && this.width >= 112) {
      const half = Math.floor((this.width - 3) / 2);
      const left = wrapTextWithAnsi(clean(`原文（完整来源文件，仅供核对）\n${original}`), half);
      const right = wrapTextWithAnsi(clean(`模型实际文本输入（图片另行原样提供）\n${r.modelText}`), half);
      const count = Math.max(left.length, right.length);
      const start = Math.min(this.scrollTop, Math.max(0, count - available));
      for (let i = start; i < Math.min(count, start + available); i++) {
        const a = left[i] ?? "";
        lines.push(a + " ".repeat(Math.max(0, half - visibleWidth(a))) + paint(" │ ", S.gray) + (right[i] ?? ""));
      }
      lines.push(paint(` 行 ${start + 1}–${Math.min(count, start + available)}/${count} · e 题干 / f 元数据 / s 评分 / i 图片`, S.gray));
      return;
    }
    if (screen.tab === "compare" && available >= 4) {
      const first = Math.max(1, Math.floor((available - 2) / 2));
      const second = Math.max(1, available - first - 2);
      const source = wrapTextWithAnsi(clean(original), this.width);
      const model = wrapTextWithAnsi(clean(r.modelText), this.width);
      const a = Math.min(this.scrollTop, Math.max(0, source.length - first));
      const b = Math.min(this.scrollTop, Math.max(0, model.length - second));
      lines.push(paint(" 原文（完整文件；Tab 单独查看）", S.gray), ...source.slice(a, a + first));
      lines.push(paint(" 模型实际文本输入（图片另附）", S.cyan), ...model.slice(b, b + second));
      lines.push(paint(` 原文 ${a + 1}/${source.length} · 模型 ${b + 1}/${model.length} · ↑↓ 滚动 · Tab 全文`, S.gray));
      return;
    }
    const text = screen.tab === "source" ? `原文（完整来源文件，仅供核对）\n${original}` : screen.tab === "scoring" ? `私有评分：不会提供给作答模型\n${r.scoringText}` : screen.tab === "issues" ? JSON.stringify({ sourceError: r.sourceError, ...r.check }, null, 2)
      : screen.tab === "compare" ? `原文（完整文件；Tab 可单独查看）\n${original}\n\n──── 模型实际文本输入 ────\n${r.modelText}` : r.modelText;
    const body = wrapTextWithAnsi(clean(text), Math.max(1, this.width));
    const start = Math.min(this.scrollTop, Math.max(0, body.length - available));
    lines.push(...body.slice(start, start + available));
    lines.push(paint(` 行 ${start + 1}–${Math.min(body.length, start + available)}/${body.length} · 图片 ${q.assets?.length ?? 0} · ${r.check.ok ? "可校验入库" : "有问题待修正"}`, S.gray));
  }

  /** 首页只保留品牌、真实状态和命令提示；输入栏负责键盘导航。 */
  private homeLayout(screen: Extract<Screen, { kind: "home" }>, width: number, rows: number): HomeLayout {
    const artWidth = width >= 132 && rows >= 32 ? 64 : width >= 111 && rows >= 24 ? 48 : 0;
    const gap = artWidth ? 6 : 0;
    const contentWidth = Math.min(width - 4, artWidth + gap + 58);
    const inset = Math.max(2, Math.floor((width - contentWidth) / 2));
    const rightWidth = Math.max(1, contentWidth - artWidth - gap);
    const brandWidth = rows < 14 ? Math.min(24, rightWidth) : rightWidth;
    const emphasizedBrand = rows >= 24 && brandWidth >= 58;
    const brand = renderWordmark(brandWidth, 1, emphasizedBrand);
    const message = this.tui.getState().message;
    const detailRows = [
      paint(SLOGAN, S.cyan),
      "",
      paint(message || (this.tui.demoSource ? OFFLINE_DEMO_LABEL : "多学科模型测评"), message || this.tui.demoSource ? S.yellow : S.gray),
      paint("without tool  /  with tool", S.gray),
      `题集 ${paint(String(screen.datasets.length), S.white)} 个  ·  最近任务待复核 ${paint(String(screen.pendingReview), S.white)}`,
      screen.datasets[0] ? paint(screen.datasets[0].id, S.gray) : paint(this.tui.demoSource ? "/import 导入随附示例" : "导入题目，开始第一次测评", S.gray),
    ];
    const contentRows = Math.max(artWidth / 2, brand.lines.length + 1 + detailRows.length);
    const top = Math.max(0, Math.min(3, Math.floor((rows - contentRows) / 2), rows - 5 - brand.lines.length - 1 - detailRows.length));
    const brandX = inset + artWidth + gap;
    const detailTop = top + brand.lines.length + 1;
    const details: string[] = Array.from({ length: top + contentRows }, () => "");
    this.place(details, detailRows.map((line) => truncateToWidth(line, rightWidth)), brandX, detailTop);
    return {
      size: artWidth, artX: inset, artY: top, brandX, brandY: top, brandWidth, emphasizedBrand, brand, details,
    };
  }

  private renderHome(lines: string[], screen: Extract<Screen, { kind: "home" }>): void {
    const layout = this.homeLayout(screen, this.width, this.bodyRows);
    const content = [...layout.details];
    if (layout.size) this.place(content, renderMascotDisplay(layout.size, layout.size / 2, "idle", "orange", "entrance"), layout.artX, layout.artY);
    this.place(content, layout.brand.lines, layout.brandX, layout.brandY);
    lines.push(...content);
  }

  private renderSettings(lines: string[], screen: Extract<Screen, { kind: "settings" }>): void {
    lines.push(paint(" 设置", S.bold, S.yellow));
    lines.push(`   吉祥物动画：${screen.animation ? paint("开", S.green, S.bold) : paint("关", S.gray)}   ${paint("[enter/空格 切换]", S.gray)}`);
    lines.push(paint("   动画开关用于当前会话，重启后使用启动配置。", S.gray));
    lines.push("");
    if (!this.tui.demoSource) this.action(lines, "搜索与搜题模型配置", () => { this.tui.openCollection(); this.tui.getCollectionWorkspace().page = "settings"; });
    this.action(lines, "← 返回首页", () => this.tui.gotoHome());
  }

  private eventLine(e: import("../runner/task-events.js").TaskEvent): string {
    switch (e.type) {
      case "question_running":
        return paint("▶", S.blue) + ` ${e.questionId} (${e.index + 1}/${e.total})${e.withImages ? paint(" +图", S.magenta) : ""}`;
      case "question_done":
        return paint("✔", S.green) + ` ${e.questionId} ${e.executionStatus}${e.gradingStatus ? ` · ${e.gradingStatus} ${e.rawScore}/${e.maxScore}` : ""}${e.archiveError ? paint(" · 存档失败", S.red) : ""}`;
      case "question_loaded":
        return paint("↺", S.cyan) + ` ${e.questionId} ${e.note}`;
      case "stopped":
        return paint("■ 已停止: " + e.reason, S.red);
      case "mode_done":
        return paint(`■ 模式完成 ${e.confirmedRaw}/${e.confirmedMax}`, S.green, S.bold);
      case "task_done":
        return paint("■ 任务完成", S.green, S.bold);
      case "warning":
        return paint("! " + e.message, S.yellow);
      case "error":
        return paint("✗ " + e.message, S.red);
      default:
        return e.type;
    }
  }

  // ── keyboard ─────────────────────────────────────────────────────────────
  handleInput(data: string): void {
    // 跳过页面动效时仍将按键交给当前页面处理。
    this.clearPageMotion();
    if (KEYDEBUG && !["collection", "chat", "home"].includes(this.tui.getState().screen.kind)) {
      this.keyLog.push(JSON.stringify(data));
      if (this.keyLog.length > 8) this.keyLog.shift();
    }
    const screen = this.tui.getState().screen;
    const isEnter = matchesKey(data, Key.enter) || matchesKey(data, Key.return) || data === "\r" || data === "\n";
    if (matchesKey(data, Key.ctrl("c")) || (!this.fieldInput && !this.draftEditor && !this.commands.active && screen.kind !== "home" && screen.kind !== "collection" && screen.kind !== "chat" && matchesKey(data, "q"))) {
      void this.quit();
      return;
    }
    // 退出键优先处理，其余开场按键跳过动画。
    if (screen.kind === "opening") {
      this.finishOpening();
      return;
    }
    if (this.draftEditor) {
      if (this.pending || this.quitting) return;
      const edit = this.draftEditor;
      if (matchesKey(data, Key.escape)) { this.draftEditor = undefined; return; }
      if (matchesKey(data, Key.ctrl("s"))) {
        this.perform(() => {
          this.tui.saveDraftQuestion(edit.field, edit.component.getExpandedText());
          this.draftEditor = undefined;
          this.scrollTop = 0;
        });
      } else if (isEnter) edit.component.insertTextAtCursor("\n");
      else edit.component.handleInput(data);
      return;
    }
    if (this.fieldInput && !matchesKey(data, Key.ctrl("c"))) {
      this.fieldInput.handleInput(data);
      return;
    }
    if (this.pending || this.quitting) return;
    if (this.commands.active) {
      this.commands.handleInput(data);
      return;
    }
    if (screen.kind === "collection") {
      const pane = this.collectionPane();
      if (this.keyChar(data) === "/" && pane.canOpenCommands()) this.commands.open();
      else pane.handleInput(data);
      return;
    }
    if (screen.kind === "chat") {
      const pane = this.chatPane();
      if (this.keyChar(data) === "/" && pane.canOpenCommands()) this.commands.open();
      else pane.handleInput(data);
      return;
    }
    if (this.keyChar(data) === "/") {
      this.commands.open();
      return;
    }
    if (screen.kind === "home" && !matchesKey(data, Key.escape)) {
      this.commands.handleInput(data);
      return;
    }
    if (matchesKey(data, "q")) {
      void this.quit();
      return;
    }
    if (screen.kind === "review") {
      if (screen.confirming) {
        if (matchesKey(data, "y")) this.perform(() => this.tui.submitReview());
        else if (matchesKey(data, Key.escape)) { this.tui.cancelReviewConfirmation(); this.scrollTop = 0; }
        else if (matchesKey(data, Key.up)) this.scrollTop = Math.max(0, this.scrollTop - 1);
        else if (matchesKey(data, Key.down)) this.scrollTop++;
        return;
      }
      const ch = this.keyChar(data);
      if (screen.calibrationParent && ch === "m") { this.tui.setMessage("人工校准核对期间不能切换作答模式，请先返回校准列表。"); return; }
      if (ch === "j") { this.perform(() => this.tui.prepareJudge()); this.scrollTop = 0; return; }
      if (ch === "i") { this.perform(() => this.tui.openReviewImage()); return; }
      if (["1", "2", "3"].includes(ch)) {
        this.reviewTab = ch === "1" ? "question" : ch === "2" ? "answer" : "scoring";
        this.scrollTop = 0;
        return;
      }
      if (ch === "n" || ch === "p") {
        this.tui.highlightReview(screen.index + (ch === "n" ? 1 : -1));
        this.scrollTop = 0;
        return;
      }
      if (ch === "s" || ch === "c" || ch === "e") {
        this.editReviewField(ch === "s" ? "score" : ch === "c" ? "confirmer" : "reason");
        return;
      }
    }
    // Esc 只返回；归档也保留原文件。
    if (screen.kind === "importPreview") {
      if (this.keyChar(data) === "v") {
        this.perform(() => this.tui.openDraftQuestion(screen.draft.draftId, Math.min(this.scrollTop, screen.draft.questions.length - 1)));
        return;
      }
      if (isEnter) {
        this.perform(() => this.tui.confirmImport());
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.tui.closeImportPreview();
        return;
      }
      if (this.keyChar(data) === "d") {
        this.perform(() => this.tui.discardImport());
        return;
      }
    }
    if (screen.kind === "draftQuestion") {
      const r = screen.review;
      const key = this.keyChar(data);
      if (matchesKey(data, Key.escape)) { this.tui.previewDraft(r.draft.draftId); this.scrollTop = 0; return; }
      if (matchesKey(data, Key.tab)) {
        const tabs = ["compare", "source", "model", "scoring", "issues"] as const;
        this.tui.setDraftTab(tabs[(tabs.indexOf(screen.tab) + 1) % tabs.length]!);
        this.scrollTop = 0;
        return;
      }
      if (key === "n" || key === "p") {
        this.perform(() => this.tui.openDraftQuestion(r.draft.draftId, Math.max(0, Math.min(r.draft.questions.length - 1, r.index + (key === "n" ? 1 : -1)))));
        this.scrollTop = 0;
        return;
      }
      if (key === "e" || key === "f" || key === "s") {
        this.editDraftQuestion(key === "e" ? "stem" : key === "f" ? "metadata" : "scoring");
        return;
      }
      if (key === "i") { this.perform(() => this.tui.openDraftImage(r.draft.draftId, r.index)); return; }
    }
    if (screen.kind === "draftImage") {
      if (matchesKey(data, Key.escape)) { this.tui.openDraftQuestion(screen.review.draft.draftId, screen.review.index); return; }
      const key = this.keyChar(data);
      if (key === "o") { this.perform(() => this.tui.openOriginalImage()); return; }
      if (key === "n" || key === "p") { this.perform(() => this.tui.nextDraftImage(key === "n" ? 1 : -1)); return; }
    }
    if (screen.kind === "reviewImage") {
      if (matchesKey(data, Key.escape)) { this.tui.closeReviewImage(); return; }
      const key = this.keyChar(data);
      if (key === "o") { this.perform(() => this.tui.openOriginalImage()); return; }
      if (key === "n" || key === "p") { this.perform(() => this.tui.nextReviewImage(key === "n" ? 1 : -1)); return; }
      // 图片页仅响应已列出的操作，不能进入评分页的通用确认流程。
      return;
    }
    if (screen.kind === "exceptions" || screen.kind === "usage") {
      const key = this.keyChar(data);
      if (matchesKey(data, Key.escape)) { this.perform(() => screen.kind === "usage" ? this.tui.openExceptions(screen.runId) : this.tui.openDetail(screen.runId)); return; }
      if (screen.kind === "exceptions" && (key === "n" || key === "p")) { this.tui.selectException(key === "n" ? 1 : -1); this.scrollTop = 0; return; }
      if (key === "c" || key === "e" || (screen.kind === "usage" && key === "s" && !screen.confirming)) {
        this.editExceptionField(key === "c" ? "by" : key === "e" ? "reason" : "total"); return;
      }
      if (screen.kind === "exceptions" && key === "u") { this.perform(() => this.tui.openUsageReconciliation()); return; }
      if (isEnter) { this.perform(() => screen.kind === "exceptions" ? this.tui.prepareExceptionRecovery() : screen.confirming ? undefined : this.tui.confirmUsage()); return; }
      if (screen.kind === "usage" && screen.confirming && key === "y") { this.perform(() => this.tui.confirmUsage()); return; }
      if (matchesKey(data, Key.up)) this.scrollTop = Math.max(0, this.scrollTop - 1);
      if (matchesKey(data, Key.down)) this.scrollTop++;
      return;
    }
    if (screen.kind === "judge") {
      const key = this.keyChar(data);
      if (matchesKey(data, Key.escape)) { this.perform(() => this.tui.backJudge()); return; }
      if (isEnter) { this.perform(() => screen.stage === "config" ? this.tui.saveJudge() : this.tui.chooseJudge()); return; }
      if (screen.stage !== "config" && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) { this.tui.moveJudgeChoice(matchesKey(data, Key.up) ? -1 : 1); return; }
      if (screen.stage === "config") {
        if (key === "m") { this.tui.judgePicker(); return; }
        if (key === "t") { this.perform(() => this.tui.cycleJudgeThinking()); return; }
        if (["b", "o", "r", "d"].includes(key)) { this.editJudgeField(key === "b" ? "budget" : key === "o" ? "output" : key === "r" ? "timeout" : "deadline"); return; }
      }
      if (matchesKey(data, Key.up)) this.scrollTop = Math.max(0, this.scrollTop - 1);
      if (matchesKey(data, Key.down)) this.scrollTop++;
      return;
    }
    if (screen.kind === "judgeConfirm") {
      if (matchesKey(data, Key.escape)) { this.tui.cancelJudgePlan(); this.scrollTop = 0; return; }
      if (isEnter) { this.perform(() => this.onJudgeStart()); return; }
      if (matchesKey(data, Key.up)) this.scrollTop = Math.max(0, this.scrollTop - 1);
      if (matchesKey(data, Key.down)) this.scrollTop++;
      return;
    }
    if (screen.kind === "judgeRun") {
      if (this.keyChar(data) === "s") { this.tui.getJudgeService().stop(screen.jobId); return; }
      if (isEnter || matchesKey(data, Key.escape)) { this.perform(() => this.tui.finishJudge()); return; }
      if (matchesKey(data, Key.up)) this.scrollTop = Math.max(0, this.scrollTop - 1);
      if (matchesKey(data, Key.down)) this.scrollTop++;
      return;
    }
    if (screen.kind === "calibration") {
      const key = this.keyChar(data);
      if (screen.confirming) {
        if (key === "y") this.perform(() => this.tui.confirmCalibration());
        else if (matchesKey(data, Key.escape)) { this.tui.cancelCalibrationConfirmation(); this.scrollTop = 0; }
        else if (matchesKey(data, Key.up)) this.scrollTop = Math.max(0, this.scrollTop - 1);
        else if (matchesKey(data, Key.down)) this.scrollTop++;
        return;
      }
      if (matchesKey(data, Key.escape)) { this.perform(() => this.tui.openDetail(screen.runId)); return; }
      if (key === "n" || key === "p") { this.tui.selectCalibration(key === "n" ? 1 : -1); this.scrollTop = 0; return; }
      if (key === " " || isEnter) { this.perform(() => this.tui.selectCalibration(0, true)); return; }
      if (key === "j") { this.perform(() => this.tui.prepareJudge()); this.scrollTop = 0; return; }
      if (key === "a") { this.perform(() => this.tui.confirmCalibration()); this.scrollTop = 0; return; }
      if (key === "v") { this.perform(() => this.tui.loadCalibrationReport()); this.scrollTop = 0; return; }
      if (key === "f") { this.perform(() => this.tui.openCalibrationSample()); this.scrollTop = 0; return; }
      if (key === "r") { this.perform(() => this.tui.openCalibrationReview()); this.scrollTop = 0; return; }
      if (key === "c" || key === "e") { this.editCalibrationField(key === "c" ? "by" : "reason"); return; }
      if (matchesKey(data, Key.up)) this.scrollTop = Math.max(0, this.scrollTop - 1);
      if (matchesKey(data, Key.down)) this.scrollTop++;
      return;
    }
    if (screen.kind === "calibrationSample") {
      const key = this.keyChar(data);
      if (matchesKey(data, Key.escape)) { this.tui.closeCalibrationSample(); this.scrollTop = 0; return; }
      if (screen.image && (key === "n" || key === "p")) { this.perform(() => this.tui.openCalibrationImage(key === "n" ? 1 : -1)); return; }
      if (key === "i") { this.perform(() => this.tui.openCalibrationImage()); return; }
      if (["1", "2", "3", "4"].includes(key)) { this.tui.setCalibrationTab(key === "1" ? "question" : key === "2" ? "answer" : key === "3" ? "basis" : "comparison"); this.scrollTop = 0; return; }
      if (matchesKey(data, Key.up)) this.scrollTop = Math.max(0, this.scrollTop - 1);
      if (matchesKey(data, Key.down)) this.scrollTop++;
      return;
    }
    // Settings: toggle animation / back.
    if (screen.kind === "settings") {
      if (isEnter || this.keyChar(data) === " ") {
        this.tui.toggleAnimation();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.perform(() => this.tui.gotoHome());
        return;
      }
    }
    // Bank: import shortcut.
    if (screen.kind === "run") {
      if (this.keyChar(data) === "s") { this.tui.stop(); return; }
      if (matchesKey(data, Key.escape) && this.runExpanded) { this.runExpanded = false; this.menuIndex = 0; return; }
      if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
        const step = matchesKey(data, Key.up) ? -1 : 1;
        if (this.runExpanded) this.menuIndex = Math.max(0, this.menuIndex + step);
        else this.scrollTop = Math.max(0, this.scrollTop + step);
        return;
      }
    }
    if (screen.kind === "bank" && this.keyChar(data) === "i") {
      this.editImportPath();
      return;
    }
    if (matchesKey(data, "h")) {
      this.menuIndex = 0;
      this.perform(() => this.tui.openTasks());
      return;
    }
    if (matchesKey(data, "r")) {
      this.tui.openCurrentTask();
      return;
    }
    if (matchesKey(data, Key.up)) {
      if (screen.kind === "datasets" || screen.kind === "tasks" || screen.kind === "bank") this.menuIndex = Math.max(0, this.menuIndex - 1);
      else if (screen.kind === "setup") this.tui.highlightProvider(screen.providerIndex - 1);
      else if (screen.kind === "pickmodel") this.tui.highlightModel(screen.modelIndex - 1);
      else this.scrollTop = Math.max(0, this.scrollTop - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (screen.kind === "bank") {
        const n = this.bankItems(screen).length;
        this.menuIndex = Math.min(Math.max(0, n - 1), this.menuIndex + 1);
      } else if (screen.kind === "datasets") this.menuIndex = Math.min(Math.max(0, this.tui.getState().datasets.length - 1), this.menuIndex + 1);
      else if (screen.kind === "tasks") this.menuIndex = Math.min(Math.max(0, screen.tasks.length - 1), this.menuIndex + 1);
      else if (screen.kind === "setup") this.tui.highlightProvider(screen.providerIndex + 1);
      else if (screen.kind === "pickmodel") this.tui.highlightModel(screen.modelIndex + 1);
      else if (screen.kind === "importPreview") this.scrollTop = Math.min(Math.max(0, screen.draft.questions.length - 1), this.scrollTop + 1);
      else this.scrollTop += 1;
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (screen.kind === "pickmodel") this.tui.backToProviders();
      else if (screen.kind === "review") { if (screen.calibrationParent) this.tui.closeCalibrationReview(); else this.perform(() => this.tui.openDetail(screen.runId)); }
      else if (screen.kind === "bank" || screen.kind === "tasks" || screen.kind === "run") this.perform(() => this.tui.gotoHome());
      else if (screen.kind === "detail") this.perform(() => this.tui.openTasks());
      else if (screen.kind === "report") this.perform(() => this.tui.openDetail(screen.runId));
      else if (screen.kind === "confirm") this.perform(() => this.tui.backToModels());
      else if (screen.kind === "setup") this.tui.gotoDatasets();
      else if (screen.kind === "datasets") this.perform(() => this.tui.gotoHome());
      else if (screen.kind === "check") this.tui.gotoDatasets();
      else if (screen.kind === "home") { /* stay */ }
      else this.tui.gotoDatasets();
      this.menuIndex = 0;
      return;
    }
    // P2: report + review are per-mode; switch without_tool/with_tool (the
    // controller resolves each mode's own run dir).
    if ((screen.kind === "report" || screen.kind === "review") && matchesKey(data, "m")) {
      const next: AnswerMode = screen.mode === "without_tool" ? "with_tool" : "without_tool";
      if (screen.kind === "report") this.perform(() => this.tui.openReport(screen.runId, next));
      else this.perform(() => this.tui.openReview(screen.runId, next));
      return;
    }
    if (isEnter) {
      this.perform(() => this.onEnter(screen));
      return;
    }
    // P2: human-review page — adjust the proposed score with +/-.
    if (screen.kind === "review" && (this.keyChar(data) === "+" || this.keyChar(data) === "=")) {
      this.tui.adjustReviewScore(1);
      return;
    }
    if (screen.kind === "review" && this.keyChar(data) === "-") {
      this.tui.adjustReviewScore(-1);
      return;
    }
    if ((screen.kind === "setup" || screen.kind === "pickmodel" || screen.kind === "confirm") && matchesKey(data, "m")) {
      const mode = screen.setup.mode === "without_tool" ? "with_tool" : screen.setup.mode === "with_tool" ? "both" : "without_tool";
      this.tui.adjustSetup({ mode });
      return;
    }
    if (screen.kind === "confirm" && matchesKey(data, "t")) {
      this.perform(() => this.tui.cycleThinking());
      return;
    }
    if (screen.kind === "detail" && matchesKey(data, "v")) {
      this.perform(() => this.tui.prepareResume(screen.runId));
      return;
    }
    if (screen.kind === "detail" && matchesKey(data, "x")) { this.perform(() => this.tui.openExceptions(screen.runId)); return; }
    if (screen.kind === "detail" && matchesKey(data, "k")) { this.perform(() => this.tui.openCalibration(screen.runId)); return; }
    if (screen.kind === "confirm" && !screen.resume && matchesKey(data, "b")) {
      const input = new Input({ prompt: "整批 Token 上限（双模式共享；留空不限制）：" });
      input.focused = true; input.setValue(String(screen.setup.batchTokenLimit ?? ""));
      input.onSubmit = (value) => {
        try { this.tui.setBatchTokenLimit(value); this.fieldInput = undefined; }
        catch (error) { this.tui.setMessage(error instanceof Error ? error.message : String(error)); }
      };
      input.onEscape = () => { this.fieldInput = undefined; };
      this.fieldInput = input; return;
    }
    if ((screen.kind === "setup" || screen.kind === "pickmodel" || screen.kind === "confirm") && (this.keyChar(data) === "+" || this.keyChar(data) === "=")) {
      this.tui.adjustSetup({ concurrency: Math.min(8, screen.setup.concurrency + 1) });
      return;
    }
    if ((screen.kind === "setup" || screen.kind === "pickmodel" || screen.kind === "confirm") && this.keyChar(data) === "-") {
      this.tui.adjustSetup({ concurrency: Math.max(1, screen.setup.concurrency - 1) });
      return;
    }
    if ((screen.kind === "setup" || screen.kind === "pickmodel" || screen.kind === "confirm") && matchesKey(data, "a")) {
      const cur = screen.setup.apiConcurrency;
      const next = cur === undefined ? 1 : cur === 1 ? 2 : undefined;
      this.tui.adjustSetup({ apiConcurrency: next });
      return;
    }
  }

  /** matchesKey cannot express "+" (modifier separator) — decode to a char. */
  private keyChar(data: string): string {
    if (isKittyProtocolActive()) {
      const d = decodeKittyPrintable(data);
      if (d !== undefined) return d;
    }
    return data;
  }

  private editJudgeField(field: "budget" | "output" | "timeout" | "deadline"): void {
    const s = this.tui.getState().screen; if (s.kind !== "judge") return;
    const input = new Input({ prompt: field === "budget" ? "裁判任务 Token 预算：" : field === "output" ? "单次输出 Token 上限：" : field === "timeout" ? "请求/流空闲上限（秒）：" : "整体请求上限（秒）：" });
    const value = field === "budget" ? s.draft.maxTotalTokens : field === "output" ? s.draft.limits.maxOutputTokens : field === "timeout" ? s.draft.limits.requestTimeoutMs / 1000 : s.draft.limits.totalRunTimeMs / 1000;
    input.focused = true; input.setValue(String(value ?? ""));
    input.onSubmit = (value) => {
      try { this.tui.setJudgeField(field, value); this.fieldInput = undefined; }
      catch (error) { this.tui.setMessage(error instanceof Error ? error.message : String(error)); }
    };
    input.onEscape = () => { this.fieldInput = undefined; }; this.fieldInput = input;
  }
  private editCalibrationField(field: "by" | "reason"): void {
    const s = this.tui.getState().screen; if (s.kind !== "calibration") return;
    const input = new Input({ prompt: field === "by" ? "样本检查人：" : "样本检查依据与适用范围：" });
    input.focused = true; input.setValue(s[field]);
    input.onSubmit = (value) => { this.tui.setCalibrationField(field, value); this.fieldInput = undefined; };
    input.onEscape = () => { this.fieldInput = undefined; }; this.fieldInput = input;
  }

  private editExceptionField(field: "by" | "reason" | "total"): void {
    const s = this.tui.getState().screen;
    if (s.kind !== "exceptions" && s.kind !== "usage") return;
    const input = new Input({ prompt: field === "by" ? "确认人：" : field === "reason" ? "原因/供应商核对依据：" : "供应商核对的 input + output 总 Token：" });
    input.focused = true;
    input.setValue(field === "total" ? s.kind === "usage" ? String(s.total ?? "") : "" : s[field]);
    input.onSubmit = (value) => {
      try { this.tui.setExceptionField(field, value); this.fieldInput = undefined; }
      catch (error) { this.tui.setMessage(error instanceof Error ? error.message : String(error)); }
    };
    input.onEscape = () => { this.fieldInput = undefined; };
    this.fieldInput = input;
  }

  private editReviewField(field: "score" | "confirmer" | "reason"): void {
    const screen = this.tui.getState().screen;
    if (screen.kind !== "review" || !screen.items[screen.index]) return;
    const input = new Input({ prompt: field === "score" ? "分数：" : field === "confirmer" ? "确认人：" : "复核依据：" });
    input.focused = true;
    input.setValue(field === "score" ? String(screen.score ?? "") : screen[field]);
    input.onSubmit = (value) => {
      try {
        this.tui.setReviewField(field, value);
        this.fieldInput = undefined;
      } catch (error) {
        this.tui.setMessage(error instanceof Error ? error.message : String(error));
      }
    };
    input.onEscape = () => { this.fieldInput = undefined; };
    this.fieldInput = input;
  }

  private editDraftQuestion(field: DraftEditField): void {
    const s = this.tui.getState().screen;
    if (s.kind !== "draftQuestion") return;
    const value = field === "stem" ? s.review.draft.questions[s.review.index]!.stem : field === "metadata" ? s.review.metadataText : s.review.scoringText;
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
      this.tui.setMessage("内容包含终端控制字符，不能直接编辑；请修正来源文件后重新导入。");
      return;
    }
    const host = new TuiAltScreen(new ProcessTerminal());
    host.requestRender = () => this.rerender?.();
    const color = (text: string) => paint(text, S.cyan);
    const component = new Editor(host, { borderColor: color, selectList: { selectedPrefix: color, selectedText: color, description: color, scrollInfo: color, noMatch: color } });
    component.focused = true;
    component.disableSubmit = true;
    component.setText(value);
    this.draftEditor = { field, component };
  }

  /** Prompt for a source path, then import it into a staged draft. */
  private editImportPath(): void {
    const input = new Input({ prompt: "导入路径(文件/文件夹)：" });
    if (this.tui.demoSource) {
      input.setValue(this.tui.demoSource);
      input.handleInput("\x05");
    }
    input.focused = true;
    input.onSubmit = (value) => {
      this.fieldInput = undefined;
      const path = value.trim();
      if (!path) return;
      const id = new Input({ prompt: "题集标识（小写英文，可留空）：" });
      id.focused = true;
      id.onSubmit = (value) => {
        const datasetId = value.trim() || undefined;
        const version = new Input({ prompt: "题集版本（默认 1）：" });
        version.focused = true;
        version.onSubmit = (value) => {
          this.fieldInput = undefined;
          this.tui.startImport(path, datasetId, value.trim() || "1");
        };
        version.onEscape = () => { this.fieldInput = undefined; };
        this.fieldInput = version;
      };
      id.onEscape = () => { this.fieldInput = undefined; };
      this.fieldInput = id;
    };
    input.onEscape = () => { this.fieldInput = undefined; };
    this.fieldInput = input;
  }

  private async onEnter(screen: Screen): Promise<void> {
    const state = this.tui.getState();
    switch (screen.kind) {
      case "home": this.commands.open(); break;
      case "datasets": {
        const ds = state.datasets[this.menuIndex];
        if (ds) await this.tui.checkDataset(ds.id);
        break;
      }
      case "bank": {
        const it = this.bankItems(screen)[this.menuIndex];
        if (it) {
          if (it.kind === "dataset") await this.tui.checkDataset(it.id);
          else this.tui.previewDraft(it.id);
        }
        break;
      }
      case "check":
        this.tui.openSetup();
        break;
      case "setup":
        this.tui.selectProvider(screen.providerIndex);
        break;
      case "pickmodel":
        this.tui.selectModel(screen.modelIndex);
        break;
      case "confirm":
        this.onStart();
        break;
      case "review":
        this.tui.prepareReview();
        this.scrollTop = 0;
        break;
      case "run":
        this.runExpanded = !this.runExpanded;
        this.menuIndex = 0;
        break;
      case "tasks": {
        const t = screen.tasks[this.menuIndex];
        if (t) await this.tui.openDetail(t.runId);
        break;
      }
      case "detail":
        await this.tui.openReport(screen.runId);
        break;
      default:
        break;
    }
  }

  private onJudgeStart(): void {
    const id = this.tui.startJudge();
    clearInterval(this.runTimer);
    this.scrollTop = 0;
    const timer = setInterval(() => { if (this.tui.getState().screen.kind === "judgeRun") this.rerender?.(); }, 500);
    this.runTimer = timer;
    void this.tui.getJudgeService().whenDone(id).then(() => { clearInterval(timer); if (this.runTimer === timer) this.runTimer = undefined; this.rerender?.(); });
  }

  private onStart(): void {
    const taskId = this.tui.start();
    if (taskId) {
      clearInterval(this.runTimer);
      this.runExpanded = false;
      this.scrollTop = 0;
      const timer = setInterval(() => {
        if (this.tui.getState().screen.kind === "run") this.rerender?.();
      }, 500);
      this.runTimer = timer;
      const unsub = this.tui.getService().subscribe(taskId, (e) => {
        this.tui.onEvent(e);
        this.rerender?.();
      });
      void this.tui.getService().whenDone(taskId).then(() => {
        clearInterval(timer);
        if (this.runTimer === timer) this.runTimer = undefined;
        unsub();
        this.rerender?.();
      });
    }
  }

  // ── mouse ────────────────────────────────────────────────────────────────
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "press" || event.type === "click" || event.type === "wheel") this.clearPageMotion();
    if (this.draftEditor) return { handled: true };
    if (this.fieldInput) return { handled: true };
    if (this.pending || this.quitting) return { handled: true };
    if (event.y >= this.commandTop && event.y < this.commandTop + this.commandHeight && event.x >= this.commandLeft) {
      if (this.tui.getState().screen.kind === "chat" && !this.commands.active && this.chatPane().usesDock) { this.chatPane().focusDock(); return { handled: true }; }
      if (this.tui.getState().screen.kind === "collection" && !this.commands.active && this.collectionPane().usesDock) { this.collectionPane().focusDock(); return { handled: true }; }
      return this.commands.handleMouse({ ...event, x: event.x - this.commandLeft, y: event.y - this.commandTop });
    }
    if (this.commands.active) return { handled: true };
    if (this.tui.getState().screen.kind === "chat") return this.chatPane().handleMouse({ ...event, x: event.x - this.collectionLeft, y: event.y - this.collectionTop });
    if (this.tui.getState().screen.kind === "collection") return this.collectionPane().handleMouse({ ...event, x: event.x - this.collectionLeft, y: event.y - this.collectionTop });
    if (event.type === "wheel" && this.tui.getState().screen.kind === "review") {
      this.scrollTop = Math.max(0, this.scrollTop + (event.wheelDelta ?? 0));
      return { handled: true };
    }
    if (event.type !== "click" && event.type !== "press") return undefined;
    if (event.button !== "left") return undefined;
    const zone = this.hot.find((h) => h.y === event.y && event.x >= (h.x0 ?? 0) && event.x < (h.x1 ?? this.width));
    if (zone) {
      // Pi 会依次派发 press、release 和 click；只在 click 执行，避免一次手势触发两次动作。
      if (event.type === "click") zone.run();
      return { handled: true };
    }
    return undefined;
  }

  rerender?: () => void;
}

export async function runExamTui(cfg: ExamTuiConfig): Promise<void> {
  await prepareMascotImage();
  const terminal = new ProcessTerminal();
  const alt = new TuiAltScreen(terminal);
  const tui = new ExamTui(cfg);
  tui.loadDatasets();
  const app = new ExamApp(tui);
  app.rerender = () => alt.requestRender();
  app.setQuitHandler(async () => {
    app.dispose();
    await stopExamTerminal(alt);
  });
  alt.setLayoutRoot(app);
  // Idiomatic pi-tui: focusing the root routes keys to app.handleInput and
  // auto-repaints afterwards. (No addInputListener — consuming there skips the
  // auto-repaint and made every state change invisible.)
  alt.setFocus(app);
  // Next_Plan §1/§2: play the intro (or go straight home if animation is off).
  try {
    await tui.begin();
    alt.start();
    if (tui.animationEnabled()) app.startOpening();
  } catch (error) {
    app.dispose();
    await stopExamTerminal(alt);
    throw error;
  }
}
