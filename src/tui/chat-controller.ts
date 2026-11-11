import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ChatConfigSchema, type ChatConfig, type ChatSession } from "../shared/chat.js";
import { assertNoCredentials } from "../shared/creds.js";
import { sha256OfJsonable } from "../shared/hashing.js";
import { writeJsonAtomic } from "../shared/json.js";
import { ChatService } from "../service/chat-service.js";
import type { Registry } from "../providers/pi-adapter.js";

export interface ChatModelChoice { profileId: string; modelId: string; label: string; ready: boolean }
export interface ChatWorkspaceOptions {
  root: string; registry: (config: Pick<ChatConfig, "profileId" | "modelId">) => Registry;
  models: () => ChatModelChoice[];
}
export type ChatPage = "chat" | "models" | "settings" | "history" | "confirm";
export type NativeSearchSupport = { supported: boolean; status: "verified" | "unverified" | "unsupported"; reason: string | null };
export class ChatWorkspace {
  page: ChatPage = "chat";
  config: ChatConfig;
  session?: ChatSession;
  sessions: ChatSession[] = [];
  models: ChatModelChoice[] = [];
  modelIndex = 0;
  historyIndex = 0;
  input = "";
  message = "选择模型，输入消息开始独立对话。";
  busy = false;
  readonly service: ChatService;
  private pending?: Promise<void>;
  private confirmation?: { input: string; digest: string };
  private readonly consent = new Set<string>();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly options: ChatWorkspaceOptions) {
    const path = join(options.root, "settings.json");
    this.config = existsSync(path) ? ChatConfigSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : ChatConfigSchema.parse({ profileId: "unselected", modelId: "unselected" });
    assertNoCredentials(this.config, "chat settings");
    this.service = new ChatService(options.root);
    this.service.subscribe(() => { if (this.session) this.session = this.service.get(this.session.id); this.emit(); });
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { for (const listener of this.listeners) listener(); }
  private registry(): Registry { return this.options.registry(this.config); }
  private saveSettings(): void { assertNoCredentials(this.config, "chat settings"); writeJsonAtomic(join(this.options.root, "settings.json"), this.config); }
  open(): void {
    this.models = this.options.models();
    if (this.config.profileId === "unselected") {
      const selected = this.models.find((model) => model.ready);
      if (selected) this.config = ChatConfigSchema.parse({ ...this.config, profileId: selected.profileId, modelId: selected.modelId });
    }
    // 没有当前会话时是新对话状态：原生搜索回到关闭；有会话时保留历史里恢复的开关。
    if (!this.session) { this.config = ChatConfigSchema.parse({ ...this.config, nativeSearch: false }); this.saveSettings(); }
    this.page = "chat"; this.emit();
  }
  redact(text: string): string { return this.service.redact(text); }
  fail(error: unknown): void { this.message = this.service.safeError(error); this.emit(); }
  private available(): void { if (this.busy) throw new Error("模型仍在回复，请等待或停止。"); }
  chooseModels(): void {
    this.available(); this.models = this.options.models();
    this.modelIndex = Math.max(0, this.models.findIndex((model) => model.profileId === this.config.profileId && model.modelId === this.config.modelId));
    this.page = "models"; this.emit();
  }
  selectModel(index: number): void {
    this.available(); const model = this.models[index]; if (!model) throw new Error("没有所选模型。");
    this.config = ChatConfigSchema.parse({ ...this.config, profileId: model.profileId, modelId: model.modelId, thinkingLevel: "off", nativeSearch: false });
    this.service.selection(this.config, this.registry()); this.saveSettings(); this.page = "chat";
    this.message = "模型已选择，推理请求设为 off，原生搜索已关闭；下一条消息发送前会重新确认。历史消息保留原模型记录。"; this.emit();
  }
  setField(field: "maxTotalTokens" | "maxOutputTokens" | "requestTimeoutMs" | "turnTimeoutMs", text: string): void {
    this.available();
    if (field === "maxTotalTokens" && this.session) throw new Error("当前会话预算已固定，请新建会话设置新的上限。");
    const next = ChatConfigSchema.safeParse({ ...this.config, [field]: Number(text) });
    if (!next.success) throw new Error("请输入有效的正整数；Token 上限和时限需要在安全数值范围内。");
    this.config = next.data; this.saveSettings(); this.message = "设置已保存，发送前会重新确认。"; this.emit();
  }
  cycleThinking(): void {
    this.available(); const { model } = this.service.selection(this.config, this.registry());
    const levels = getSupportedThinkingLevels(model), index = levels.indexOf(this.config.thinkingLevel);
    this.config = { ...this.config, thinkingLevel: levels[(index + 1) % levels.length]! }; this.saveSettings(); this.emit();
  }
  /** 当前模型的原生搜索能力；只做核实，不发请求。 */
  nativeSearchSupport(): NativeSearchSupport {
    try { return this.service.nativeSearchSupport(this.config, this.registry()); }
    catch (error) { return { supported: false, status: "unsupported", reason: this.service.safeError(error) }; }
  }
  /** 关闭可以直接执行；开启前先核实支持状态，不支持时不改配置。 */
  toggleNativeSearch(): void {
    this.available();
    const next = !this.config.nativeSearch;
    let support: NativeSearchSupport | undefined;
    if (next) {
      support = this.service.nativeSearchSupport(this.config, this.registry());
      if (!support.supported) throw new Error(support.reason ?? "当前模型不支持原生搜索，无法开启。");
    }
    this.config = ChatConfigSchema.parse({ ...this.config, nativeSearch: next });
    this.saveSettings();
    this.message = next
      ? `原生搜索已开启（模型自主决定是否搜索${support?.status === "unverified" ? "，支持状态未验证" : ""}）；下一条消息发送前会重新确认。`
      : "原生搜索已关闭；下一条消息发送前会重新确认。";
    this.emit();
  }
  newConversation(): void {
    this.available(); this.session = undefined; this.input = ""; this.confirmation = undefined; this.page = "chat";
    this.config = ChatConfigSchema.parse({ ...this.config, nativeSearch: false }); this.saveSettings();
    this.message = "新对话已就绪，原生搜索已关闭；历史记录继续保留。"; this.emit();
  }
  history(): void { this.available(); this.sessions = this.service.list(); this.historyIndex = 0; this.page = "history"; this.emit(); }
  openHistory(index: number): void {
    this.available(); const selected = this.sessions[index]; if (!selected) throw new Error("没有所选聊天记录。");
    this.session = this.service.get(selected.id);
    const last = this.session.turns.at(-1);
    // 有轮次时按最后一轮配置恢复（含原生搜索）；空历史没有可恢复的设置，原生搜索保持关闭。
    this.config = last ? structuredClone(last.config) : ChatConfigSchema.parse({ ...this.config, maxTotalTokens: this.session.maxTotalTokens, nativeSearch: false });
    this.input = ""; this.page = "chat"; this.confirmation = undefined;
    this.message = "已读取历史记录；读取和选择模型不会发送请求。"; this.emit();
  }
  back(): boolean {
    if (this.page === "chat") return false;
    this.page = "chat"; this.confirmation = undefined; this.emit(); return true;
  }
  private current(): ChatSession | undefined { return this.session ? this.service.get(this.session.id) : undefined; }
  private digest(registry = this.registry()): string {
    const selected = this.service.selection(this.config, registry);
    return sha256OfJsonable({ config: this.config, model: selected.snapshot, session: this.current() ?? null, budget: this.session ? this.service.budget(this.session.id) : null });
  }
  private consentKey(registry = this.registry()): string {
    return sha256OfJsonable({ config: this.config, sessionId: this.session?.id, model: this.service.selection(this.config, registry).snapshot });
  }
  async submit(input = this.input): Promise<void> {
    this.available(); const text = input.trim();
    if (!text || text.length > 20000) throw new Error("请输入 1–20000 字符的消息。");
    assertNoCredentials(text, "chat input");
    const registry = this.registry(); this.service.selection(this.config, registry, true);
    if (this.session) this.session = this.service.get(this.session.id);
    const last = this.session?.turns.at(-1);
    if (last?.requestStarted && !["completed", "truncated"].includes(last.status)) throw new Error("上次回复未完整结束，请检查记录并明确新建会话；不会重发旧消息。");
    if (this.service.context(this.config, registry, this.session, text).remainingTokens < 0) throw new Error("上下文容量不足，未发送消息。请新建对话；原历史保留。 ");
    this.input = text;
    if (!this.consent.has(this.consentKey(registry))) { this.confirmation = { input: text, digest: this.digest(registry) }; this.page = "confirm"; this.emit(); return; }
    await this.dispatch(text, registry);
  }
  confirmationLines(): string[] {
    if (!this.confirmation) return [];
    const { snapshot } = this.service.selection(this.config, this.registry());
    const budget = this.session ? this.service.budget(this.session.id) : null;
    const search = this.config.nativeSearch
      ? ["原生搜索已允许：是否搜索由模型自主决定，并非每轮必搜。",
        "搜索词由模型生成并发送给 Spark；可能增加 Token 或费用，Token 上限不是搜索费用的硬保证。",
        "无 AnySearch 与本地执行工具；开启不代表已经发生搜索。",
        "不计入测评成绩。"]
      : ["原生搜索关闭；无本地搜索或执行工具；不计入测评成绩。"];
    return ["确认此会话的模型调用与独立预算（可能产生费用）", `模型 ${snapshot.profileId} / ${snapshot.modelId}`, `接口 ${snapshot.baseUrl}`,
      `请求推理 ${this.config.thinkingLevel} · 单次输出上限 ${Math.min(this.config.maxOutputTokens, snapshot.maxTokens)}`,
      `会话 Token 上限 ${this.config.maxTotalTokens} · 已知消耗 ${budget?.knownTokens ?? 0}`,
      "本会话后续按 Enter 发送消息会继续调用此模型并计入同一预算；更换配置将再次确认。",
      "请求前按估算预留 Token，实际消耗以供应商回执为准；用量未知时停止续发。",
      ...search,
      `消息：${this.confirmation.input}`];
  }
  async confirm(): Promise<void> {
    this.available(); const confirmation = this.confirmation;
    const registry = this.registry();
    if (!confirmation || confirmation.digest !== this.digest(registry)) throw new Error("发送摘要已变化，请取消后重新确认。");
    this.confirmation = undefined; this.page = "chat";
    if (!this.session) this.session = this.service.create(this.config.maxTotalTokens);
    this.consent.add(this.consentKey(registry));
    await this.dispatch(confirmation.input, registry);
  }
  private async dispatch(input: string, registry: Registry): Promise<void> {
    if (!this.session) throw new Error("尚未建立聊天会话。");
    const selected = this.service.selection(this.config, registry, true);
    const session = this.service.get(this.session.id), config = structuredClone(this.config);
    this.busy = true; this.input = ""; this.message = "模型正在回复，Ctrl+S 可停止。"; this.emit();
    this.pending = this.service.respond(session.id, input, config, registry, { authorisePaid: true, modelIdentity: selected.snapshot.identity, historyDigest: sha256OfJsonable(session) })
      .then((result) => { this.session = result; this.message = result.turns.at(-1)?.error ?? "回复已保存。"; })
      .catch((error) => { this.message = this.service.safeError(error); if (!this.input) this.input = input; })
      .finally(() => { this.busy = false; this.pending = undefined; this.emit(); });
    await this.pending;
  }
  async stopAndWait(): Promise<void> {
    if (this.session) this.service.cancel(this.session.id);
    await this.pending; this.service.flush();
  }
  metrics() { return this.service.metrics(this.session); }
  context() { return this.service.context(this.config, this.registry(), this.session, this.input); }
  live(): string { return this.session ? this.service.live(this.session.id) : ""; }
}
