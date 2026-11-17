# Meiko Test-Bench 项目规范

本文件适用于整个仓库。请按 [贡献指南](CONTRIBUTING.md) 核对改动和验证结果。

## 目录和数据

- `src/` 存放 TypeScript 源码与随项目分发的终端素材。`scripts/` 存放本地命令，`tests/` 存放离线验证与自写测试材料。
- `configs/models.example.json` 是公开模板。`configs/models.json` 是本地配置，只引用凭据环境变量名。
- `datasets/demo/` 存放随仓库分发的自写示例。自有题集、真实评分材料、`runs/`、`chats/`、`.import/` 和 `.work/` 是本地数据。
- `datasets/<id>/public/` 只放可给作答模型看的内容。`scoring/` 独立保存答案和评分依据。`source/` 保留原始材料，`snapshots/` 保留版本快照。
- 标识符用小写 ASCII 和 `_.-`。题目内容变化时增加版本，已完成的答卷和历史评分保留。

## 测评规则

- 两种模式独立作答、分别出成绩。模型自主选择作答步骤和本地工具。正式测评均禁止联网搜索，随题原图可直接提供。原始得分直接累加。
- 公开题目和评分材料使用独立契约。构建作答请求和工具工作区时只取公开字段。裁判只在独立判分阶段读取完整答卷与评分依据。
- 采用 Pi Agent 原语，测评请求显式设置 `maxRetries: 0` 和取消信号。结果未知的请求由用户决定是否补答，续跑匹配完整运行身份。
- 发请求前保存轮次与预算预留。用量缺失保持未知，预算与存档失败阻止后续请求。停止任务后先取消进行中的调用、终止相关工具进程，再完成存档。
- 客观题只采用有明确证据的提取结果。歧义进入复核。独立模型裁判经人工样本校准后才能作为确认成绩依据。复核保留证据和旧评分。
- 正式 with_tool 只提供受限四工具：calculate（TypeScript AST 白名单计算）、read_file、view_image、process_image；无任意 Python/TypeScript 执行，也没有工具子进程。`src/tools/exec-python.ts` 与 `src/tools/exec-typescript.ts` 是 legacy v1 实现，未注册到当前正式工具集。历史 v1 with_tool 任务不续跑；可查看、复核和重评分；without_tool 历史身份保持。不同工具版本能力不同，成绩不直接比较。测评禁网是使用规则。

## 聊天与搜题

- 普通聊天、`/collect` 搜题与正式测评各自保存上下文、预算和记录。普通聊天默认无搜索或本地工具。
- Spark X2.6 官方接口的原生搜索按会话启用，改动需重新确认，切换模型时关闭。模型自主选择是否搜索，界面以可核对的响应证据为准。
- 模型能力须有官方说明或实际请求证据。离线模型和本机 HTTP 测试用于验证流程，验收结果须注明测试条件。
- `/collect` 搜索服务可选 AnySearch 或 DeepSeek Search/Fetch（`src/providers/deepseek-search.ts`，workflow `collection-v3`）。AnySearch 保留 get_sub_domains/search/batch_search/extract；DeepSeek 只提供 search/fetch/source_links/propose_question，禁止匿名（凭据环境变量名默认 `DEEPSEEK_API_KEY`，只记录变量名），search 摘要/正文标记 untrustedExternalData，fetch 保存来源后才可 propose，抓取不完整/空正文/截断不可入库。
- DeepSeek 计费按官方刊例价估算（0.005 元/次成功且有结果/非空正文，search/fetch 分开计数，空结果与失败不计费，标记 `official_list_price_estimate`，非账单，**未做真实计费验收**，以供应商账单为准；AnySearch 费用未知不伪造）。计费记录在 provider 成功返回之后、本地处理之前立即原子存档：search 按原始 200 响应 results 长度（`searchDetailed` 的 `providerResultCount`，URL 被 publicSearchUrl 全部拒绝仍计费），fetch 按 `fetchPage` 成功（200 且正文非空，空正文在客户端拒绝）即计费；之后的本地过滤、来源大小（`maxSourceBytes`）、凭据自检或存档失败不撤销已发生用量，operation 完成时不再重复计费。limits 增加 `maxFetchRequests`（默认 20）与 `maxSearchSpendYuan`（默认 5），达到次数或估算预算在请求前拒绝；客户端绝不自动重试，取消/超时/断连及 200 后空响应、invalid JSON/schema 标 outcomeUnknown，402/408/429/5xx 及 200 error 对象为确定结果。旧版搜题会话可查看和组卷，不能按新身份续发。整理模型仍由原 registry/profileId/modelId 独立选择，与搜索服务解耦。

## OCR 导入（第一阶段，/import）

- DeepSeek OCR 客户端（`src/providers/deepseek-ocr.ts`）只接受官方 URL（测试可注入 fetch/endpoint）；multipart 仅 file/purpose 两字段，Bearer 凭据经环境变量 `DEEPSEEK_API_KEY` 提供，只记录变量名，绝不记录值，也不进入日志、快照或测试数据。
- 首版支持 PDF/PNG/JPEG/WebP/GIF/BMP/TIFF（≤100MiB）。客户端绝不自动重试：取消、超时、已发起后断连，以及 HTTP 200 后空响应、invalid_json、invalid_schema、page_mismatch（含响应读取途中取消/超时）都标记 outcomeUnknown（服务端可能已完成处理并计费），由用户核对供应商记录后决定；HTTP 200 的 error 对象、402=余额不足、408/429/5xx 均为确定结果，分类抛出。上传前的扩展名/空文件/大小校验失败不算未知。
- `ImportService.importOcrSource` 在请求前保存原件副本、ocr-operation 事件与占位草稿；每个状态原子保存。running 草稿在进程重启后经 get/list 显示 outcome_unknown，不自动重发。partial/failed/outcome_unknown 不可 confirm；completed 但逐题 conversionIssues 需逐题编辑保存（记录 revision）视为核对后才可入库。
- 识别忠实保留逐页原文（`ocr-response.json` + `page-<n>.txt`），`<｜ref｜>…<｜box｜>` 坐标解析为归一化 0..1000 证据；疑似答案/评分章节截断在公共题干之外，原始内容只留 OCR 证据，评分默认不完整、绝不猜测。PDF 页面位图未提取，必须对照原 PDF；普通图片原件作为共享原图附件供 TUI 对照。
- 2026-11-17 已对真实 DeepSeek 官方 OCR 接口做过 1 次验收：1 页自写公开 PNG 样卷，status completed/pageCount 1/finishReason stop/10 boxes，真实响应离线重放修复后拆 3 题；PDF 与其他页型未真实验证。取消/超时/断连及 200 后空响应/invalid_json/invalid_schema/page_mismatch 等错误路径仍只经本机 HTTP 测试服务与注入的模拟客户端验证。

## 决策辅助复核（第二阶段，/review）

- 决策 profile（`src/shared/decision.ts`，严格 zod）声明 id/baseUrl/凭据环境变量名/model/信封（ant=蚂蚁必须 errorCode===0，standard=象信/百炼无 errorCode）/能力数组/enabled。默认蚂蚁 lingdt-decision-1.0（choice/noul/multi-choice/extract）与象信 xiangxin-3.8（choice/noul/span）；百炼为可扩展模板（完整 URL 含 workspace，仅 choice/noul）；volcano/startlux/sii 只以 disabled 候选说明，不实现路由。本地配置复制 `configs/decision.example.json` 为 `configs/decision.json`（已 gitignore），只引用环境变量名。正常 TUI 实际读取该文件：`src/providers/decision-config.ts` 的 loadDecisionProfiles 剥离 `$comment` 文档键 → assertNoCredentials → 严格 zod 解析；与 models.json 同目录查找，缺文件回退 DEFAULT_DECISION_PROFILES，存在但损坏必须报错，绝不静默默认。
- `SystemOneClient`（`src/providers/systemone.ts`）生产默认只允许声明的 https 端点，测试注入 fetch 可本机；Bearer 只来自环境或注入，绝不记录。绝不自动重试；取消/超时/已发起后断连及 HTTP 200 后空响应/invalid_json/invalid_schema 标 outcomeUnknown，402/408/429/5xx/蚂蚁业务 errorCode 为确定结果。每个请求问题都必须收到对应 type 的合法答案。象信错误 HTTP 取 `detail`；响应保存实际 model 与 x-request-id/x-xiangxin-model-ms/x-xiangxin-total-ms。
- `DecisionReviewService`（`src/service/decision-review.ts`）只经 loadValidAnswers 读真实归档 Trial，只允许 completed 且有 finalAnswerSheet；不写 grade、不重跑作答。共同 choice（explicit_single/explicit_multiple/no_conclusion/insufficient_evidence）与 noul 必发；蚂蚁加 multi-choice（题面 A..Z 选项动态 criteria）与 extract，象信加 span；能力缺失不发送并显式 limitations，绝不静默降级。
- 证据逐段校验必须确实来自原答卷：象信按 Array.from 码点 slice 并换算 JS UTF16 位置，path 必须对应答卷；蚂蚁 offset 编码不明时按 UTF16/codepoint/UTF8 字节候选逐一验证 text，只有唯一匹配才接受并记录实际 encoding。text/位置不符、重复歧义、truncated 一律标定位失败保留人工，不得仅 includes 后伪造坐标。多选（如"A 和 J"）必须逐项展示选项与原文证据；数值/单位只提证据，不套选择项；不从概率自动改分。
- 记录（needsHumanReview 恒真）追加 trial 目录 `decision-reviews.jsonl` 并原子写最新 `decision-review.json`；失败/未知同样保存；返回前再次核对 trial digest，材料变化不保存。绝不修改 Grade、报告、原答卷。TUI 复核页 `d` 发起一次辅助复核、`o` 切换 profile、`x` 取消；真实调用必须 `--authorise-paid`，注入测试 client 可离线；停止任务先取消并等待存档。原 1/2/3 阅读与人工评分流程不变。
- 离线样本评估（`src/service/decision-evaluation.ts`）按 questionGroup 稳定划分 dev/validation，禁止同组跨 split；输出 falseExplicitRate/evidenceExactRate/optionsExact/humanReviewCoverage 与 split/count/latency/usage，阈值只报告不自动确认。optionsExact：multiChoices 直出比对；multiChoices=null 时按与 decision-review 相同边界规则从已验证 extract/span 证据推导 A..Z 选项；profile 完全无证据能力时该指标记不适用（rate=null/total=0，显式 notApplicable），绝不虚报 0。样本为自写公开材料 `tests/fixtures/decision/review-samples.json`。决策测试只使用本机 HTTP 测试服务与注入的模拟 runner，未验证真实蚂蚁/象信接口。

## 实施和验证

- UI 通过服务层调用，服务层负责校验、执行与归档。使用维护中的库解析标准格式。关键运行结果原子保存，事件追加记录。
- 密钥只通过进程环境提供。日志、命令、快照和测试数据禁止写入真实凭据。模型或网页返回的内容按数据处理。
- 执行 `npm run typecheck`、`npm test` 和 `npm run build`。本机接口和目录联接测试依赖平台权限。PR 要说明未执行的检查和原因。
- 真实模型调用前明确接口、调用范围和预算。任何对外发布、付费请求、凭据变动或删除数据须由操作者授权。
