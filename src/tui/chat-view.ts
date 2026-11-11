import { Input, Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { ChatWorkspace, type NativeSearchSupport } from "./chat-controller.js";

const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\t/g, "    ");
const cyan = (text: string) => `\x1b[38;2;111;211;204m${text}\x1b[0m`;
type Action = { label: string; run: () => void | Promise<unknown> };
type Zone = { y: number; x: number; end: number; run: () => void };
const STATES = { running: "回复中", completed: "已完成", truncated: "输出截断", cancelled: "已停止", outcome_unknown: "结果未确认", error: "未完成" };
const SEARCH_STATUS: Record<NativeSearchSupport["status"], string> = { verified: "官方文档已确认", unverified: "未验证", unsupported: "不支持" };
const FIELDS = [
  ["maxTotalTokens", "会话 Token 上限"], ["maxOutputTokens", "单次输出上限"],
  ["requestTimeoutMs", "流空闲上限（秒）"], ["turnTimeoutMs", "整轮时限（秒）"],
] as const;

export class ChatView {
  private readonly entry = new Input({ prompt: " › ", placeholder: "输入消息 · Enter 发送 · / 命令" });
  private field?: Input;
  private focus: "text" | "actions" = "text";
  private actionIndex = 0;
  private settingsIndex = 0;
  private scroll = 0;
  private tail = true;
  private page = "";
  private zones: Zone[] = [];
  private filter = "";
  private filteredModels: number[] = [];
  onBack?: () => void;
  onChange?: () => void;
  constructor(readonly workspace: ChatWorkspace) {
    this.entry.onSubmit = (text) => this.act(() => this.workspace.submit(text));
  }
  private act(action: () => void | Promise<unknown>): void {
    try { const result = action(); if (result instanceof Promise) void result.catch((error) => this.workspace.fail(error)).finally(() => this.onChange?.()); }
    catch (error) { this.workspace.fail(error); }
    this.onChange?.();
  }
  get usesDock(): boolean { return true; }
  canOpenCommands(): boolean { return !this.field && (this.workspace.page !== "chat" || !this.entry.getValue()); }
  focusDock(): void { this.focus = "text"; }
  footer(): string {
    if (this.field) return "Enter 保存 · Esc 取消 · Ctrl+C 退出";
    if (this.workspace.page === "chat") return "Enter 发送 · Ctrl+S 停止 · PgUp/PgDn 阅读 · Tab 操作 · Esc 返回 · / 命令";
    if (this.workspace.page === "models") return "↑↓ 选择 · Enter 使用 · f 筛选模型 · Tab 操作 · Esc 返回 · / 命令";
    if (this.workspace.page === "settings") return "↑↓ 选择 · Enter 编辑 · t 切换推理 · w 切换搜索 · Tab 操作 · Esc 返回 · / 命令";
    if (this.workspace.page === "confirm") return "Enter 确认发送 · PgUp/PgDn 阅读 · Tab 操作 · Esc 取消 · / 命令";
    return "↑↓ 选择 · Enter 打开 · Tab 操作 · Esc 返回 · / 命令";
  }
  private actions(): Action[] {
    const s = this.workspace;
    if (s.page === "confirm") return [{ label: "确认并发送", run: () => s.confirm() }, { label: "取消", run: () => { s.back(); } }];
    if (s.page !== "chat") return [{ label: "返回对话", run: () => { s.back(); } }, ...(s.page === "models" ? [{ label: "筛选", run: () => this.editFilter() }] : [])];
    return [{ label: "新对话", run: () => s.newConversation() }, { label: "历史", run: () => s.history() }, { label: "模型", run: () => s.chooseModels() },
      { label: "设置", run: () => { if (s.busy) throw new Error("请等待或停止当前回复。"); s.page = "settings"; } }, { label: "停止", run: () => s.stopAndWait() }];
  }
  private editFilter(): void {
    const input = new Input({ prompt: " 模型筛选：" }); input.focused = true; input.setValue(this.filter); input.handleInput("\x05");
    input.onSubmit = (value) => { this.filter = value.toLowerCase(); this.workspace.modelIndex = 0; this.field = undefined; this.onChange?.(); };
    input.onEscape = () => { this.field = undefined; }; this.field = input;
  }
  private editSetting(): void {
    const field = FIELDS[this.settingsIndex]!;
    const input = new Input({ prompt: ` ${field[1]}：` }); input.focused = true;
    input.setValue(String(this.workspace.config[field[0]] / (field[0].endsWith("Ms") ? 1000 : 1))); input.handleInput("\x05");
    input.onSubmit = (value) => this.act(() => { this.workspace.setField(field[0], field[0].endsWith("Ms") ? String(Number(value) * 1000) : value); this.field = undefined; });
    input.onEscape = () => { this.field = undefined; }; this.field = input;
  }
  renderDock(width: number, slots: number): string[] {
    if (!this.field && this.workspace.page !== "chat") return ["─".repeat(width), truncateToWidth(this.workspace.page === "confirm" ? " Enter 确认并发送 · Esc 取消 · / 命令" : " / 查看功能命令", width), "─".repeat(width), ...Array<string>(slots).fill("")];
    if (!this.field && this.entry.getValue() !== this.workspace.input) { this.entry.setValue(this.workspace.input); this.entry.handleInput("\x05"); }
    this.entry.focused = this.focus === "text";
    const entry = this.field ?? this.entry;
    return ["─".repeat(width), ...entry.render(width), "─".repeat(width), ...Array<string>(slots).fill("")].map((line) => truncateToWidth(line, width));
  }
  render(width: number, height: number, notice?: string): string[] {
    const s = this.workspace; this.zones = [];
    if (this.page !== s.page) { this.page = s.page; this.scroll = 0; this.tail = true; this.focus = "text"; this.actionIndex = 0; }
    const wrap = (value: string) => wrapTextWithAnsi(clean(s.redact(value)), Math.max(1, width));
    const actions = this.actions(), toolbar: string[] = []; let toolbarLine = "";
    actions.forEach((action, index) => {
      const label = `[${action.label}]`;
      if (toolbarLine && visibleWidth(toolbarLine + " " + label) > width) { toolbar.push(toolbarLine); toolbarLine = ""; }
      const x = visibleWidth(toolbarLine) + (toolbarLine ? 1 : 0);
      if (toolbarLine) toolbarLine += " "; toolbarLine += this.focus === "actions" && this.actionIndex === index ? cyan(label) : label;
      this.zones.push({ x, y: toolbar.length, end: x + visibleWidth(label), run: () => this.act(action.run) });
    }); if (toolbarLine) toolbar.push(toolbarLine);
    const body: string[] = [];
    if (s.page === "chat") {
      body.push(...wrap(`模型 ${s.config.profileId}/${s.config.modelId} · 请求推理 ${s.config.thinkingLevel} · 原生搜索 ${s.config.nativeSearch ? "开启·模型自主" : "关闭"} · 本地工具关闭`));
      const budget = s.session ? s.service.budget(s.session.id) : null;
      body.push(...wrap(`预算上限 ${s.config.maxTotalTokens} · 已知消耗 ${budget?.knownTokens ?? 0} Token${budget?.unknownRequests ? " · 用量待核对" : ""}`));
      try { const context = s.context(); body.push(...wrap(`上下文估算 ${context.estimatedInputTokens}/${context.contextWindow} · 输出预留 ${context.outputReserve}`)); }
      catch (error) { body.push(...wrap(`上下文未估算：${s.redact(error instanceof Error ? error.message : String(error))}`)); }
      const messages: string[] = [];
      for (const turn of s.session?.turns ?? []) {
        messages.push("", ...wrap(`你 › ${turn.input}`));
        if (turn.config.nativeSearch) messages.push(...wrap("本轮允许原生搜索（不代表已搜索）"));
        const text = turn.response?.content.map((part) => part.text).join("\n") || turn.partialText;
        if (text) messages.push(...wrap(`${turn.model.modelId} › ${text}`));
        if (turn.status !== "completed") messages.push(...wrap(`${STATES[turn.status]}${turn.error ? " · " + turn.error : ""}`));
      }
      if (s.busy && s.live()) messages.push(...wrap(`模型 › ${s.live()}`));
      if (!messages.length) messages.push("", ...wrap("输入消息开始对话。首次发送将确认模型、接口和会话预算。"));
      const room = Math.max(1, height - toolbar.length - body.length - 2);
      if (this.tail) this.scroll = Math.max(0, messages.length - room);
      this.scroll = Math.min(this.scroll, Math.max(0, messages.length - room)); body.push(...messages.slice(this.scroll, this.scroll + room));
    } else if (s.page === "models") {
      body.push(cyan(`选择对话模型${this.filter ? " · 筛选 " + clean(this.filter) : ""}`));
      this.filteredModels = s.models.flatMap((model, index) => !this.filter || `${model.label} ${model.modelId}`.toLowerCase().includes(this.filter) ? [index] : []);
      s.modelIndex = Math.min(s.modelIndex, Math.max(0, this.filteredModels.length - 1));
      const room = Math.max(1, height - toolbar.length - 3), start = Math.max(0, s.modelIndex - room + 1);
      for (let index = start; index < Math.min(this.filteredModels.length, start + room); index++) {
        const real = this.filteredModels[index]!, model = s.models[real]!;
        const y = body.length; body.push(truncateToWidth(`${index === s.modelIndex ? "›" : " "} ${clean(model.label)} · ${model.ready ? "凭据已配置" : "凭据未配置"}`, width));
        this.zones.push({ y, x: 0, end: width, run: () => this.act(() => s.selectModel(real)) });
      }
      if (!this.filteredModels.length) body.push("没有匹配模型，请检查配置或修改筛选条件。");
    } else if (s.page === "history") {
      body.push(cyan("聊天历史 · 读取不会调用模型"));
      const room = Math.max(1, Math.floor((height - toolbar.length - 3) / 2)), start = Math.max(0, s.historyIndex - room + 1);
      for (let index = start; index < Math.min(s.sessions.length, start + room); index++) {
        const item = s.sessions[index]!, y = body.length;
        body.push(truncateToWidth(`${index === s.historyIndex ? "›" : " "} ${clean(s.redact(item.title))}`, width), truncateToWidth(`  ${item.turns.length} 轮 · ${item.updatedAt} · ${item.turns.at(-1) ? STATES[item.turns.at(-1)!.status] : "新对话"}`, width));
        this.zones.push({ y, x: 0, end: width, run: () => this.act(() => s.openHistory(index)) });
      }
      if (!s.sessions.length) body.push("暂无聊天历史。");
    } else if (s.page === "settings") {
      body.push(cyan("对话设置"));
      FIELDS.forEach((field, index) => {
        const y = body.length; body.push(truncateToWidth(`${index === this.settingsIndex ? "›" : " "} ${field[1]}：${s.config[field[0]] / (field[0].endsWith("Ms") ? 1000 : 1)}`, width));
        this.zones.push({ y, x: 0, end: width, run: () => { this.settingsIndex = index; this.editSetting(); this.onChange?.(); } });
      });
      const support = s.nativeSearchSupport(), searchY = body.length;
      body.push(truncateToWidth(`原生搜索：${s.config.nativeSearch ? "开启（模型自主决定是否搜索）" : "关闭"} · w 切换`, width));
      this.zones.push({ y: searchY, x: 0, end: width, run: () => this.act(() => s.toggleNativeSearch()) });
      body.push(...wrap(`原生搜索支持：${SEARCH_STATUS[support.status]}${support.reason ? " · " + support.reason : ""}`));
      body.push(...wrap(`请求推理 ${s.config.thinkingLevel} · t 切换模型声明支持的等级`), ...wrap("已有会话的 Token 总上限保持固定；模型切换保留之前的用量。"));
    } else {
      body.push(cyan("发送确认"));
      const details = s.confirmationLines().flatMap(wrap), room = Math.max(1, height - toolbar.length - 3);
      this.scroll = Math.min(this.scroll, Math.max(0, details.length - room)); body.push(...details.slice(this.scroll, this.scroll + room));
    }
    const messageRows = wrap(notice || s.message).slice(0, 2), available = Math.max(0, height - toolbar.length - messageRows.length);
    const result = body.slice(0, available); while (result.length < available) result.push(""); result.push(...messageRows);
    const toolbarTop = result.length;
    // 工具栏固定在正文底部；鼠标只在 click 执行一次。
    this.zones = this.zones.map((zone, index) => index < actions.length ? { ...zone, y: zone.y + toolbarTop } : zone);
    result.push(...toolbar); return result.slice(0, height).map((line) => truncateToWidth(line, width));
  }
  handleInput(data: string): void {
    if (this.field) { this.field.handleInput(data); this.onChange?.(); return; }
    const s = this.workspace, enter = matchesKey(data, Key.enter) || data === "\r" || data === "\n";
    if (matchesKey(data, Key.ctrl("s"))) { this.act(() => s.stopAndWait()); return; }
    if (matchesKey(data, Key.escape)) {
      if (!s.back()) this.act(async () => { await s.stopAndWait(); this.onBack?.(); }); return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) { this.tail = false; this.scroll = Math.max(0, this.scroll + (matchesKey(data, Key.pageUp) ? -6 : 6)); this.onChange?.(); return; }
    if (matchesKey(data, Key.tab)) { this.actionIndex = this.focus === "text" ? 0 : (this.actionIndex + 1) % this.actions().length; this.focus = "actions"; this.onChange?.(); return; }
    if (this.focus === "actions") {
      if (matchesKey(data, Key.left)) this.actionIndex = Math.max(0, this.actionIndex - 1);
      else if (matchesKey(data, Key.right)) this.actionIndex = Math.min(this.actions().length - 1, this.actionIndex + 1);
      else if (enter) this.act(this.actions()[this.actionIndex]!.run);
      else { this.focus = "text"; this.handleInput(data); } this.onChange?.(); return;
    }
    if (s.page === "chat") { this.tail = true; this.entry.handleInput(data); if (!enter) s.input = this.entry.getValue(); this.onChange?.(); return; }
    if (s.page === "models" && data === "f") { this.editFilter(); this.onChange?.(); return; }
    if (s.page === "settings" && data === "t") { this.act(() => s.cycleThinking()); return; }
    if (s.page === "settings" && data === "w") { this.act(() => s.toggleNativeSearch()); return; }
    const change = matchesKey(data, Key.up) ? -1 : matchesKey(data, Key.down) ? 1 : 0;
    if (s.page === "models") { s.modelIndex = Math.min(Math.max(0, this.filteredModels.length - 1), Math.max(0, s.modelIndex + change)); if (enter && this.filteredModels[s.modelIndex] !== undefined) this.act(() => s.selectModel(this.filteredModels[s.modelIndex]!)); }
    else if (s.page === "history") { s.historyIndex = Math.min(Math.max(0, s.sessions.length - 1), Math.max(0, s.historyIndex + change)); if (enter && s.sessions.length) this.act(() => s.openHistory(s.historyIndex)); }
    else if (s.page === "settings") { this.settingsIndex = Math.min(FIELDS.length - 1, Math.max(0, this.settingsIndex + change)); if (enter) this.editSetting(); }
    else if (enter) this.act(() => s.confirm());
    this.onChange?.();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") { this.tail = false; this.scroll = Math.max(0, this.scroll + (event.wheelDelta ?? 0)); this.onChange?.(); return { handled: true }; }
    if (event.button !== "left" || !["click", "press"].includes(event.type)) return undefined;
    const zone = this.zones.find((item) => item.y === event.y && event.x >= item.x && event.x < item.end);
    if (!zone) return undefined; if (event.type === "click") zone.run(); return { handled: true };
  }
}
