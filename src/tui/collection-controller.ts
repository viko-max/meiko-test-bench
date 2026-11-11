import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { z } from "zod";
import { AnySearchClient } from "../providers/anysearch.js";
import { CollectionService } from "../service/collection-service.js";
import { COLLECTION_WORKFLOW_VERSION, CollectionConfigSchema, type CollectionConfig, type CollectionSession } from "../shared/collection.js";
import { collectionProgress } from "../service/collection-workflow.js";
import { ImportService, type DraftDataset } from "../import/import-service.js";
import { assertNoCredentials } from "../shared/creds.js";
import { sha256OfJsonable } from "../shared/hashing.js";
import { writeJsonAtomic } from "../shared/json.js";
import { resolveModel, type Registry } from "../providers/pi-adapter.js";
import { summarizeRequests } from "../shared/metrics.js";

const MEMORY_SEARCH = "MEIKO_SESSION_ANYSEARCH_KEY";
export interface CollectionModelChoice { profileId: string; modelId: string; label: string; baseUrl: string }
export type CollectionPage = "chat" | "settings" | "models" | "history" | "candidates" | "candidate" | "confirm" | "publish";
type Confirmation = { kind: "send" | "searchProbe" | "modelProbe" | "stage" | "publish"; digest: string; input?: string; parent: CollectionPage };
export interface CollectionWorkspaceOptions {
  importRoot: string; datasetsRoot: string;
  registry: (config: Pick<CollectionConfig, "profileId" | "modelId">) => Registry;
  models: () => CollectionModelChoice[];
  client?: (config: CollectionConfig, getApiKey: () => string | undefined) => AnySearchClient;
}

export class CollectionWorkspace {
  page: CollectionPage = "chat";
  config: CollectionConfig;
  session?: CollectionSession;
  sessions: CollectionSession[] = [];
  modelChoices: CollectionModelChoice[] = [];
  modelIndex = 0;
  historyIndex = 0;
  candidateIndex = 0;
  tab: "question" | "source" | "scoring" = "question";
  selected: string[] = [];
  excluded: string[] = [];
  input = "";
  message = "先配置搜索服务和模型，再输入搜题要求。";
  busy = false;
  draft?: DraftDataset;
  publishedId?: string;
  reviewer = "";
  reviewReason = "";
  includeScoring = false;
  searchVerified = false;
  modelVerified = false;
  private confirmation?: Confirmation;
  private searchSecret?: string;
  private readonly modelSecrets = new Map<string, string>();
  private pending?: Promise<void>;
  private probeAbort?: AbortController;
  private readonly observers = new Set<() => void>();
  readonly service: CollectionService;
  private readonly importer: ImportService;

  constructor(private readonly options: CollectionWorkspaceOptions) {
    const path = join(options.importRoot, "collection-settings.json");
    this.config = existsSync(path) ? CollectionConfigSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : CollectionConfigSchema.parse({
      datasetId: "collected", profileId: "unselected", modelId: "unselected", apiKeyEnv: "ANYSEARCH_API_KEY", limits: { maxTotalTokens: 50000 },
    });
    assertNoCredentials(this.config, "collection settings");
    this.importer = new ImportService(options.datasetsRoot, options.importRoot);
    this.service = new CollectionService(options.importRoot, options.datasetsRoot, (config) => this.client(config), () => this.modelSecrets.get(this.modelKey()));
    this.service.subscribe(() => {
      if (this.session) this.session = this.service.get(this.session.id);
      this.emit();
    });
  }
  subscribe(observer: () => void): () => void { this.observers.add(observer); return () => this.observers.delete(observer); }
  private emit(): void { for (const observer of this.observers) observer(); }
  private modelKey(): string { return `${this.config.profileId}/${this.config.modelId}`; }
  private client(config = this.config): AnySearchClient {
    const getApiKey = () => config.apiKeyEnv === MEMORY_SEARCH ? this.searchSecret : undefined;
    return this.options.client?.(config, getApiKey) ?? new AnySearchClient({ apiKeyEnv: config.apiKeyEnv, getApiKey, timeoutMs: config.limits.requestTimeoutMs });
  }
  redact(text: string): string {
    for (const key of [this.searchSecret, ...this.modelSecrets.values()]) if (key) text = text.split(key).join("[密钥已隐藏]");
    return text;
  }
  open(): void {
    if (this.session) this.session = this.service.get(this.session.id);
    if (this.draft) this.draft = this.importer.getDraft(this.draft.draftId);
    if (this.draft?.status === "confirmed") this.publishedId = this.draft.version === "1" ? this.draft.datasetId : `${this.draft.datasetId}.v${this.draft.version}`;
    this.emit();
  }
  private editable(): void {
    if (this.busy) throw new Error("请求进行中，停止后才能修改配置。");
    if (this.session) throw new Error("当前会话配置已固定；请新建会话后修改，旧记录保留。");
  }
  credentials() {
    const mode = !this.config.apiKeyEnv ? "匿名" : this.config.apiKeyEnv === MEMORY_SEARCH ? "本次会话" : "环境变量";
    const searchReady = mode === "匿名" || (mode === "本次会话" ? !!this.searchSecret : !!process.env[this.config.apiKeyEnv!]);
    const registry = this.options.registry(this.config), profile = registry.profilesById.get(this.config.profileId);
    return { mode, searchReady, modelReady: !!this.modelSecrets.get(this.modelKey()) || !!profile?.auth.envVars.some((name) => !!process.env[name]),
      modelEnv: profile?.auth.envVars.join(" / ") ?? "请先选择模型", searchEnv: this.config.apiKeyEnv ?? "无需 Key" };
  }
  setSecret(kind: "search" | "model", value: string): void {
    if (this.busy) throw new Error("运行期间不能更换密钥。");
    if (!value.trim() || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error("密钥不能为空或包含空白及控制字符。");
    if (kind === "search") {
      if (this.session && this.config.apiKeyEnv !== MEMORY_SEARCH) throw new Error("当前搜索身份已固定，请新建会话后更换身份。");
      this.searchSecret = value; this.config = { ...this.config, apiKeyEnv: MEMORY_SEARCH }; this.searchVerified = false;
    } else {
      if (this.config.profileId === "unselected") throw new Error("请先选择搜题模型。");
      this.modelSecrets.set(this.modelKey(), value); this.modelVerified = false;
    }
    this.message = "密钥仅供本次进程使用，关闭程序后需重新配置。"; this.emit();
  }
  setSearchMode(mode: "environment" | "anonymous"): void {
    this.editable(); this.config = { ...this.config, apiKeyEnv: mode === "environment" ? "ANYSEARCH_API_KEY" : undefined };
    this.searchVerified = false; this.message = mode === "anonymous" ? "已选择匿名访问，服务配额可能较低。" : "使用 ANYSEARCH_API_KEY 环境变量。"; this.emit();
  }
  setField(field: string, text: string): void {
    if (field === "reviewer" || field === "reviewReason") { if (this.busy) throw new Error("请先等待运行结束。"); this[field] = text; return; }
    this.editable();
    if (field === "datasetId" || field === "version") this.config = CollectionConfigSchema.parse({ ...this.config, [field]: text.trim() });
    else if (field === "targetCount") this.config = CollectionConfigSchema.parse({ ...this.config, targetCount: Number(text) });
    else {
      if (!text.trim() || !Number.isSafeInteger(Number(text)) || Number(text) <= 0) throw new Error("请输入正整数。");
      const allowed = ["maxTotalTokens", "maxSearchRequests", "maxExtractRequests", "maxOutputTokens", "maxCandidates", "maxModelRequests", "requestTimeoutMs", "turnTimeoutMs"];
      if (!allowed.includes(field)) throw new Error("不支持的搜题设置。");
      const count = Number(text);
      if (field.endsWith("Ms") && count > 2147483) throw new Error("时间不能超过 2147483 秒。");
      this.config = CollectionConfigSchema.parse({ ...this.config, limits: { ...this.config.limits, [field]: field.endsWith("Ms") ? count * 1000 : count } });
    }
    this.emit();
  }
  savePreferences(): void {
    assertNoCredentials(this.config, "collection preferences");
    writeJsonAtomic(join(this.options.importRoot, "collection-settings.json"), this.config);
    this.message = "已保存模型选择、预算和凭据引用；密钥只在本次进程中使用。"; this.emit();
  }
  chooseModels(): void { this.editable(); this.modelChoices = this.options.models(); this.modelIndex = 0; this.page = "models"; this.emit(); }
  selectModel(index = this.modelIndex): void {
    this.editable(); const choice = this.modelChoices[index]; if (!choice) throw new Error("没有可选择的模型。");
    this.config = { ...this.config, profileId: choice.profileId, modelId: choice.modelId, thinkingLevel: "off" }; this.modelVerified = false; this.page = "settings"; this.emit();
  }
  cycleThinking(): void {
    this.editable(); const model = resolveModel(this.options.registry(this.config), this.config.profileId, this.config.modelId);
    if (!model) throw new Error("请先选择模型。"); const levels = getSupportedThinkingLevels(model);
    this.config = { ...this.config, thinkingLevel: levels[(levels.indexOf(this.config.thinkingLevel) + 1) % levels.length]! }; this.emit();
  }
  newConversation(): void {
    if (this.busy) throw new Error("先停止当前请求，再新建搜题会话。");
    this.session = undefined; this.selected = []; this.excluded = []; this.draft = undefined; this.publishedId = undefined;
    this.input = ""; this.confirmation = undefined; this.includeScoring = false; this.page = "chat"; this.message = "新会话尚未发送请求，旧会话仍可在历史中查看。"; this.emit();
  }
  history(): void { this.sessions = this.service.list(); this.historyIndex = 0; this.page = "history"; this.emit(); }
  openHistory(index = this.historyIndex): void {
    if (this.busy) throw new Error("请先停止正在运行的会话。");
    const saved = this.sessions[index]; if (!saved) throw new Error("没有所选搜题会话。");
    this.session = this.service.get(saved.id); this.config = this.session.config; this.input = ""; this.selected = []; this.excluded = [];
    this.draft = undefined; this.publishedId = undefined; this.page = "chat"; this.message = "已读取历史会话；没有自动发送请求。"; this.emit();
  }
  candidates(): void { if (!this.session) throw new Error("还没有搜题材料。"); this.page = "candidates"; this.candidateIndex = 0; this.emit(); }
  toggleCandidate(): void {
    const candidate = this.session?.candidates[this.candidateIndex]; if (!candidate) throw new Error("没有所选候选题。");
    if (candidate.issues.length) throw new Error(candidate.issues.join("；"));
    if (this.excluded.includes(candidate.question.id)) throw new Error("此题已排除，请先恢复后再选择。");
    const id = candidate.question.id; this.selected = this.selected.includes(id) ? this.selected.filter((item) => item !== id) : [...this.selected, id]; this.emit();
  }
  excludeCandidate(): void {
    const candidate = this.session?.candidates[this.candidateIndex]; if (!candidate) throw new Error("没有所选候选题。");
    const id = candidate.question.id; this.excluded = this.excluded.includes(id) ? this.excluded.filter((item) => item !== id) : [...this.excluded, id];
    this.selected = this.selected.filter((item) => item !== id); this.message = "排除只影响本次组卷，原始候选和来源继续保留。"; this.emit();
  }
  prepare(kind: Confirmation["kind"], input = this.input): void {
    if (this.busy) throw new Error("请等待或停止当前请求。");
    if (kind === "searchProbe" && !this.credentials().searchReady) throw new Error("请先输入搜索 Key，或明确选择匿名模式。");
    if (kind === "modelProbe" && !resolveModel(this.options.registry(this.config), this.config.profileId, this.config.modelId)) throw new Error("请先选择搜题模型。");
    if (kind === "send") {
      if (!input.trim()) throw new Error("请输入搜题要求或继续对话的内容。"); assertNoCredentials(input, "collection message");
      const model = resolveModel(this.options.registry(this.config), this.config.profileId, this.config.modelId); if (!model) throw new Error("请先在配置中选择搜题模型。");
      if (!this.credentials().searchReady) throw new Error("请配置搜索 Key，或明确选择匿名模式。");
      if (!this.credentials().modelReady && model.api !== "faux") throw new Error("请配置搜题模型 Key。");
      if (this.session && !["ready", "stopped"].includes(this.session.state)) throw new Error("该会话已暂停或结果未知，请检查记录，不自动重发。");
      if (this.session && this.session.workflowVersion !== COLLECTION_WORKFLOW_VERSION) throw new Error("旧版会话保留供核对和组卷，请新建会话使用当前搜题流程。");
    }
    if (kind === "stage" && (!this.session || !this.selected.some((id) => !this.excluded.includes(id)))) throw new Error("请先选择要组卷的候选题。");
    if (kind === "stage" && this.includeScoring && (!this.reviewer.trim() || !this.reviewReason.trim())) throw new Error("采用评分建议需要填写核对人与核对依据。");
    if (kind === "publish" && !this.draft) throw new Error("还没有待发布草稿。");
    this.confirmation = { kind, digest: this.digest(), input, parent: this.page }; this.page = "confirm"; this.emit();
  }
  confirmationDetails(): string[] {
    const confirmation = this.confirmation; if (!confirmation) return [];
    const registry = this.options.registry(this.config), model = resolveModel(registry, this.config.profileId, this.config.modelId);
    const budget = this.session ? this.service.budget(this.session.id) : null;
    if (confirmation.kind === "stage") return ["生成待核对草稿", `题目：${this.selected.filter((id) => !this.excluded.includes(id)).join("、")}`,
      this.includeScoring ? `采用评分建议 · 核对人 ${this.reviewer} · ${this.reviewReason}` : "评分建议留在来源中，草稿暂不计分。", "生成草稿后仍需单独确认入库。"];
    if (confirmation.kind === "publish") return ["确认发布题集", `${this.draft?.datasetId} · ${this.draft?.questions.length} 题`, "已有版本不会被覆盖，来源及修改历史保留。"];
    if (confirmation.kind === "searchProbe") return ["验证 AnySearch 连接", "https://api.anysearch.com/v1/sub-domains", `访问身份：${this.credentials().mode}`, "发送 1 次领域查询，可能消耗搜索服务配额。"];
    return [confirmation.kind === "modelProbe" ? "验证模型连接 · 1 次请求，无搜索工具" : "确认发送搜题消息", `模型：${this.config.profileId} / ${this.config.modelId}`,
      `接口：${model?.baseUrl || registry.profilesById.get(this.config.profileId)?.baseUrl || "未选择"}`, `推理：${confirmation.kind === "modelProbe" ? "off" : this.config.thinkingLevel}`,
      confirmation.kind === "modelProbe" ? "输出最多 128 Token，整体最多 30 秒；费用未核实。" : `Token 剩余额度：${budget?.remainingTokens ?? this.config.limits.maxTotalTokens} · 搜索上限 ${this.config.limits.maxSearchRequests} · 提取上限 ${this.config.limits.maxExtractRequests}`,
      ...(confirmation.kind === "send" ? [`目标题数：${this.config.targetCount ?? "未指定，按对话要求"}；候选上限：${this.config.limits.maxCandidates}`, confirmation.input ?? "", "模型与搜索服务可能计费；未知结果不会自动重发。"] : [])];
  }
  private digest(): string { return sha256OfJsonable({ config: this.config, session: this.session, selected: this.selected, excluded: this.excluded, reviewer: this.reviewer, reason: this.reviewReason, includeScoring: this.includeScoring, draft: this.draft }); }
  confirm(): Promise<void> {
    const confirmation = this.confirmation;
    if (!confirmation || this.busy) throw new Error("没有有效的待确认操作。");
    if (this.session) this.session = this.service.get(this.session.id);
    if (this.draft) this.draft = this.importer.getDraft(this.draft.draftId);
    if (confirmation.digest !== this.digest()) throw new Error("配置或材料已变化，请重新检查并确认。");
    this.confirmation = undefined;
    if (confirmation.kind === "stage") {
      this.draft = this.service.stage(this.session!.id, this.selected.filter((id) => !this.excluded.includes(id)), sha256OfJsonable(this.session),
        this.includeScoring ? { by: this.reviewer, reason: this.reviewReason } : undefined);
      this.page = "publish"; this.message = "草稿已生成，可以逐题编辑；尚未入库。"; this.emit(); return Promise.resolve();
    }
    this.busy = true; this.page = confirmation.kind === "publish" ? "publish" : "chat"; this.emit();
    const operation = async () => {
      if (confirmation.kind === "publish") {
        const result = await this.importer.confirmDraft(this.draft!.draftId); this.publishedId = result.datasetId;
        this.draft = this.importer.getDraft(this.draft!.draftId); this.message = `已入库 ${result.datasetId}，可进入创建测评。`; return;
      }
      this.probeAbort = new AbortController();
      if (confirmation.kind === "searchProbe") {
        await this.client().getSubDomains(["academic"], this.probeAbort.signal); this.searchVerified = true; this.message = "AnySearch 连接验证通过；剩余配额未知。"; return;
      }
      const registry = this.options.registry(this.config);
      if (confirmation.kind === "modelProbe") {
        const result = await this.service.checkModel(this.config, registry, { authorisePaid: true }, this.probeAbort.signal);
        this.modelVerified = !!result.ok; this.message = result.ok ? "模型连接验证通过；工具调用能力仍需实际搜题验证。" : "模型验证未成功；没有自动重试。"; return;
      }
      if (!this.session) this.session = this.service.create(confirmation.input!, this.config, registry);
      this.input = "";
      this.session = await this.service.respond(this.session.id, confirmation.input!, registry, { authorisePaid: true });
      const progress = this.progress();
      this.message = this.session.error ?? (progress ? `${progress.targetReached ? "目标题数已达到。" : progress.remaining === null ? "本次对话结束。" : `还缺 ${progress.remaining} 题。`}${progress.next}` : "请求已停止，已有材料保留。");
    };
    this.pending = operation().catch((error) => { this.message = confirmation.kind === "searchProbe" || confirmation.kind === "modelProbe" ? "连接验证失败，请检查地址、密钥或配额；没有自动重试。" : this.redact(error instanceof Error ? error.message : String(error)); })
      .finally(() => { this.busy = false; this.pending = undefined; this.probeAbort = undefined; this.emit(); });
    return this.pending;
  }
  stop(): void { this.probeAbort?.abort(); if (this.session) this.service.cancel(this.session.id); this.message = "已请求停止，等待存档。"; this.emit(); }
  async stopAndWait(): Promise<void> { this.stop(); await this.pending; this.service.flush(); }
  back(): boolean {
    if (this.page === "confirm") { this.page = this.confirmation?.parent ?? "chat"; this.confirmation = undefined; }
    else if (this.page === "candidate") this.page = "candidates";
    else if (this.page === "models") this.page = "settings";
    else if (this.page !== "chat") this.page = "chat";
    else return false;
    this.emit(); return true;
  }
  metrics() { return summarizeRequests(this.session?.metrics?.requests ?? []); }
  progress() { return this.session ? collectionProgress(this.session) : null; }
  live() { const live = this.session ? this.service.live(this.session.id) : { activity: this.busy ? "连接验证中" : "等待输入", text: "" }; return { ...live, text: this.redact(live.text) }; }
}
