import { Input, Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

export const COMMANDS = [
  { name: "run", description: "创建测评 · 选择题集与模型" },
  { name: "collect", description: "对话搜题 · 联网检索与组卷" },
  { name: "import", description: "导入题目 · 文件或文件夹" },
  { name: "bank", description: "题库 · 已确认题集与草稿" },
  { name: "tasks", description: "历史任务 · 查看与继续" },
  { name: "chat", description: "普通对话 · 连续交流与聊天历史" },
  { name: "model", description: "选择对话模型 · 保留原会话用量" },
  { name: "results", description: "成绩 · 两种模式分别展示" },
  { name: "review", description: "人工复核 · 检查待评分答卷" },
  { name: "judge", description: "独立裁判 · 模型、推理与预算" },
  { name: "current", description: "返回当前会话的任务" },
  { name: "settings", description: "设置 · 吉祥物动画" },
  { name: "home", description: "返回首页" },
  { name: "help", description: "查看全部命令" },
  { name: "quit", description: "停止任务并退出" },
] as const;

export type CommandName = typeof COMMANDS[number]["name"];
const muted = (text: string) => `\x1b[38;2;137;170;174m${text}\x1b[0m`;
const accent = (text: string) => `\x1b[38;2;111;211;204m${text}\x1b[0m`;

/** 命令仅由调用方分派到已存在的界面操作，不执行 Shell 或模型请求。 */
export class CommandBar {
  private readonly input = new Input({ prompt: accent(" › "), placeholder: "输入消息，或 / 查看命令", placeholderStyle: muted });
  private opened = false;
  private selected = 0;
  private error = "";
  private suggestionRows = new Map<number, CommandName>();
  private inputRow = 0;
  onExecute?: (command: CommandName) => void;
  onText?: (text: string) => void;

  constructor() {
    this.input.onSubmit = () => this.submit();
    this.input.onEscape = () => this.close();
  }

  get active(): boolean { return this.opened; }
  get menuVisible(): boolean { return this.opened && this.value.startsWith("/"); }
  get value(): string { return this.input.getValue(); }

  open(value = "/"): void {
    this.opened = true;
    this.input.setValue(value);
    // Pi Input.setValue 保留原光标；预填斜杠或补全文本后需要移到末尾。
    this.input.handleInput("\x05");
    this.selected = 0;
    this.error = "";
  }

  close(): void {
    this.opened = false;
    this.input.setValue("");
    this.selected = 0;
    this.error = "";
    this.suggestionRows.clear();
  }

  private matches() {
    const value = this.value.trim();
    if (!value.startsWith("/")) return [];
    return COMMANDS.filter((command) => `/${command.name}`.startsWith(value.toLowerCase()));
  }

  private execute(command: CommandName): void {
    this.close();
    this.onExecute?.(command);
  }

  private submit(): void {
    if (!this.value.trim()) { this.open(); return; }
    if (!this.value.trim().startsWith("/") && this.onText) { const text = this.value.trim(); this.close(); this.onText(text); return; }
    const candidates = this.matches();
    const exact = candidates.find((command) => `/${command.name}` === this.value.trim().toLowerCase());
    const selected = exact ?? candidates[this.selected];
    if (selected) this.execute(selected.name);
    else this.error = "无法识别命令。输入 / 查看列表；这些命令不接受额外参数。";
  }

  handleInput(data: string): void {
    if (!this.opened) this.open("");
    const candidates = this.matches();
    if (matchesKey(data, Key.up)) {
      this.selected = Math.max(0, this.selected - 1);
    } else if (matchesKey(data, Key.down)) {
      this.selected = Math.min(Math.max(0, candidates.length - 1), this.selected + 1);
    } else if (matchesKey(data, Key.tab)) {
      const command = candidates[this.selected];
      if (command) {
        this.input.setValue(`/${command.name}`);
        this.input.handleInput("\x05");
      }
      this.selected = 0;
    } else {
      const before = this.value;
      this.input.handleInput(data);
      if (this.value !== before) { this.selected = 0; this.error = ""; }
    }
  }

  render(width: number, maxSuggestions = 5, focused = false, accentCode = "\x1b[38;2;111;211;204m"): string[] {
    this.input.focused = this.opened || focused;
    const slots = Math.max(0, Math.floor(maxSuggestions));
    const lines: string[] = [muted("─".repeat(Math.max(1, width)))];
    this.inputRow = lines.length;
    lines.push(...this.input.render(width));
    lines.push(muted("─".repeat(Math.max(1, width))));
    const suggestionTop = lines.length;
    this.suggestionRows.clear();
    const candidates = this.opened ? this.matches() : [];
    this.selected = Math.min(this.selected, Math.max(0, candidates.length - 1));
    if (slots && this.error) lines.push(muted(" " + this.error));
    else if (slots && this.opened && this.value.startsWith("/") && !candidates.length) lines.push(muted(" 没有匹配的命令 · Esc 取消"));
    const start = Math.max(0, this.selected - slots + 1);
    for (let i = start; !this.error && i < Math.min(candidates.length, start + slots); i++) {
      const command = candidates[i]!;
      const label = `/${command.name}`.padEnd(12);
      const row = ` ${i === this.selected ? "›" : " "} ${accentCode}${label}\x1b[0m ${muted(command.description)}`;
      this.suggestionRows.set(lines.length, command.name);
      lines.push(i === this.selected ? `\x1b[1m${row}\x1b[0m` : row);
    }
    // 始终保留相同高度；筛选、报错和收起列表均不推动上方角色。
    while (lines.length < suggestionTop + slots) lines.push("");
    return lines.map((line) => visibleWidth(line) > width ? truncateToWidth(line, width) : line);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== "left" || (event.type !== "click" && event.type !== "press")) return undefined;
    const command = this.suggestionRows.get(event.y);
    if (command && !this.error) {
      if (event.type === "click") this.execute(command);
      return { handled: true };
    }
    if (event.y === this.inputRow) {
      this.opened = true;
      this.input.handleMouse({ ...event, y: 0 });
      return { handled: true };
    }
    return undefined;
  }
}
