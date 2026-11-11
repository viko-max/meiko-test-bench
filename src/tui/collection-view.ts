import { Input, Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CollectionWorkspace } from "./collection-controller.js";
import { buildUserContent } from "../runner/prompt.js";
import { scoringComplete } from "../import/convert-check.js";

const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\t/g, "    ");
const cyan = (text: string) => `\x1b[38;2;111;211;204m${text}\x1b[0m`;
type Action = { label: string; run: () => void | Promise<unknown> };
type Zone = { y: number; x: number; end: number; run: () => void; toolbar?: boolean };

export class CollectionView {
  private readonly chat = new Input({ prompt: " › ", placeholder: "输入搜题要求，Enter 查看发送摘要；/ 查看命令" });
  private field?: { name: string; label: string; input: Input; secret?: "search" | "model" };
  private focus: "text" | "actions" = "text";
  private actionIndex = 0;
  private scroll = 0;
  private tail = true;
  private zones: Zone[] = [];
  private page = "";
  private modelFilter = "";
  private visibleModels: number[] = [];
  onBack?: () => void;
  onEditDraft?: (id: string) => void;
  onRun?: (dataset: string) => void;
  onChange?: () => void;
  constructor(readonly workspace: CollectionWorkspace) {
    this.chat.onSubmit = (text) => this.act(() => { this.workspace.input = text; this.workspace.prepare("send", text); });
  }
  get secretInput(): boolean { return !!this.field?.secret; }
  get usesDock(): boolean { return !!this.field || this.workspace.page === "chat"; }
  canOpenCommands(): boolean { return !this.field && (this.workspace.page !== "chat" || !this.chat.getValue()); }
  private act(action: () => void | Promise<unknown>): void {
    try {
      const result = action();
      if (result instanceof Promise) void result.catch((error) => { this.workspace.message = this.workspace.redact(error instanceof Error ? error.message : String(error)); }).finally(() => this.onChange?.());
    } catch (error) { this.workspace.message = this.workspace.redact(error instanceof Error ? error.message : String(error)); }
    this.onChange?.();
  }
  private edit(name: string, label: string, value = "", secret?: "search" | "model"): void {
    const input = new Input({ prompt: ` ${label}：` }); input.focused = true; input.setValue(secret ? "" : value); input.handleInput("\x05");
    input.onSubmit = (text) => this.act(() => {
      if (secret) this.workspace.setSecret(secret, text);
      else if (name === "filter") { this.modelFilter = text; this.workspace.modelIndex = 0; }
      else this.workspace.setField(name, text);
      input.setValue(""); this.field = undefined;
    });
    input.onEscape = () => { input.setValue(""); this.field = undefined; };
    this.field = { name, label, input, secret };
  }
  private actions(): Action[] {
    const s = this.workspace;
    const back = { label: "返回", run: () => { if (!s.back()) this.onBack?.(); } };
    switch (s.page) {
      case "chat": return [{ label: "配置", run: () => { s.page = "settings"; } }, { label: "候选题", run: () => s.candidates() },
        { label: "历史", run: () => s.history() }, { label: "新会话", run: () => s.newConversation() }, { label: "停止", run: () => s.stop() },
        ...(s.publishedId ? [{ label: "创建测评", run: () => this.onRun?.(s.publishedId!) }] : [])];
      case "settings": return [{ label: "选模型", run: () => s.chooseModels() }, { label: "搜索 Key", run: () => this.edit("search", "AnySearch Key（仅本次会话）", "", "search") },
        { label: "模型 Key", run: () => this.edit("model", "模型 Key（仅本次会话）", "", "model") },
        { label: "环境变量", run: () => s.setSearchMode("environment") }, { label: "匿名模式", run: () => s.setSearchMode("anonymous") },
        { label: "验证搜索", run: () => s.prepare("searchProbe") }, { label: "验证模型", run: () => s.prepare("modelProbe") },
        { label: "推理等级", run: () => s.cycleThinking() }, { label: "保存配置", run: () => s.savePreferences() }, back];
      case "models": return [{ label: "选择", run: () => s.selectModel(this.visibleModels[s.modelIndex] ?? -1) },
        { label: "筛选", run: () => this.edit("filter", "模型筛选", this.modelFilter) }, back];
      case "history": return [{ label: "打开", run: () => s.openHistory() }, back];
      case "candidates": return [{ label: "查看", run: () => { if (!s.session?.candidates[s.candidateIndex]) throw new Error("没有候选题。"); s.page = "candidate"; } },
        { label: "选择/取消", run: () => s.toggleCandidate() }, { label: "排除/恢复", run: () => s.excludeCandidate() },
        { label: s.includeScoring ? "评分已采用" : "采用评分", run: () => { s.includeScoring = !s.includeScoring; } },
        { label: "核对人", run: () => this.edit("reviewer", "评分核对人", s.reviewer) }, { label: "核对依据", run: () => this.edit("reviewReason", "评分核对依据", s.reviewReason) },
        { label: "生成草稿", run: () => s.prepare("stage") }, back];
      case "candidate": return [{ label: "题面", run: () => { s.tab = "question"; this.scroll = 0; } }, { label: "来源", run: () => { s.tab = "source"; this.scroll = 0; } },
        { label: "评分建议", run: () => { s.tab = "scoring"; this.scroll = 0; } }, back];
      case "confirm": return [{ label: "确认执行", run: () => s.confirm() }, { label: "取消", run: () => { s.back(); } }];
      case "publish": return [{ label: "逐题编辑", run: () => { if (s.draft) this.onEditDraft?.(s.draft.draftId); } },
        ...(s.publishedId ? [{ label: "创建测评", run: () => this.onRun?.(s.publishedId!) }] : [{ label: "确认入库", run: () => s.prepare("publish") }]), back];
    }
  }
  private configFields(): Array<[string, string, string]> {
    const s = this.workspace;
    return [["datasetId", "题集标识", s.config.datasetId], ["version", "题集版本", s.config.version],
      ["targetCount", "目标题数", String(s.config.targetCount ?? "未指定")],
      ["maxTotalTokens", "会话 Token 上限", String(s.config.limits.maxTotalTokens)], ["maxSearchRequests", "搜索请求上限", String(s.config.limits.maxSearchRequests)],
      ["maxExtractRequests", "正文提取上限", String(s.config.limits.maxExtractRequests)], ["maxOutputTokens", "单次输出 Token", String(s.config.limits.maxOutputTokens)],
      ["maxCandidates", "候选题数量上限", String(s.config.limits.maxCandidates)], ["maxModelRequests", "模型请求上限", String(s.config.limits.maxModelRequests)],
      ["requestTimeoutMs", "请求超时（秒）", String(s.config.limits.requestTimeoutMs / 1000)], ["turnTimeoutMs", "单次对话时限（秒）", String(s.config.limits.turnTimeoutMs / 1000)]];
  }
  private configIndex = 0;
  footer(): string {
    if (this.field) return this.field.secret ? "密钥隐藏输入 · Enter 仅用于本次会话 · Esc 取消 · Ctrl+C 退出" : "Enter 保存字段 · Esc 取消输入 · Ctrl+C 退出";
    if (this.workspace.page === "chat") return "Enter 发送摘要 · Tab 操作 · Ctrl+S 停止 · PgUp/PgDn 阅读 · Esc 返回 · / 命令";
    if (this.workspace.page === "settings") return "↑↓ 选设置 · Enter 编辑 · Tab 操作按钮 · Esc 返回 · / 命令";
    if (this.workspace.page === "candidates") return "↑↓ 选题 · 空格勾选 · Tab 操作按钮 · Enter 题目 · Esc 返回 · / 命令";
    return "↑↓ 选择/阅读 · Tab 操作按钮 · Enter 打开/执行 · Esc 返回 · / 命令";
  }
  renderDock(width: number, slots: number): string[] {
    if (!this.field && this.chat.getValue() !== this.workspace.input) { this.chat.setValue(this.workspace.input); this.chat.handleInput("\x05"); }
    const field = this.field;
    const entry = field?.secret ? [` ${field.label}：${"•".repeat(Math.min([...field.input.getValue()].length, Math.max(1, width - visibleWidth(field.label) - 5)))}`] :
      field ? field.input.render(width) : (this.chat.focused = this.focus === "text", this.chat.render(width));
    return ["─".repeat(width), ...entry.map((line) => truncateToWidth(line, width)), "─".repeat(width), ...Array<string>(slots).fill("")];
  }
  render(width: number, height: number): string[] {
    const s = this.workspace; this.zones = [];
    if (this.page !== s.page) { this.page = s.page; this.scroll = 0; this.actionIndex = 0; this.focus = "text"; this.tail = true; }
    const actions = this.actions();
    const toolbar: string[] = []; let row = "";
    actions.forEach((action, index) => {
      const label = `[${action.label}]`, space = row ? " " : "";
      if (row && visibleWidth(row + space + label) > width) { toolbar.push(row); row = ""; }
      const x = visibleWidth(row) + (row ? 1 : 0), y = toolbar.length;
      if (row) row += " "; row += this.focus === "actions" && index === this.actionIndex ? cyan(label) : label;
      this.zones.push({ y, x, end: x + visibleWidth(label), toolbar: true, run: () => this.act(action.run) });
    }); if (row) toolbar.push(row);
    const body: string[] = [];
    const wrap = (text: string) => wrapTextWithAnsi(clean(s.redact(text)), Math.max(1, width));
    if (s.page === "chat") {
      body.push(cyan(s.busy ? "搜题进行中" : "对话搜题与组卷"));
      const budget = s.session ? s.service.budget(s.session.id) : null, metrics = s.metrics();
      body.push(`候选 ${s.session?.candidates.length ?? 0} · 已选 ${s.selected.length} · 搜索 ${s.session?.counts.search ?? 0}/${s.config.limits.maxSearchRequests} · 提取 ${s.session?.counts.extract ?? 0}/${s.config.limits.maxExtractRequests}`);
      const progress = s.progress();
      body.push(...wrap(progress ? `目标 ${progress.target ?? "未指定"} · 有效候选 ${progress.accepted} · 缺口 ${progress.remaining ?? "未指定"} · 待核验评分 ${progress.awaitingScoringReview}` : `目标题数 ${s.config.targetCount ?? "未指定"} · 输入学科、难度及来源要求开始搜题`));
      body.push(`Token 已知 ${budget?.knownTokens ?? 0} · 剩余 ${budget?.remainingTokens ?? s.config.limits.maxTotalTokens}${budget?.unknownRequests ? " · 有未知用量" : ""}`);
      body.push(`TPS ${metrics.requestTps === null ? "未知" : metrics.requestTps.toFixed(1)} · 缓存 ${metrics.cacheHitRate === null ? "未知" : (metrics.cacheHitRate * 100).toFixed(1) + "%"} · 推理请求 ${s.config.thinkingLevel} · ${s.live().activity}`);
      const messages: string[] = [];
      for (const value of s.session?.transcript ?? []) {
        const message = value as { role?: string; content?: string | Array<{ type?: string; text?: string }> };
        if (message.role !== "user" && message.role !== "assistant") continue;
        const text = typeof message.content === "string" ? message.content : (message.content ?? []).flatMap((part) => part.type === "text" ? [part.text ?? ""] : []).join("\n");
        if (text.trim()) messages.push(...wrap(`${message.role === "user" ? "你" : "模型"} › ${text}`), "");
      }
      if (s.busy && s.live().text) messages.push(...wrap(`模型 › ${s.live().text}`));
      if (!messages.length) messages.push(...wrap("例如：寻找大学数学与物理竞赛题，优先原始来源，附答案和原题分值。找到后先给我核对。"));
      const room = Math.max(1, height - toolbar.length - body.length - 2);
      if (this.tail) this.scroll = Math.max(0, messages.length - room);
      this.scroll = Math.min(this.scroll, Math.max(0, messages.length - room));
      body.push(...messages.slice(this.scroll, this.scroll + room));
    } else if (s.page === "settings") {
      const credentials = s.credentials();
      body.push(cyan("搜索与模型配置"), ...wrap(`模型 ${s.config.profileId}/${s.config.modelId} · 推理 ${s.config.thinkingLevel}`),
        ...wrap(`搜索：${credentials.mode} · ${credentials.searchReady ? "已配置" : "缺少 Key"} · ${s.searchVerified ? "连接已验证" : "连接未验证"}`),
        ...wrap(`模型 Key：${credentials.modelReady ? "已配置" : "未配置"} · ${s.modelVerified ? "连接已验证" : "连接未验证"}`));
      const fields = this.configFields(), room = Math.max(1, height - toolbar.length - body.length - 2);
      const start = Math.max(0, Math.min(this.configIndex - room + 1, fields.length - room));
      for (let index = start; index < Math.min(fields.length, start + room); index++) {
        const field = fields[index]!; const y = body.length;
        body.push(`${index === this.configIndex && this.focus === "text" ? "›" : " "} ${field[1]}：${field[2]}`);
        this.zones.push({ y, x: 0, end: width, run: () => { this.configIndex = index; this.edit(...field); } });
      }
    } else if (s.page === "models") {
      this.visibleModels = s.modelChoices.flatMap((choice, index) => !this.modelFilter || `${choice.label} ${choice.modelId}`.toLowerCase().includes(this.modelFilter.toLowerCase()) ? [index] : []);
      s.modelIndex = Math.min(s.modelIndex, Math.max(0, this.visibleModels.length - 1)); body.push(cyan(`选择搜题模型 · ${this.visibleModels.length} 项`));
      const room = Math.max(1, height - toolbar.length - 3), start = Math.max(0, s.modelIndex - room + 1);
      for (let index = start; index < Math.min(this.visibleModels.length, start + room); index++) {
        const choice = s.modelChoices[this.visibleModels[index]!]!; const y = body.length; body.push(`${index === s.modelIndex ? "›" : " "} ${clean(choice.label)}`);
        this.zones.push({ y, x: 0, end: width, run: () => s.selectModel(this.visibleModels[index]!) });
      }
    } else if (s.page === "history") {
      body.push(cyan("搜题历史 · 读取不会自动发请求"));
      const room = Math.max(1, Math.floor((height - toolbar.length - 3) / 2)), start = Math.max(0, s.historyIndex - room + 1);
      for (let index = start; index < Math.min(s.sessions.length, start + room); index++) { const entry = s.sessions[index]!, y = body.length; body.push(`${index === s.historyIndex ? "›" : " "} ${entry.config.datasetId} · ${entry.candidates.length} 题 · ${entry.state}`, ...wrap(entry.goal).slice(0, 1));
        this.zones.push({ y, x: 0, end: width, run: () => s.openHistory(index) }); }
      if (!s.sessions.length) body.push("暂无搜题会话。");
    } else if (s.page === "candidates") {
      body.push(cyan(`候选题 · 已选 ${s.selected.length} · 已排除 ${s.excluded.length}`));
      const candidates = s.session?.candidates ?? [], room = Math.max(1, height - toolbar.length - 3), start = Math.max(0, s.candidateIndex - room + 1);
      for (let index = start; index < Math.min(candidates.length, start + room); index++) { const candidate = candidates[index]!, id = candidate.question.id, y = body.length;
        body.push(`${index === s.candidateIndex ? "›" : " "} ${s.selected.includes(id) ? "✓" : "·"} ${id} · ${clean(candidate.question.subject)} · ${s.excluded.includes(id) ? "已排除" : candidate.issues.length ? "重复待处理" : candidate.scoring ? "评分待核验" : "未评分"}`);
        this.zones.push({ y, x: 0, end: width, run: () => { s.candidateIndex = index; } }); }
      if (!candidates.length) body.push("还没有符合要求的候选题，可返回继续对话。");
      if (height > 13) body.push("评分建议默认不采用；可在组卷摘要中明确核对。");
    } else if (s.page === "candidate") {
      const candidate = s.session?.candidates[s.candidateIndex]; body.push(cyan(`候选题核对 · ${candidate?.question.id ?? ""} · ${s.tab}`));
      let text = "没有所选题目。";
      if (candidate) {
        if (s.tab === "question") text = buildUserContent(candidate.question);
        if (s.tab === "scoring") text = `来源权威性：尚未人工核验\n${candidate.scoring ? JSON.stringify(candidate.scoring, null, 2) : "未取得评分依据。"}\n\n答案证据：\n${candidate.answerEvidence.map((item) => item.quote).join("\n\n")}`;
        if (s.tab === "source") text = s.session!.sources.filter((source) => source.id === candidate.sourceId || [...candidate.evidence, ...candidate.answerEvidence].some((item) => item.sourceId === source.id))
          .map((source) => `${source.title}\n${source.url}\n获取时间 ${source.fetchedAt}\n摘要 ${source.digest}\n\n${source.content}`).join("\n\n");
      }
      this.read(body, wrap(text), height - toolbar.length - 2);
    } else if (s.page === "confirm") {
      body.push(cyan("请核对操作摘要")); this.read(body, s.confirmationDetails().flatMap(wrap), height - toolbar.length - 2);
    } else if (s.page === "publish") {
      body.push(cyan(s.publishedId ? "题集已发布" : "组卷草稿"));
      if (s.draft) { const scored = s.draft.questions.filter((question) => scoringComplete(question.scoring)).length; body.push(...wrap(`${s.draft.datasetId} · ${s.draft.questions.length} 题 · ${scored} 题有评分依据`));
        this.read(body, s.draft.questions.flatMap((question) => wrap(`${question.id} · ${question.subject} · ${question.stem}`)), height - toolbar.length - 2); }
    }
    const available = Math.max(0, height - toolbar.length - 1);
    const lines = body.slice(0, available).map((line) => truncateToWidth(line, width));
    while (lines.length < available) lines.push("");
    if (height > toolbar.length) lines.push(truncateToWidth(clean(s.redact(s.message)), width));
    const toolbarY = lines.length;
    this.zones = this.zones.filter((zone) => zone.toolbar || zone.y < available).map((zone) => ({ ...zone, y: zone.toolbar ? zone.y + toolbarY : zone.y }));
    lines.push(...toolbar); return lines.slice(0, height);
  }
  private read(body: string[], content: string[], available: number): void { const room = Math.max(1, available - body.length); this.scroll = Math.min(this.scroll, Math.max(0, content.length - room)); body.push(...content.slice(this.scroll, this.scroll + room)); }
  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("s"))) { this.workspace.stop(); return; }
    if (this.field) { this.field.input.handleInput(data); this.onChange?.(); return; }
    if (matchesKey(data, Key.escape)) { if (this.focus === "actions") this.focus = "text"; else if (!this.workspace.back()) this.onBack?.(); return; }
    if (matchesKey(data, Key.tab)) { this.focus = this.focus === "text" ? "actions" : "text"; this.actionIndex = 0; return; }
    const actions = this.actions();
    if (this.focus === "actions") {
      if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) this.actionIndex = Math.min(actions.length - 1, this.actionIndex + 1);
      else if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) this.actionIndex = Math.max(0, this.actionIndex - 1);
      else if (matchesKey(data, Key.enter)) this.act(actions[this.actionIndex]?.run ?? (() => {}));
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) { this.tail = false; this.scroll = Math.max(0, this.scroll + (matchesKey(data, Key.pageUp) ? -5 : 5)); return; }
    const s = this.workspace;
    if (s.page === "chat") { this.chat.handleInput(data); s.input = this.chat.getValue(); return; }
    const step = matchesKey(data, Key.down) ? 1 : matchesKey(data, Key.up) ? -1 : 0;
    if (step) {
      if (s.page === "settings") this.configIndex = Math.max(0, Math.min(this.configFields().length - 1, this.configIndex + step));
      else if (s.page === "models") s.modelIndex = Math.max(0, Math.min(this.visibleModels.length - 1, s.modelIndex + step));
      else if (s.page === "history") s.historyIndex = Math.max(0, Math.min(s.sessions.length - 1, s.historyIndex + step));
      else if (s.page === "candidates") s.candidateIndex = Math.max(0, Math.min((s.session?.candidates.length ?? 0) - 1, s.candidateIndex + step));
      else this.scroll = Math.max(0, this.scroll + step);
      return;
    }
    if (s.page === "candidates" && data === " ") { this.act(() => s.toggleCandidate()); return; }
    if (matchesKey(data, Key.enter)) {
      if (s.page === "settings") { const field = this.configFields()[this.configIndex]!; this.edit(...field); }
      else if (s.page === "models") this.act(() => s.selectModel(this.visibleModels[s.modelIndex] ?? -1));
      else if (s.page === "history") this.act(() => s.openHistory());
      else if (s.page === "candidates") this.act(() => { if (!s.session?.candidates[s.candidateIndex]) throw new Error("没有候选题。"); s.page = "candidate"; });
      else if (s.page === "confirm") this.act(() => s.confirm());
    }
  }
  focusDock(): void { this.focus = "text"; }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.field) return { handled: true };
    if (event.type === "wheel") { this.tail = false; this.scroll = Math.max(0, this.scroll + (event.wheelDelta ?? 0)); return { handled: true }; }
    const zone = this.zones.find((zone) => zone.y === event.y && event.x >= zone.x && event.x < zone.end);
    if (zone && event.button === "left" && (event.type === "click" || event.type === "press")) { if (event.type === "click") zone.run(); return { handled: true }; }
    return undefined;
  }
}
