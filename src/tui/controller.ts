/**
 * TUI controller (TUI-1). A testable state machine that drives the full exam
 * flow and consumes the TaskControlService + dataset/provider modules. Per
 * AGENTS.md §3 the UI holds NO business logic: this controller orchestrates, the
 * service runs/grades/archives, and the pi-tui view only renders state + keys.
 *
 * Model selection is two-level (provider -> model) over pi's built-in provider
 * catalog MERGED with our custom endpoints (see providers/pi-catalog.ts).
 *
 * Next_Plan §1/§4: the app opens on an intro (skippable, toggleable) then a HOME
 * screen with slash-command navigation across 首页/题库/创建测评/任务/成绩/人工复核/设置.
 * Next_Plan §3/§6: 题库 + 导入 drive the ImportService (draft staging -> confirm).
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AnswerMode, Capability, ThinkingLevel } from "../shared/contracts.js";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { importDataset } from "../dataset/import.js";
import { mediaTypeForRef } from "../dataset/parse.js";
import { loadModelsConfig } from "../providers/models-config.js";
import { createMergedRegistry, listProviderGroups, synthesizeBuiltinProfile, type ProviderGroup } from "../providers/pi-catalog.js";
import { createRegistry, resolveModel, type Registry } from "../providers/pi-adapter.js";
import { ImportService, type DraftDataset, type DraftQuestionReview, type DraftEditField } from "../import/import-service.js";
import { loadQuestionImage, openQuestionImage, type QuestionImage } from "../service/question-image.js";
import { TaskControlService, type TaskDetail, type TaskSummary } from "../service/task-service.js";
import { ReviewService, type ReviewQueueItem } from "../service/review-service.js";
import type { ModeReport } from "../reporting/report.js";
import type { TaskEvent } from "../runner/task-events.js";
import { readManifest } from "../runner/answer-source.js";
import { shortDigest } from "../shared/hashing.js";
import { BatchTokenLimitSchema } from "../runner/batch-budget.js";
import type { RecoveryDecision } from "../runner/recovery.js";
import { JudgeService, type JudgePlan, type CalibrationReport } from "../service/judge-service.js";
import { defaultJudgeDraft, JudgeConfigSchema, readJudgeConfig, saveJudgeConfig, type JudgeDraft, type JudgeConfig } from "../grading/judge-config.js";
import { CollectionWorkspace } from "./collection-controller.js";
import { ChatWorkspace } from "./chat-controller.js";
import type { CollectionConfig } from "../shared/collection.js";
import type { AnySearchClient } from "../providers/anysearch.js";

export type { ProviderGroup } from "../providers/pi-catalog.js";

const STOP_PENDING = "已请求停止，等待进行中的请求结束并保存记录。";

export interface ExamTuiConfig {
  chatRoot?: string;
  collectionClient?: (config: CollectionConfig, getApiKey: () => string | undefined) => AnySearchClient;
  judgeConfigPath?: string;
  datasetsRoot: string;
  modelsConfigPath: string;
  runsRoot: string;
  workRoot: string;
  toolsVersion: string;
  pythonInterpreter: string;
  limitsPath?: string;
  requestTimeoutMs?: number;
  registryOverride?: Registry; // tests inject faux
  offlineDemo?: { sourcePath: string; registry: Registry };
  /** Real (paid) runs require this; a faux registryOverride (tests) is exempt. */
  authorisePaid?: boolean;
  /** Play the intro animation (Next_Plan §2). Default true; toggle in 设置. */
  animation?: boolean;
  /** Staging root for import drafts (Next_Plan §3). Default ".import". */
  importRoot?: string;
}

export interface DatasetInfo {
  id: string;
  dir: string;
}

export interface CheckReport {
  datasetId: string;
  total: number;
  confirmed: number;
  errors: Array<{ questionId: string; errors: string[] }>;
  missingImages: string[];
  missingScoring: string[];
  plannedMax: number;
  byAnswerKind: Record<string, number>;
}

/** A single model row (kept for compatibility with older callers/tests). */
export interface ModelOption {
  profileId: string;
  modelId: string;
  provider: string;
  baseUrl: string;
  api: string;
  capability: Capability;
}

export interface Setup {
  batchTokenLimit?: number;
  profileId: string; // provider id (custom profile id OR pi built-in provider id)
  modelId: string;
  mode: AnswerMode | "both";
  thinkingLevel?: ThinkingLevel;
  concurrency: number; // 同时答题数
  apiConcurrency?: number; // 同时 API 请求数 (undefined = no request scheduler)
}

/** 顶层操作由 `/` 命令转发，业务入口继续共用 controller。 */
export type NavSection = "home" | "bank" | "create" | "tasks" | "scores" | "review" | "settings";

export interface HomeScreen { kind: "home"; datasets: DatasetInfo[]; tasks: TaskSummary[]; pendingReview: number }
export interface ReviewScreen { kind: "review"; runId: string; mode: AnswerMode; items: ReviewQueueItem[]; index: number; score: number | null; confirmer: string; reason: string; confirming: boolean; calibrationParent?: CalibrationScreen }
export interface CalibrationScreen { kind: "calibration"; runId: string; candidates: Awaited<ReturnType<JudgeService["calibrationCandidates"]>>;
  selected: string[]; index: number; report?: CalibrationReport; by: string; reason: string; confirming: boolean; judgeIssue?: string }

export type Screen =
  | { kind: "opening"; home?: HomeScreen }
  | HomeScreen
  | { kind: "settings"; animation: boolean }
  | { kind: "collection" }
  | { kind: "chat" }
  | { kind: "judge"; draft: JudgeDraft; groups: ProviderGroup[]; stage: "config" | "provider" | "model"; providerIndex: number; modelIndex: number }
  | { kind: "judgeConfirm"; plan: JudgePlan; parent: ReviewScreen | CalibrationScreen }
  | { kind: "judgeRun"; jobId: string; plan: JudgePlan; parent: ReviewScreen | CalibrationScreen }
  | CalibrationScreen
  | { kind: "calibrationSample"; parent: CalibrationScreen; sample: Awaited<ReturnType<JudgeService["calibrationSample"]>>;
      tab: "question" | "answer" | "basis" | "comparison"; image?: QuestionImage; imageIndex?: number }
  | { kind: "bank"; datasets: Array<{ datasetId: string; questions: number }>; drafts: DraftDataset[] }
  | { kind: "importPreview"; draft: DraftDataset }
  | { kind: "draftQuestion"; review: DraftQuestionReview; tab: "compare" | "source" | "model" | "scoring" | "issues" }
  | { kind: "draftImage"; review: DraftQuestionReview; assetIndex: number; image: QuestionImage }
  | { kind: "datasets" }
  | { kind: "check"; report: CheckReport }
  | { kind: "setup"; groups: ProviderGroup[]; providerIndex: number; setup: Setup }
  | { kind: "pickmodel"; group: ProviderGroup; modelIndex: number; setup: Setup }
  | { kind: "confirm"; setup: Setup; resume?: Awaited<ReturnType<TaskControlService["prepareResume"]>>; recoveryDecision?: RecoveryDecision }
  | { kind: "exceptions"; runId: string; data: Awaited<ReturnType<TaskControlService["getExceptions"]>>; index: number; by: string; reason: string }
  | { kind: "usage"; runId: string; requestId: string; total: number | null; by: string; reason: string; confirming: boolean }
  | { kind: "run"; taskId: string }
  | { kind: "tasks"; tasks: TaskSummary[] }
  | { kind: "detail"; runId: string; detail: TaskDetail }
  | { kind: "report"; runId: string; mode: AnswerMode; report: ModeReport }
  | ReviewScreen
  | { kind: "reviewImage"; parent: ReviewScreen; assetIndex: number; image: QuestionImage };

export interface TuiState {
  screen: Screen;
  datasets: DatasetInfo[];
  selectedDataset?: string;
  taskId?: string;
  events: TaskEvent[];
  message?: string;
}

export class ExamTui {
  private state: TuiState;
  private readonly service: TaskControlService;
  private readonly importer: ImportService;
  private activeTaskId?: string;
  private activeJudgeId?: string;
  private lastJudgeScreen?: Extract<Screen, { kind: "judgeRun" }>;
  private readonly judge: JudgeService;
  private animation: boolean;
  private collection?: CollectionWorkspace;
  private chat?: ChatWorkspace;
  private collectionDraftId?: string;
  /** P2: run dir per mode for the current task (each mode is its own run dir). */
  private runIdsByMode = new Map<AnswerMode, string>();

  constructor(private readonly cfg: ExamTuiConfig, service?: TaskControlService) {
    this.service = service ?? new TaskControlService();
    this.judge = new JudgeService(cfg.runsRoot);
    this.importer = new ImportService(cfg.datasetsRoot, cfg.importRoot ?? ".import");
    this.animation = cfg.animation ?? true;
    // Default to datasets so direct/tested interaction works without begin();
    // runExamTui calls begin() to enter the intro (or home when animation is off).
    this.state = { screen: { kind: "datasets" }, datasets: [], events: [] };
  }

  getState(): TuiState {
    return this.state;
  }

  get demoSource(): string | undefined { return this.cfg.offlineDemo?.sourcePath; }

  /** 当前入口配置的工具版本（确认页展示 with_tool 能力用）。 */
  get toolsVersion(): string { return this.cfg.toolsVersion; }

  getService(): TaskControlService {
    return this.service;
  }
  getJudgeService(): JudgeService { return this.judge; }
  getChatWorkspace(): ChatWorkspace {
    if (!this.chat) this.chat = new ChatWorkspace({
      root: this.cfg.chatRoot ?? join(dirname(this.cfg.runsRoot), "chats"), registry: (config) => this.registryFor(config),
      models: () => this.cfg.registryOverride ? [...this.cfg.registryOverride.profilesById.values()].flatMap((profile) => profile.models.map((model) => ({
        profileId: profile.id, modelId: model.id, label: `${profile.displayName} / ${model.name}`, ready: profile.api === "faux" || profile.auth.envVars.some((name) => !!process.env[name]),
      }))) : this.loadModelGroups().flatMap((group) => group.models.map((model) => ({ profileId: model.profileId, modelId: model.modelId, label: `${group.displayName} / ${model.displayName}`, ready: group.runnable }))),
    });
    return this.chat;
  }
  openChat(input?: string): void {
    if (this.cfg.offlineDemo) throw new Error("离线演示仅提供测评。普通聊天请使用 npm run tui。");
    const workspace = this.getChatWorkspace();
    if (input) workspace.input = input;
    this.state = { ...this.state, screen: { kind: "chat" }, message: undefined };
    workspace.open();
    if (input) { workspace.input = input; void workspace.submit(input).catch((error) => workspace.fail(error)); }
  }
  openChatModels(): void { this.openChat(); this.getChatWorkspace().chooseModels(); }
  async stopChatAndWait(): Promise<void> { await this.chat?.stopAndWait(); }
  getCollectionWorkspace(): CollectionWorkspace {
    if (!this.collection) this.collection = new CollectionWorkspace({
      importRoot: this.cfg.importRoot ?? ".import", datasetsRoot: this.cfg.datasetsRoot,
      registry: (config) => this.registryFor(config), client: this.cfg.collectionClient,
      models: () => {
        if (this.cfg.registryOverride) return [...this.cfg.registryOverride.profilesById.values()].flatMap((profile) => profile.models.map((model) => ({
          profileId: profile.id, modelId: model.id, label: `${profile.displayName} / ${model.name}`, baseUrl: profile.baseUrl,
        })));
        return this.loadModelGroups().flatMap((group) => group.models.map((model) => ({
          profileId: model.profileId,
          modelId: model.modelId, label: `${group.displayName} / ${model.displayName}`, baseUrl: model.baseUrl ?? "",
        })));
      },
    });
    return this.collection;
  }
  openCollection(): void {
    if (this.cfg.offlineDemo) throw new Error("离线演示使用随附题包。联网搜题请使用 npm run tui。");
    this.getCollectionWorkspace().open(); this.state = { ...this.state, screen: { kind: "collection" }, message: undefined };
  }
  editCollectionDraft(draftId: string): void { this.collectionDraftId = draftId; this.previewDraft(draftId); }
  closeImportPreview(): void {
    const screen = this.state.screen;
    if (screen.kind === "importPreview" && screen.draft.draftId === this.collectionDraftId) this.openCollection();
    else this.gotoBank();
  }

  getImporter(): ImportService {
    return this.importer;
  }

  setMessage(message: string): void {
    this.state = { ...this.state, message };
  }

  animationEnabled(): boolean {
    return this.animation;
  }

  /** Called once datasets are loaded: show the intro (if enabled) or go home. */
  async begin(): Promise<void> {
    await this.gotoHome();
    if (this.animation) {
      const home = this.state.screen;
      if (home.kind !== "home") throw new Error("首页初始化未完成。");
      this.state = { ...this.state, screen: { kind: "opening", home } };
    }
  }

  // ── home / intro / settings / navigation (Next_Plan §1/§4) ─────────────────
  async gotoHome(): Promise<void> {
    const datasets = this.loadDatasets();
    const allTasks = this.service.listTasks(this.cfg.runsRoot);
    const tasks = allTasks.slice(0, 6);
    let pendingReview = 0;
    const latest = allTasks[0];
    if (latest) {
      try {
        const sel = this.service.resolveRunMode(this.cfg.runsRoot, latest.runId);
        pendingReview = (await this.reviewService(sel.runId).getQueue(sel.runId, sel.mode)).length;
      } catch {
        pendingReview = 0;
      }
    }
    this.state = { ...this.state, datasets, message: undefined, screen: { kind: "home", datasets, tasks, pendingReview } };
  }

  gotoSettings(): void {
    this.state = { ...this.state, message: undefined, screen: { kind: "settings", animation: this.animation } };
  }

  toggleAnimation(): void {
    this.animation = !this.animation;
    const s = this.state.screen;
    if (s.kind === "settings") this.state = { ...this.state, screen: { kind: "settings", animation: this.animation } };
  }

  /** Jump to a fixed navigation section. */
  async nav(section: NavSection): Promise<void> {
    switch (section) {
      case "home":
        await this.gotoHome();
        break;
      case "bank":
        this.gotoBank();
        break;
      case "create":
        this.gotoDatasets();
        break;
      case "tasks":
        await this.openTasks();
        break;
      case "settings":
        this.gotoSettings();
        break;
      case "scores":
      case "review": {
        const latest = this.service.listTasks(this.cfg.runsRoot)[0];
        if (!latest) {
          await this.gotoHome();
          this.setMessage("暂无历史任务；请先创建一个测评。");
          return;
        }
        if (section === "scores") await this.openReport(latest.runId);
        else await this.openReview(latest.runId);
        break;
      }
    }
  }

  // ── import + question bank (Next_Plan §3/§6) ───────────────────────────────
  /** 题库: confirmed datasets + staged import drafts. */
  gotoBank(): void {
    this.collectionDraftId = undefined;
    const datasets = this.importer.listBank();
    const drafts = this.importer.listDrafts();
    this.state = { ...this.state, message: undefined, screen: { kind: "bank", datasets, drafts } };
  }

  /** Import a source file/folder into a staged draft -> preview screen. */
  startImport(sourcePath: string, datasetId?: string, version = "1"): void {
    try {
      const id = (datasetId ?? deriveDatasetId(sourcePath)).slice(0, 60);
      const draft = this.importer.importSource(sourcePath, { datasetId: id, version });
      this.state = { ...this.state, message: undefined, screen: { kind: "importPreview", draft } };
    } catch (error) {
      this.state = { ...this.state, message: `导入失败：${(error as Error).message}` };
    }
  }

  /** Open a staged draft's preview (review -> confirm/discard). */
  previewDraft(draftId: string): void {
    const draft = this.importer.getDraft(draftId);
    if (!draft) {
      this.state = { ...this.state, message: `草稿不存在：${draftId}` };
      return;
    }
    this.state = { ...this.state, message: undefined, screen: { kind: "importPreview", draft } };
  }

  openDraftQuestion(draftId: string, index: number): void {
    const review = this.importer.reviewQuestion(draftId, index);
    const tab = this.state.screen.kind === "draftQuestion" ? this.state.screen.tab : "compare";
    this.state = { ...this.state, message: undefined, screen: { kind: "draftQuestion", review, tab } };
  }

  setDraftTab(tab: Extract<Screen, { kind: "draftQuestion" }>["tab"]): void {
    const s = this.state.screen;
    if (s.kind === "draftQuestion") this.state = { ...this.state, screen: { ...s, tab } };
  }

  saveDraftQuestion(field: DraftEditField, text: string): void {
    const s = this.state.screen;
    if (s.kind !== "draftQuestion") throw new Error("请先打开草稿题目。");
    const review = this.importer.editQuestion(s.review.draft.draftId, s.review.index, s.review.digest, field, text);
    this.state = { ...this.state, screen: { ...s, review }, message: review.check.ok ? "草稿已保存，尚未入库。" : "草稿已保存；仍有校验问题，请核对后再入库。" };
  }

  async openDraftImage(draftId: string, index: number, assetIndex?: number): Promise<void> {
    const review = this.importer.reviewQuestion(draftId, index);
    const selected = assetIndex ?? review.draft.questions[index]!.assets?.findIndex((asset) => !!mediaTypeForRef(asset.ref)) ?? -1;
    if (selected < 0) throw new Error("该题没有可核对的图片附件。");
    const asset = this.importer.reviewAsset(draftId, index, selected);
    const image = await loadQuestionImage(asset.path, asset.ref);
    this.state = { ...this.state, message: undefined, screen: { kind: "draftImage", review, assetIndex: selected, image } };
  }

  async nextDraftImage(step: number): Promise<void> {
    const s = this.state.screen;
    if (s.kind !== "draftImage") return;
    const indices = (s.review.draft.questions[s.review.index]!.assets ?? []).flatMap((asset, index) => mediaTypeForRef(asset.ref) ? [index] : []);
    const target = indices[Math.max(0, Math.min(indices.length - 1, indices.indexOf(s.assetIndex) + step))];
    if (target === undefined) throw new Error("该题没有可核对的图片附件。");
    await this.openDraftImage(s.review.draft.draftId, s.review.index, target);
  }

  async openOriginalImage(): Promise<void> {
    const s = this.state.screen;
    if (s.kind === "reviewImage") {
      const item = s.parent.items[s.parent.index]!;
      const fresh = await this.reviewService(s.parent.runId).loadImage(s.parent.runId, s.parent.mode, item.trialId, s.assetIndex, item.reviewToken ?? "", !!s.parent.calibrationParent);
      if (fresh.path !== s.image.path || fresh.digest !== s.image.digest) throw new Error("复核图片已变化，请重新打开复核队列。");
      await openQuestionImage(s.image);
      this.state = { ...this.state, message: "已请求系统查看器打开原图；终端缩略图不用于核对细小文字。" };
      return;
    }
    if (s.kind !== "draftImage") return;
    // 打开前再次检查草稿来源和附件路径，不能沿用已经变化的引用。
    const asset = this.importer.reviewAsset(s.review.draft.draftId, s.review.index, s.assetIndex);
    if (asset.path !== s.image.path) throw new Error("附件引用已变化，请重新打开核对页面。");
    await openQuestionImage(s.image);
    this.state = { ...this.state, message: "已请求系统查看器打开原图；终端缩略图不用于核对细小文字。" };
  }

  async confirmImport(): Promise<void> {
    const s = this.state.screen;
    if (s.kind !== "importPreview") return;
    try {
      const res = await this.importer.confirmDraft(s.draft.draftId);
      this.state = { ...this.state, message: `已入库 ${res.datasetId}：${res.questions} 题（${res.scored} 题有评分依据）。`, screen: { kind: "bank", datasets: this.importer.listBank(), drafts: this.importer.listDrafts() } };
    } catch (error) {
      this.state = { ...this.state, message: `确认入库失败：${(error as Error).message}` };
    }
  }

  discardImport(): void {
    const s = this.state.screen;
    if (s.kind !== "importPreview") return;
    this.importer.discardDraft(s.draft.draftId);
    this.gotoBank();
  }

  /** Confirm a draft directly from the bank list. */
  async confirmDraft(draftId: string): Promise<void> {
    try {
      const res = await this.importer.confirmDraft(draftId);
      this.state = { ...this.state, message: `已入库 ${res.datasetId}：${res.questions} 题。`, screen: { kind: "bank", datasets: this.importer.listBank(), drafts: this.importer.listDrafts() } };
    } catch (error) {
      this.state = { ...this.state, message: `确认入库失败：${(error as Error).message}` };
    }
  }

  discardDraft(draftId: string): void {
    this.importer.discardDraft(draftId);
    this.gotoBank();
  }

  /** Scan datasets/ for dirs containing public/ + scoring/. */
  loadDatasets(): DatasetInfo[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.cfg.datasetsRoot);
    } catch {
      names = [];
    }
    const out: DatasetInfo[] = [];
    for (const name of names.sort()) {
      const dir = join(this.cfg.datasetsRoot, name);
      if (existsSync(join(dir, "public")) && existsSync(join(dir, "scoring"))) out.push({ id: name, dir });
    }
    this.state = { ...this.state, datasets: out };
    return out;
  }

  /** Import + check a dataset (missing images, broken stems, missing scoring). */
  async checkDataset(datasetId: string): Promise<CheckReport> {
    const dir = join(this.cfg.datasetsRoot, datasetId);
    const imported = await importDataset({ datasetId, publicDir: join(dir, "public"), scoringDir: join(dir, "scoring") });
    const errors: CheckReport["errors"] = [];
    const missingImages: string[] = [];
    const missingScoring: string[] = [];
    let total = 0;
    let confirmed = 0;
    let plannedMax = 0;
    const byAnswerKind: Record<string, number> = {};
    for (const e of imported.entries) {
      if (!e.question) {
        if (e.errors.length) errors.push({ questionId: e.questionId, errors: e.errors });
        continue;
      }
      total++;
      byAnswerKind[e.question.answerKind] = (byAnswerKind[e.question.answerKind] ?? 0) + 1;
      if (e.errors.length) errors.push({ questionId: e.questionId, errors: e.errors });
      else {
        confirmed++;
        if (e.scoring) plannedMax += e.scoring.maxScore;
      }
      for (const msg of e.errors) {
        if (/attachment|image|undecodable/i.test(msg)) missingImages.push(e.questionId);
      }
      if (!e.scoring) missingScoring.push(e.questionId);
    }
    const report: CheckReport = { datasetId, total, confirmed, errors, missingImages: [...new Set(missingImages)], missingScoring: [...new Set(missingScoring)], plannedMax, byAnswerKind };
    this.state = { ...this.state, selectedDataset: datasetId, screen: { kind: "check", report } };
    return report;
  }

  /** Provider groups: pi built-in catalog + our custom endpoints. */
  loadModelGroups(): ProviderGroup[] {
    if (this.cfg.offlineDemo) {
      const profiles = [...this.cfg.offlineDemo.registry.profilesById.values()];
      return listProviderGroups({ version: "1", profiles }, false).map((group) => ({ ...group, runnable: true, keyEnv: undefined }));
    }
    return listProviderGroups(loadModelsConfig(this.cfg.modelsConfigPath));
  }

  /** Legacy flat model list (compatibility). */
  loadModels(): ModelOption[] {
    const config = loadModelsConfig(this.cfg.modelsConfigPath);
    const out: ModelOption[] = [];
    for (const profile of config.profiles) {
      for (const m of profile.models) {
        out.push({ profileId: profile.id, modelId: m.id, provider: profile.provider, baseUrl: profile.baseUrl, api: profile.api, capability: profile.capability });
      }
    }
    return out;
  }

  /** Move to the provider-selection screen (defaults to first runnable provider). */
  openSetup(): void {
    const groups = this.loadModelGroups();
    const runnableIdx = groups.findIndex((g) => g.runnable && g.models.length > 0);
    const idx = runnableIdx >= 0 ? runnableIdx : 0;
    const g = groups[idx];
    const firstModel = g?.models[0];
    const mode = this.cfg.offlineDemo ? "both" : "without_tool";
    const setup: Setup = { profileId: firstModel?.profileId ?? "", modelId: firstModel?.modelId ?? "", mode, concurrency: 1 };
    this.state = { ...this.state, screen: { kind: "setup", groups, providerIndex: idx, setup } };
  }

  /** Provider chosen -> show that provider's models. */
  selectProvider(index: number): void {
    const s = this.state.screen;
    if (s.kind !== "setup") return;
    const g = s.groups[index];
    const firstModel = g?.models[0];
    if (!g || !firstModel) return;
    const setup: Setup = { ...s.setup, profileId: firstModel.profileId, modelId: firstModel.modelId };
    this.state = { ...this.state, screen: { kind: "pickmodel", group: g, modelIndex: 0, setup } };
  }

  /** Model chosen -> confirm screen. */
  selectModel(index: number): void {
    const s = this.state.screen;
    if (s.kind !== "pickmodel") return;
    const m = s.group.models[index];
    if (!m) return;
    const setup: Setup = { ...s.setup, profileId: m.profileId, modelId: m.modelId };
    this.state = { ...this.state, screen: { kind: "confirm", setup } };
  }

  /** Highlight a provider in place (setup screen; live preview). */
  highlightProvider(index: number): void {
    const s = this.state.screen;
    if (s.kind !== "setup") return;
    const i = Math.max(0, Math.min(s.groups.length - 1, index));
    const g = s.groups[i];
    const firstModel = g?.models[0];
    const setup: Setup = firstModel ? { ...s.setup, profileId: firstModel.profileId, modelId: firstModel.modelId } : s.setup;
    this.state = { ...this.state, screen: { ...s, providerIndex: i, setup } };
  }

  /** Highlight a model in place (model screen; live preview). */
  highlightModel(index: number): void {
    const s = this.state.screen;
    if (s.kind !== "pickmodel") return;
    const i = Math.max(0, Math.min(s.group.models.length - 1, index));
    const m = s.group.models[i];
    const setup: Setup = m ? { ...s.setup, profileId: m.profileId, modelId: m.modelId } : s.setup;
    this.state = { ...this.state, screen: { ...s, modelIndex: i, setup } };
  }

  /** Model screen -> back to provider list. */
  backToProviders(): void {
    const s = this.state.screen;
    if (s.kind !== "pickmodel") return;
    const groups = this.loadModelGroups();
    const idx = Math.max(0, groups.findIndex((g) => g.providerId === s.group.providerId));
    this.state = { ...this.state, screen: { kind: "setup", groups, providerIndex: idx, setup: s.setup } };
  }

  /** 确认页返回模型列表，保留已选模式和并发设置。 */
  async backToModels(): Promise<void> {
    const s = this.state.screen;
    if (s.kind !== "confirm") return;
    if (s.resume) { await this.openDetail(s.resume.runId); return; }
    const group = this.loadModelGroups().find((item) => item.models.some((model) => model.profileId === s.setup.profileId && model.modelId === s.setup.modelId));
    if (!group) throw new Error("已选择的提供商不再可用，请重新选择。");
    const modelIndex = Math.max(0, group.models.findIndex((item) => item.profileId === s.setup.profileId && item.modelId === s.setup.modelId));
    this.state = { ...this.state, screen: { kind: "pickmodel", group, modelIndex, setup: s.setup } };
  }

  /** Jump straight to confirm (compat / skip model browse). */
  setSetup(setup: Setup): void {
    this.state = { ...this.state, screen: { kind: "confirm", setup } };
  }

  /** Update the current setup in place (stays on the setup/model/confirm screen). */
  adjustSetup(patch: Partial<Setup>): void {
    const s = this.state.screen;
    if (s.kind !== "setup" && s.kind !== "pickmodel" && s.kind !== "confirm") return;
    if (s.kind === "confirm" && s.resume) return;
    const setup: Setup = { ...s.setup, ...patch };
    this.state = { ...this.state, screen: { ...s, setup } };
  }

  private registryFor(setup: Pick<Setup, "profileId" | "modelId">): Registry {
    if (this.cfg.offlineDemo) return this.cfg.offlineDemo.registry;
    const registry = this.cfg.registryOverride ?? createMergedRegistry(loadModelsConfig(this.cfg.modelsConfigPath));
    if (!registry.profilesById.has(setup.profileId)) {
      const profile = synthesizeBuiltinProfile(setup.profileId, setup.modelId);
      if (profile) registry.profilesById.set(profile.id, profile);
    }
    return registry;
  }

  cycleThinking(): void {
    const s = this.state.screen;
    if (s.kind !== "confirm" || s.resume) return;
    const model = resolveModel(this.registryFor(s.setup), s.setup.profileId, s.setup.modelId);
    if (!model) throw new Error("已选模型不可用，请重新选择。");
    const levels = getSupportedThinkingLevels(model);
    if (!levels.length) throw new Error("模型未配置可用的推理等级，请检查模型配置。");
    const index = levels.indexOf(s.setup.thinkingLevel ?? "off");
    this.adjustSetup({ thinkingLevel: levels[(index + 1) % levels.length] });
  }

  async prepareResume(runId: string): Promise<void> {
    const datasetId = this.datasetId(runId);
    const resume = await this.service.prepareResume(this.cfg.runsRoot, runId, join(this.cfg.datasetsRoot, datasetId), datasetId);
    // without_tool 的历史身份恒为 v1，不受当前工具版本影响；仅 with_tool 要求当前版本一致。
    if (resume.manifest.mode === "with_tool" && resume.manifest.toolsVersion !== this.cfg.toolsVersion) throw new Error("当前工具版本与历史任务不一致，不能冒用原版本续跑。");
    const c = resume.config;
    this.state = { ...this.state, selectedDataset: datasetId, message: undefined, screen: { kind: "confirm", resume,
      setup: { profileId: c.profileId, modelId: resume.manifest.modelId, mode: resume.manifest.mode,
        thinkingLevel: c.thinkingLevel, concurrency: c.concurrency, apiConcurrency: c.requestSchedulerLimits?.maxConcurrent,
        batchTokenLimit: c.batchTokenLimit } } };
  }

  setBatchTokenLimit(value: string): void {
    const parsed = value.trim() ? BatchTokenLimitSchema.safeParse(Number(value)) : undefined;
    if (parsed && !parsed.success) throw new Error("整批 Token 上限应为正整数；留空表示不设置上限。");
    const number = parsed?.data;
    this.adjustSetup({ batchTokenLimit: number });
    this.state = { ...this.state, message: undefined };
  }

  async openExceptions(runId: string): Promise<void> {
    const datasetId = this.datasetId(runId);
    const data = await this.service.getExceptions(this.cfg.runsRoot, runId, join(this.cfg.datasetsRoot, datasetId), datasetId);
    this.state = { ...this.state, message: undefined, screen: { kind: "exceptions", runId, data, index: 0, by: "", reason: "" } };
  }

  selectException(step: number): void {
    const s = this.state.screen;
    if (s.kind !== "exceptions") return;
    this.state = { ...this.state, message: undefined, screen: { ...s, index: Math.max(0, Math.min(s.data.items.length - 1, s.index + step)), by: "", reason: "" } };
  }

  setExceptionField(field: "by" | "reason" | "total", value: string): void {
    const s = this.state.screen;
    if (s.kind !== "exceptions" && s.kind !== "usage") return;
    if (field === "total") {
      if (s.kind !== "usage" || !value.trim() || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new Error("请输入供应商核对的非负整数 Token 总数，不能用空值代表零。");
      this.state = { ...this.state, message: undefined, screen: { ...s, total: Number(value), confirming: false } };
    } else this.state = { ...this.state, message: undefined, screen: { ...s, [field]: value, ...(s.kind === "usage" ? { confirming: false } : {}) } };
  }

  async prepareExceptionRecovery(): Promise<void> {
    const s = this.state.screen;
    if (s.kind !== "exceptions") return;
    const item = s.data.items[s.index];
    if (!item?.recovery) throw new Error(item?.blockedReason ?? "没有可补答记录。");
    if (!s.by.trim() || !s.reason.trim()) throw new Error("请填写决定人与重新作答原因。");
    if (s.data.budget && (s.data.budget.unknownRequests || s.data.budget.activeRequests)) throw new Error("预算中仍有未知用量，请核对供应商记录后再补答。");
    await this.prepareResume(s.runId);
    const current = this.state.screen;
    if (current.kind !== "confirm") return;
    this.state = { ...this.state, screen: { ...current, recoveryDecision: { questionId: item.questionId,
      trialId: item.recovery.trialId, token: item.recovery.token, by: s.by.trim(), reason: s.reason.trim() } } };
  }

  openUsageReconciliation(): void {
    const s = this.state.screen;
    if (s.kind !== "exceptions") return;
    const questionId = s.data.items[s.index]?.questionId;
    const entry = s.data.budget?.entries.find((e) => e.questionId === questionId && (e.state === "unknown" || e.state === "active"));
    if (!entry) throw new Error("所选题目没有待核对的预算请求。");
    this.state = { ...this.state, screen: { kind: "usage", runId: s.runId, requestId: entry.id, total: null, by: "", reason: "", confirming: false } };
  }

  async confirmUsage(): Promise<void> {
    const s = this.state.screen;
    if (s.kind !== "usage") return;
    if (s.total === null || !s.by.trim() || !s.reason.trim()) throw new Error("请填写供应商核对的 Token 总数、确认人与依据。");
    if (!s.confirming) { this.state = { ...this.state, screen: { ...s, confirming: true } }; return; }
    await this.service.reconcileUsage(this.cfg.runsRoot, s.runId, s.requestId, s.total, s.by, s.reason);
    await this.openExceptions(s.runId);
  }

  /** Start the task via the service; move to the run screen. */
  start(): string | undefined {
    if (this.activeJudgeId) throw new Error("裁判任务仍在运行或存档，请先等待或停止。");
    // 页面切换和停止请求都不代表后台已结束，等待归档完成后才允许启动下一任务。
    if (this.activeTaskId) {
      this.state = { ...this.state, screen: { kind: "run", taskId: this.activeTaskId }, message: "已有任务尚未结束，请等待或停止该任务。" };
      return undefined;
    }
    const s = this.state.screen;
    if (s.kind !== "confirm" || !this.state.selectedDataset) return undefined;
    if (!this.cfg.authorisePaid && !this.cfg.registryOverride && !this.cfg.offlineDemo) {
      this.state = { ...this.state, message: "REFUSED: real (paid) model calls require --authorise-paid" };
      return undefined;
    }
    const registry = this.registryFor(s.setup);
    const taskId = this.service.start({
      datasetId: this.state.selectedDataset,
      datasetDir: join(this.cfg.datasetsRoot, this.state.selectedDataset),
      modes: s.setup.mode === "both" ? ["without_tool", "with_tool"] : [s.setup.mode],
      thinkingLevel: s.setup.thinkingLevel ?? "off",
      batchTokenLimit: s.setup.batchTokenLimit,
      recoveryDecision: s.recoveryDecision,
      profileId: s.setup.profileId,
      modelId: s.setup.modelId,
      limit: 100000,
      runsRoot: this.cfg.runsRoot,
      workRoot: this.cfg.workRoot,
      toolsVersion: this.cfg.toolsVersion,
      pythonInterpreter: this.cfg.pythonInterpreter,
      modelsConfigPath: this.cfg.modelsConfigPath,
      limitsPath: this.cfg.limitsPath,
      requestTimeoutMs: this.cfg.requestTimeoutMs,
      concurrency: s.setup.concurrency,
      registryOverride: registry,
      ...(s.setup.apiConcurrency ? { requestSchedulerLimits: { maxConcurrent: s.setup.apiConcurrency, minIntervalMs: 0 } } : {}),
      ...(s.resume ? { runId: s.resume.runId, datasetVersion: s.resume.manifest.datasetVersion,
        limitsOverride: s.resume.config.limits,
        pythonInterpreter: s.resume.config.pythonInterpreter, requestSchedulerLimits: s.resume.config.requestSchedulerLimits } : {}),
    });
    this.state = { ...this.state, taskId, screen: { kind: "run", taskId }, events: [], message: undefined };
    this.activeTaskId = taskId;
    void this.service.whenDone(taskId).then(() => {
      if (this.activeTaskId === taskId) this.activeTaskId = undefined;
    });
    return taskId;
  }

  stop(): void {
    const taskId = this.state.taskId;
    if (!taskId || this.service.getStatus(taskId)?.state !== "running") return;
    this.service.stop(taskId);
    this.state = { ...this.state, message: STOP_PENDING };
  }

  /** P1-2: stop the running task AND wait for it to finish (in-flight requests
   *  aborted, archives flushed) before the caller tears down the UI. Without
   *  this, quitting leaves the batch calling the model in the background. */
  async stopAndWait(): Promise<void> {
    const id = this.state.taskId;
    if (id) this.stop();
    // 所有会话先获得取消信号；某一类存档失败也不能让另一类继续计费。
    const results = await Promise.allSettled([this.chat?.stopAndWait(), this.collection?.stopAndWait(), this.judge.stopAndWait(),
      id ? this.service.whenDone(id).catch(() => undefined) : undefined]);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
    if (errors.length) throw new Error(`停止或存档失败：${errors.join("；")}`);
  }

  /** Feed a live event into the controller's view state. */
  onEvent(e: TaskEvent): void {
    if (e.type === "mode_done") this.runIdsByMode.set(e.mode, e.runId);
    const message = e.type === "task_done" && this.state.message === STOP_PENDING ? undefined : this.state.message;
    this.state = { ...this.state, events: [...this.state.events, e], message };
  }

  async openTasks(): Promise<void> {
    const tasks = this.service.listTasks(this.cfg.runsRoot);
    this.state = { ...this.state, screen: { kind: "tasks", tasks } };
  }

  async openDetail(runId: string): Promise<void> {
    const selected = this.service.resolveRunMode(this.cfg.runsRoot, runId);
    const datasetId = this.datasetId(runId);
    const detail = await this.service.getValidatedTaskDetail(this.cfg.runsRoot, runId, join(this.cfg.datasetsRoot, datasetId), datasetId, selected.mode);
    this.state = { ...this.state, screen: { kind: "detail", runId, detail } };
  }

  private datasetId(runId: string): string {
    return readManifest(this.cfg.runsRoot, runId)?.datasetId ?? runId.split("@")[0]!;
  }

  async openReport(runId: string, mode?: AnswerMode): Promise<void> {
    try {
      const selected = this.service.resolveRunMode(this.cfg.runsRoot, runId, mode);
      const datasetId = this.datasetId(selected.runId);
      const report = await this.service.rebuildReport(this.cfg.runsRoot, selected.runId, join(this.cfg.datasetsRoot, datasetId), datasetId, selected.mode);
      this.state = { ...this.state, screen: { kind: "report", runId: selected.runId, mode: selected.mode, report }, message: undefined };
    } catch (error) {
      this.state = { ...this.state, message: (error as Error).message };
    }
  }

  private reviewService(runId: string): ReviewService {
    const datasetId = this.datasetId(runId);
    return new ReviewService(this.cfg.runsRoot, join(this.cfg.datasetsRoot, datasetId), datasetId);
  }

  private judgePath(): string { return this.cfg.judgeConfigPath ?? join(dirname(this.cfg.modelsConfigPath), "judge.json"); }

  openJudge(): void {
    if (this.cfg.offlineDemo) throw new Error("离线演示使用人工复核。独立模型裁判请使用 npm run tui。");
    const draft = readJudgeConfig(this.judgePath()) ?? defaultJudgeDraft();
    this.state = { ...this.state, message: undefined, screen: { kind: "judge", draft, groups: this.loadModelGroups(), stage: "config", providerIndex: 0, modelIndex: 0 } };
  }
  judgePicker(): void {
    const s = this.state.screen; if (s.kind !== "judge") return;
    this.state = { ...this.state, screen: { ...s, stage: "provider" } };
  }
  moveJudgeChoice(step: number): void {
    const s = this.state.screen; if (s.kind !== "judge") return;
    if (s.stage === "provider") this.state = { ...this.state, screen: { ...s, providerIndex: Math.max(0, Math.min(s.groups.length - 1, s.providerIndex + step)) } };
    if (s.stage === "model") this.state = { ...this.state, screen: { ...s, modelIndex: Math.max(0, Math.min((s.groups[s.providerIndex]?.models.length ?? 0) - 1, s.modelIndex + step)) } };
  }
  chooseJudge(index?: number): void {
    const s = this.state.screen; if (s.kind !== "judge") return;
    if (s.stage === "provider") { this.state = { ...this.state, screen: { ...s, providerIndex: index ?? s.providerIndex, modelIndex: 0, stage: "model" } }; return; }
    if (s.stage === "model") {
      const model = s.groups[s.providerIndex]?.models[index ?? s.modelIndex]; if (!model) return;
      const config = loadModelsConfig(this.cfg.modelsConfigPath);
      const profile = config.profiles.find((p) => p.provider === model.providerId && p.models.some((m) => m.id === model.modelId));
      this.state = { ...this.state, message: undefined, screen: { ...s, stage: "config", draft: { ...s.draft, profileId: profile?.id ?? model.providerId, modelId: model.modelId, thinkingLevel: "off" } } };
    }
  }
  backJudge(): void {
    const s = this.state.screen; if (s.kind !== "judge") return;
    if (s.stage === "config") { void this.gotoHome(); return; }
    this.state = { ...this.state, screen: { ...s, stage: s.stage === "model" ? "provider" : "config" } };
  }
  setJudgeField(field: "budget" | "output" | "timeout" | "deadline", value: string): void {
    const s = this.state.screen; if (s.kind !== "judge") return;
    const count = Number(value);
    if (!value.trim() || !Number.isSafeInteger(count) || count <= 0) throw new Error("请输入正整数；时间单位为秒，Token 单位为个。");
    if ((field === "timeout" || field === "deadline") && count > 2147483) throw new Error("时间上限不能超过 2147483 秒，避免系统计时溢出。");
    const limits = { ...s.draft.limits, ...(field === "output" ? { maxOutputTokens: count } : field === "timeout" ? { requestTimeoutMs: count * 1000 } : field === "deadline" ? { totalRunTimeMs: count * 1000 } : {}) };
    this.state = { ...this.state, message: undefined, screen: { ...s, draft: { ...s.draft, limits, ...(field === "budget" ? { maxTotalTokens: count } : {}) } } };
  }
  cycleJudgeThinking(): void {
    const s = this.state.screen; if (s.kind !== "judge") return;
    const model = resolveModel(this.registryFor(s.draft), s.draft.profileId, s.draft.modelId);
    if (!model) throw new Error("请先选择裁判模型。");
    const levels = getSupportedThinkingLevels(model); const next = levels[(levels.indexOf(s.draft.thinkingLevel) + 1) % levels.length]!;
    this.state = { ...this.state, screen: { ...s, draft: { ...s.draft, thinkingLevel: next } } };
  }
  saveJudge(): void {
    const s = this.state.screen; if (s.kind !== "judge") return;
    if (!s.draft.profileId || !s.draft.modelId || s.draft.maxTotalTokens === null) throw new Error("请先选择裁判模型并填写任务 Token 预算。");
    const config = JudgeConfigSchema.parse(s.draft);
    this.judge.validateConfig(config, this.registryFor(config)); saveJudgeConfig(this.judgePath(), config);
    this.state = { ...this.state, message: "裁判配置已保存；没有发送请求，初评仍需单独确认。" };
  }

  async prepareJudge(): Promise<void> {
    if (this.cfg.offlineDemo) throw new Error("离线演示使用人工复核。独立模型裁判请使用 npm run tui。");
    const s = this.state.screen; if (s.kind !== "review" && s.kind !== "calibration") return;
    if (s.kind === "review" && s.calibrationParent) throw new Error("请先完成人工核对并返回校准列表，再单独确认裁判请求。");
    if (s.kind === "review" && s.confirming) throw new Error("请先取消人工评分确认。");
    const config = readJudgeConfig(this.judgePath()); if (!config) throw new Error("请先使用 /judge 保存独立裁判配置。");
    const datasetId = this.datasetId(s.runId), datasetDir = join(this.cfg.datasetsRoot, datasetId);
    const ids = s.kind === "review" ? [s.items[s.index]?.trialId].filter((id): id is string => !!id) : s.selected;
    if (s.kind === "review") {
      const current = (await this.reviewService(s.runId).getQueue(s.runId, s.mode)).find((item) => item.trialId === ids[0]);
      if (!current || current.reviewToken !== s.items[s.index]?.reviewToken) throw new Error("复核材料已变化，请重新打开队列。");
    } else {
      const latest = await this.judge.calibrationCandidates(s.runId, datasetDir, datasetId, { config, registry: this.registryFor(config) });
      if (ids.some((id) => latest.find((item) => item.trialId === id)?.materialToken !== s.candidates.find((item) => item.trialId === id)?.materialToken)) throw new Error("人工样本已变化，请重新打开校准页面。");
    }
    const plan = await this.judge.prepare(s.runId, datasetDir, datasetId, s.kind === "review" ? "preliminary" : "calibration", ids, config, this.registryFor(config));
    this.state = { ...this.state, message: undefined, screen: { kind: "judgeConfirm", parent: s, plan } };
  }
  startJudge(): string {
    const s = this.state.screen; if (s.kind !== "judgeConfirm") throw new Error("请先检查裁判请求摘要。");
    if (this.activeTaskId || this.activeJudgeId) throw new Error("已有任务尚未结束，请先等待或停止。");
    const id = this.judge.start(s.plan, !!this.cfg.authorisePaid || !!this.cfg.registryOverride);
    this.activeJudgeId = id;
    this.state = { ...this.state, message: undefined, screen: { kind: "judgeRun", jobId: id, plan: s.plan, parent: s.parent } };
    this.lastJudgeScreen = { kind: "judgeRun", jobId: id, plan: s.plan, parent: s.parent };
    void this.judge.whenDone(id).then(() => { if (this.activeJudgeId === id) this.activeJudgeId = undefined; });
    return id;
  }
  cancelJudgePlan(): void {
    const s = this.state.screen; if (s.kind === "judgeConfirm") this.state = { ...this.state, message: undefined, screen: s.parent };
  }
  async finishJudge(): Promise<void> {
    const s = this.state.screen; if (s.kind !== "judgeRun") return;
    if (this.judge.getStatus(s.jobId)?.state === "running") throw new Error("裁判仍在运行，请等待或按 s 停止。");
    if (s.parent.kind === "review") {
      const parent = s.parent;
      await this.openReview(s.parent.runId, s.parent.mode);
      const current = this.state.screen;
      if (current.kind === "review") {
        const index = current.items.findIndex((item) => item.trialId === parent.items[parent.index]?.trialId);
        this.state = { ...this.state,
          ...(index < 0 ? { message: "原题已离开待复核队列；原题的分数与理由未带入其他题目，请检查当前答卷。" } : {}),
          screen: { ...current, index: Math.max(0, index), score: index >= 0 ? parent.score : null,
            confirmer: parent.confirmer, reason: index >= 0 ? parent.reason : "" } };
      }
    } else {
      const datasetId = this.datasetId(s.parent.runId);
      const report = await this.judge.calibrationReport(s.parent.runId, join(this.cfg.datasetsRoot, datasetId), datasetId, s.parent.selected, s.plan.config, this.registryFor(s.plan.config));
      this.state = { ...this.state, message: undefined, screen: { ...s.parent, report, confirming: false } };
    }
  }
  async openCalibration(runId: string): Promise<void> {
    const readiness = await this.calibrationCandidates(runId);
    this.state = { ...this.state, message: undefined, screen: { kind: "calibration", runId, ...readiness, selected: [], index: 0, by: "", reason: "", confirming: false } };
  }
  private judgeForReading() {
    let judge: { config: JudgeConfig; registry: Registry } | undefined;
    let judgeIssue: string | undefined;
    try {
      const config = readJudgeConfig(this.judgePath());
      if (config) { const registry = this.registryFor(config); this.judge.validateConfig(config, registry); judge = { config, registry }; }
    } catch (error) { judgeIssue = `裁判配置不可用，人工核对仍可进行：${error instanceof Error ? error.message : String(error)}`; }
    return { judge, judgeIssue };
  }
  private async calibrationCandidates(runId: string) {
    const datasetId = this.datasetId(runId), { judge, judgeIssue } = this.judgeForReading();
    const candidates = await this.judge.calibrationCandidates(runId, join(this.cfg.datasetsRoot, datasetId), datasetId, judge);
    return { candidates, judgeIssue };
  }
  async openCalibrationReview(): Promise<void> {
    const s = this.state.screen; if (s.kind !== "calibration" || s.confirming) return;
    const candidate = s.candidates[s.index]; if (!candidate) throw new Error("没有可核对的答卷。");
    if (candidate.humanConfirmed) throw new Error("该样本已人工确认，可按 f 查看完整对照。");
    const latest = await this.calibrationCandidates(s.runId);
    if (latest.candidates.find((item) => item.trialId === candidate.trialId)?.materialToken !== candidate.materialToken) throw new Error("样本材料或评分已变化，请重新打开校准列表。");
    const { mode } = this.service.resolveRunMode(this.cfg.runsRoot, s.runId);
    const item = (await this.reviewService(s.runId).getQueue(s.runId, mode, true)).find((entry) => entry.trialId === candidate.trialId);
    if (!item || item.truncated || !item.reviewToken) throw new Error("当前答卷不能建立人工校准样本，请重新检查材料。");
    this.state = { ...this.state, message: undefined, screen: { kind: "review", runId: s.runId, mode, items: [item], index: 0,
      score: null, confirmer: s.by, reason: "", confirming: false, calibrationParent: s } };
  }
  closeCalibrationReview(): void {
    const s = this.state.screen;
    if (s.kind === "review" && s.calibrationParent) this.state = { ...this.state, message: undefined, screen: s.calibrationParent };
  }
  selectCalibration(step: number, toggle = false): void {
    const s = this.state.screen; if (s.kind !== "calibration" || s.confirming) return;
    const index = Math.max(0, Math.min(s.candidates.length - 1, s.index + step)); const item = s.candidates[index];
    if (toggle && !item?.eligible) throw new Error(item?.blockedReason ?? "请选择已有人工确认的有效样本；按 r 核对当前答卷。");
    const selected = toggle && item ? s.selected.includes(item.trialId) ? s.selected.filter((id) => id !== item.trialId) : [...s.selected, item.trialId] : s.selected;
    this.state = { ...this.state, message: undefined, screen: { ...s, index, selected, ...(toggle ? { report: undefined } : {}) } };
  }
  setCalibrationField(field: "by" | "reason", value: string): void {
    const s = this.state.screen; if (s.kind !== "calibration") return;
    this.state = { ...this.state, message: undefined, screen: { ...s, [field]: value, confirming: false } };
  }
  async loadCalibrationReport(): Promise<void> {
    const s = this.state.screen; if (s.kind !== "calibration") return;
    const config = readJudgeConfig(this.judgePath()); if (!config) throw new Error("请先保存 /judge 裁判配置。");
    const datasetId = this.datasetId(s.runId);
    const report = await this.judge.calibrationReport(s.runId, join(this.cfg.datasetsRoot, datasetId), datasetId, s.selected, config, this.registryFor(config));
    this.state = { ...this.state, message: "已离线读取保存的裁判对照，没有发送请求。", screen: { ...s, report, confirming: false } };
  }
  async openCalibrationSample(): Promise<void> {
    const s = this.state.screen; if (s.kind !== "calibration") return;
    const item = s.candidates[s.index]; if (!item) throw new Error("没有选中的校准样本。");
    const { judge, judgeIssue } = this.judgeForReading();
    const datasetId = this.datasetId(s.runId);
    const sample = await this.judge.calibrationSample(s.runId, join(this.cfg.datasetsRoot, datasetId), datasetId, item.trialId, judge?.config, judge?.registry);
    this.state = { ...this.state, message: undefined, screen: { kind: "calibrationSample", parent: s,
      sample: judgeIssue ? { ...sample, judgeState: "unavailable", judgeError: judgeIssue } : sample, tab: "comparison" } };
  }
  setCalibrationTab(tab: "question" | "answer" | "basis" | "comparison"): void {
    const s = this.state.screen; if (s.kind === "calibrationSample") this.state = { ...this.state, message: undefined, screen: { ...s, tab, image: undefined, imageIndex: undefined } };
  }
  closeCalibrationSample(): void {
    const s = this.state.screen; if (s.kind !== "calibrationSample") return;
    this.state = { ...this.state, message: undefined, screen: s.image ? { ...s, image: undefined, imageIndex: undefined } : s.parent };
  }
  async openCalibrationImage(step = 0): Promise<void> {
    const s = this.state.screen; if (s.kind !== "calibrationSample") return;
    const indices = s.sample.question.assets.flatMap((asset, i) => asset.mediaType.startsWith("image/") ? [i] : []);
    const position = s.imageIndex === undefined ? 0 : indices.indexOf(s.imageIndex);
    const index = indices[Math.max(0, Math.min(indices.length - 1, position + step))]; if (index === undefined) throw new Error("该校准样本没有原图。");
    const datasetId = this.datasetId(s.parent.runId);
    const image = await this.judge.calibrationImage(s.parent.runId, join(this.cfg.datasetsRoot, datasetId), datasetId, s.sample.trialId, index, s.sample.materialToken);
    this.state = { ...this.state, message: undefined, screen: { ...s, image, imageIndex: index } };
  }
  async confirmCalibration(): Promise<void> {
    const s = this.state.screen; if (s.kind !== "calibration" || !s.report) throw new Error("请先完成所选人工样本的裁判对照。");
    if (s.report.summary.compared !== s.report.summary.total) throw new Error("仍有未完成或无效的裁判结果，不能确认完整样本对照。");
    if (!s.by.trim() || !s.reason.trim()) throw new Error("请填写检查人和判断依据。");
    if (!s.confirming) { this.state = { ...this.state, screen: { ...s, confirming: true } }; return; }
    const config = readJudgeConfig(this.judgePath()); if (!config) throw new Error("裁判配置缺失。");
    const datasetId = this.datasetId(s.runId);
    await this.judge.confirmCalibration(s.runId, join(this.cfg.datasetsRoot, datasetId), datasetId, s.selected, config, this.registryFor(config), s.report.digest, s.by, s.reason);
    const report = await this.judge.calibrationReport(s.runId, join(this.cfg.datasetsRoot, datasetId), datasetId, s.selected, config, this.registryFor(config));
    this.state = { ...this.state, message: "这组样本的人工检查已保存，仅限所列样本和配置；初评仍不自动计入成绩。", screen: { ...s, report, confirming: false } };
  }
  cancelCalibrationConfirmation(): void {
    const s = this.state.screen; if (s.kind === "calibration") this.state = { ...this.state, screen: { ...s, confirming: false } };
  }

  /** P2: human-review page for a run's pending / needs-review answers. */
  async openReview(runId: string, mode?: AnswerMode): Promise<void> {
    try {
      if (this.state.screen.kind === "review" && this.state.screen.calibrationParent && mode && mode !== this.state.screen.mode) throw new Error("人工校准核对期间不能切换作答模式，请先返回校准列表。");
      const selected = this.service.resolveRunMode(this.cfg.runsRoot, runId, mode);
      const items = await this.reviewService(selected.runId).getQueue(selected.runId, selected.mode);
      this.state = { ...this.state, screen: { kind: "review", runId: selected.runId, mode: selected.mode, items, index: 0, score: null, confirmer: "", reason: "", confirming: false }, message: undefined };
    } catch (error) {
      this.state = { ...this.state, message: (error as Error).message };
    }
  }

  async openReviewImage(assetIndex?: number): Promise<void> {
    const s = this.state.screen;
    const parent = s.kind === "reviewImage" ? s.parent : s.kind === "review" ? s : undefined;
    if (!parent || parent.confirming) throw new Error("请先返回普通复核页面再查看图片。");
    const item = parent.items[parent.index];
    const selected = assetIndex ?? item?.question?.assets.findIndex((asset) => asset.mediaType.startsWith("image/")) ?? -1;
    if (!item || selected < 0) throw new Error("该题没有可核对的图片附件。");
    const image = await this.reviewService(parent.runId).loadImage(parent.runId, parent.mode, item.trialId, selected, item.reviewToken ?? "", !!parent.calibrationParent);
    this.state = { ...this.state, message: undefined, screen: { kind: "reviewImage", parent, assetIndex: selected, image } };
  }

  async nextReviewImage(step: number): Promise<void> {
    const s = this.state.screen;
    if (s.kind !== "reviewImage") return;
    const indices = (s.parent.items[s.parent.index]?.question?.assets ?? []).flatMap((asset, index) => asset.mediaType.startsWith("image/") ? [index] : []);
    const target = indices[Math.max(0, Math.min(indices.length - 1, indices.indexOf(s.assetIndex) + step))];
    if (target === undefined) throw new Error("该题没有可核对的图片附件。");
    await this.openReviewImage(target);
  }

  closeReviewImage(): void {
    const s = this.state.screen;
    if (s.kind === "reviewImage") this.state = { ...this.state, message: undefined, screen: s.parent };
  }

  highlightReview(index: number): void {
    const s = this.state.screen;
    if (s.kind !== "review") return;
    const i = Math.max(0, Math.min(s.items.length - 1, index));
    if (i === s.index) return;
    this.state = { ...this.state, screen: { ...s, index: i, score: null, reason: "", confirming: false }, message: undefined };
  }

  adjustReviewScore(delta: number): void {
    const s = this.state.screen;
    if (s.kind !== "review") return;
    const max = s.items[s.index]?.scoring?.maxScore ?? 0;
    this.state = { ...this.state, screen: { ...s, score: Math.max(0, Math.min(max, (s.score ?? 0) + delta)), confirming: false } };
  }

  setReviewField(field: "score" | "confirmer" | "reason", value: string): void {
    const s = this.state.screen;
    if (s.kind !== "review") return;
    if (field === "score") {
      const score = value.trim() ? Number(value) : null;
      const max = s.items[s.index]?.scoring?.maxScore ?? 0;
      if (score === null || !Number.isFinite(score) || score < 0 || score > max) throw new Error(`请输入 0 到 ${max} 之间的有效分数。`);
      this.state = { ...this.state, screen: { ...s, score, confirming: false }, message: undefined };
    } else {
      this.state = { ...this.state, screen: { ...s, [field]: value, confirming: false }, message: undefined };
    }
  }

  prepareReview(): void {
    const s = this.state.screen;
    if (s.kind !== "review" || !s.items[s.index]) return;
    if (s.score === null || !s.confirmer.trim() || !s.reason.trim()) throw new Error("请填写分数、确认人与复核依据后再确认。");
    if (!s.items[s.index]!.reviewToken) throw new Error("复核材料缺少校验标识，请重新打开队列。");
    this.state = { ...this.state, screen: { ...s, confirming: true }, message: undefined };
  }

  cancelReviewConfirmation(): void {
    const s = this.state.screen;
    if (s.kind === "review") this.state = { ...this.state, screen: { ...s, confirming: false } };
  }

  /** Submit the human score for the selected item, then refresh the queue. */
  async submitReview(): Promise<void> {
    const s = this.state.screen;
    if (s.kind !== "review") return;
    const item = s.items[s.index];
    if (!item) return;
    if (!s.confirming || s.score === null || !item.reviewToken) throw new Error("请先检查复核摘要并明确确认保存。");
    // 保存前关闭确认状态，重复按键不能再次写入同一次决定。
    this.cancelReviewConfirmation();
    await this.reviewService(s.runId).submitHuman(s.runId, item.trialId, { score: s.score, reason: s.reason, confirmer: s.confirmer, expectedReviewToken: item.reviewToken }, s.mode);
    if (s.calibrationParent) {
      const parent = { ...s.calibrationParent, report: undefined, confirming: false };
      // 人工决定已写入后立即离开旧确认页，刷新失败不能让旧 token 再次提交。
      this.state = { ...this.state, screen: parent, message: `已人工确认 ${item.questionId}，正在刷新样本。` };
      try {
        const readiness = await this.calibrationCandidates(s.runId);
        this.state = { ...this.state, screen: { ...parent, ...readiness,
          selected: parent.selected.filter((id) => readiness.candidates.some((candidate) => candidate.trialId === id && candidate.eligible)),
          index: Math.max(0, readiness.candidates.findIndex((candidate) => candidate.trialId === item.trialId)) },
          message: `已人工确认 ${item.questionId}，得分 ${s.score}；没有自动选择样本或发起裁判请求。` };
      } catch (error) { throw new Error(`人工评分已保存，但校准列表刷新失败，请重新打开。${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    let items: ReviewQueueItem[];
    try {
      items = await this.reviewService(s.runId).getQueue(s.runId, s.mode);
    } catch (error) {
      throw new Error(`已保存 ${item.questionId}，但复核队列刷新失败，请从历史任务重新打开。${error instanceof Error ? error.message : String(error)}`);
    }
    const i = Math.max(0, Math.min(items.length - 1, s.index));
    this.state = { ...this.state, screen: { kind: "review", runId: s.runId, mode: s.mode, items, index: i, score: null, confirmer: s.confirmer, reason: "", confirming: false }, message: `已保存 ${item.questionId}，得分 ${s.score}。` };
  }

  gotoDatasets(): void {
    const datasets = this.loadDatasets();
    this.state = { ...this.state, datasets, message: undefined, screen: { kind: "datasets" } };
  }

  openCurrentTask(): void {
    if (this.lastJudgeScreen && (this.activeJudgeId || !this.state.taskId)) { this.state = { ...this.state, message: undefined, screen: this.lastJudgeScreen }; return; }
    const taskId = this.state.taskId;
    if (!taskId) {
      this.setMessage("当前会话没有任务，可用 /tasks 查看历史记录。");
      return;
    }
    this.state = { ...this.state, screen: { kind: "run", taskId }, message: undefined };
  }
}

/** Derive a dataset id from a source path's basename (sanitised to an identifier). */
function deriveDatasetId(sourcePath: string): string {
  const base = sourcePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "imported";
  const stem = base.replace(/\.[^.]+$/, "");
  const id = stem.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return id || `imported-${shortDigest(sourcePath)}`;
}
