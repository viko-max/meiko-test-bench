# Meiko Test-Bench

Meiko Test-Bench 是一个基于 Pi 的多学科模型测评工具。它将题目和公开附件转换为模型可读输入，分别运行 **without tool** 与 **with tool**，保存答卷、用量、评分及复核记录。终端界面也支持独立聊天与搜题组卷。

**Creative Is All You Need**

由 Meiko 开发，OpenAI Codex 参与开发。

## 开始使用

需要 Node.js 22.19 或更高版本。以下示例适用于 Windows PowerShell。

```powershell
npm ci
npm run demo
```

离线演示使用六道自写题和本地脚本作答，无需配置模型或 API Key。启动后按任意键跳过开场，用 `/import` 导入预填的题包，核对后入库，再用 `/run` 运行两种模式。题面、作答、工具执行、判分、复核和续跑走实际流程。作答文本与模型用量来自本地演示提供方，成绩只用于验证流程。[查看演示步骤](datasets/demo/README.md)。

要调用真实模型，首次配置时将 `configs/models.example.json` 复制到 `configs/models.json`，选好模型档案，再在进程环境中提供对应的 API Key。配置文件只存放环境变量名。真实测评以 `npm run tui -- --authorise-paid` 启动，随后在界面核对模型、模式、题量与预算再开始。

正式测评不再需要 Python 环境。以下 Python 环境仅用于复现旧 v1（宿主任意代码）工具实现与历史资料，当前正式 with_tool 不注册这些工具。

```powershell
python -m venv pyenv/.venv
pyenv/.venv/Scripts/python.exe -m pip install -r pyenv/requirements.txt
```

## 终端操作

| 命令 | 用途 |
| --- | --- |
| `/bank`、`/import` | 查看题库，导入并核对题目 |
| `/run` | 创建测评，选择题集、模型、模式和预算 |
| `/tasks`、`/current` | 查看任务进度，停止或续跑 |
| `/results`、`/review` | 分模式查看成绩和复核答卷 |
| `/chat`、`/model` | 普通多轮对话及模型选择 |
| `/collect` | 搜索题源并整理题集草稿 |
| `/settings`、`/quit` | 设置和退出 |

输入 `/` 展开命令，方向键选择，Tab 补全，Enter 执行。Esc 返回，Ctrl+C 等待后台任务停止和存档后退出。

测评在独立模式下作答。**两种正式测评模式均禁止联网搜索**。正式 with_tool 模式提供受限四工具：calculate（TypeScript AST 白名单的安全计算）、read_file、view_image 和 process_image；无任意 Python/TypeScript 执行，也没有工具子进程。非图像公开附件只以相对名在 with_tool 模式展示。评分依据保存在独立目录，测评请求只包含公开题面和随题附件。v1（宿主任意代码，非隔离）与 v2-restricted（受限）成绩不直接比较：v1 with_tool 历史任务不续跑；可查看、复核和重评分；without_tool 历史身份保持不变。

普通聊天、`/collect` 和正式测评分别保存上下文与预算。Spark X2.6 的普通聊天可单独确认供应商原生搜索，默认关闭。缓存或推理用量缺失时界面显示未知。

## OCR 导入（第一阶段）

`/import` 还支持把整页试卷的 PDF/PNG/JPEG/WebP/GIF/BMP/TIFF 交给 DeepSeek OCR（`POST /v1/tools/ocr`，`purpose=rich_layout_recognition`，≤100MiB）识别成草稿：逐页原文、坐标证据和原件副本保存在 `.import/<draftId>/`，逐题对照、人工编辑核对后才能入库。凭据经进程环境变量 `DEEPSEEK_API_KEY` 提供（只记录变量名，绝不记录值）。客户端绝不自动重试：取消、超时或已发起后断连会使服务端可能继续处理并计费，这类草稿标记为结果未知（outcome_unknown）且不能入库，请核对供应商记录后决定；截断（finish_reason=length）或空页的草稿为 partial，同样不能入库。PDF 页面位图未提取，需对照原 PDF 核对；识别文本中的疑似答案/评分章节不会进入公共题面，原始内容只保留在独立 OCR 证据中。2026-11-17 已对真实 DeepSeek 官方 OCR 接口做过 1 次验收：1 页自写公开 PNG 样卷，status completed、pageCount 1、finishReason stop、10 个 boxes，真实响应离线重放修复后成功拆分为 3 题；PDF 与其他页型尚未真实验证。取消/超时/断连及 outcome_unknown 等错误路径仍只经本机 HTTP 测试服务与注入的模拟 OCR 客户端验证。

吉祥物原帧为 640×640 透明 PNG。Kitty 支持的终端使用原帧，其他终端按可用空间使用 48 或 64 像素的真彩色半块。

## 搜题组卷（第三阶段，/collect）

`/collect` 搜题可在设置页切换搜索服务：**AnySearch**（领域发现 + search/batch_search/extract，可匿名或 `ANYSEARCH_API_KEY`）或 **DeepSeek Search/Fetch**（`POST /v1/tools/search` + `POST /v1/tools/fetch`，禁止匿名，凭据经 `DEEPSEEK_API_KEY` 提供，只记录变量名）。整理模型与搜索服务相互独立，分别选择与验证。DeepSeek 工具集为 search/fetch/source_links/propose_question：search 结果（摘要/正文）只是 `untrustedExternalData`，必须 fetch 保存为来源后才能提出候选；空正文、截断或抓取失败的页面不能支撑候选题。官方计费口径（刊例价估算，非账单）：search 仅 HTTP 200 且结果非空计费、fetch 仅 HTTP 200 且正文非空计费，各 0.005 元/次，count 不影响价格；空搜索结果不计费。会话按 `maxSearchRequests`/`maxFetchRequests`/估算费用上限（`maxSearchSpendYuan`，默认 5 元）在请求前拦截，模型 Token 预算独立。客户端绝不自动重试，取消/超时/断连或 200 后空响应、invalid JSON/schema 标记结果未知（服务端可能已计费），由用户核对供应商记录后决定；402 余额不足、408/429/5xx 及 200 的 error 对象为确定结果。测试使用本机 HTTP 测试服务与注入的模拟客户端验证流程；2026-11-17 已对真实 DeepSeek Search/Fetch 接口做过 1 次验收：真实 Search 1 次返回 3 条结果，真实 Fetch 官方 OCR 文档 1 次取得 5459 字节正文（truncated=false），本次 Search+Fetch 按官方刊例价估算 0.01 元（仅为 `official_list_price_estimate`，真实计费以 provider console 账单核对为准，不宣称真实计费已验收）。

## 决策辅助复核（第二阶段，/review）

人工复核页可用决策模型对一份已归档答卷发起**一次**辅助复核（按 `d`，`o` 切换蚂蚁/象信，`x` 取消）：

- 蚂蚁 `lingdt-decision-1.0`（`POST https://maas-api.antdigital.com/v1/systemone`，ant 信封，必须 `errorCode===0`）支持 choice/noul/multi-choice/extract；象信 `xiangxin-3.8`（`POST https://api.xiangxinai.cn/v1/systemone`）支持 choice/noul/span（码点左闭右开）。profile 模板见 `configs/decision.example.json`（复制为 `configs/decision.json`；百炼可扩展，volcano/startlux/sii 仅为 disabled 候选说明）。TUI 实际会读取与 `configs/models.json` 同目录的 `decision.json`（`src/providers/decision-config.ts`，剥离 `$comment` 后经严格 zod 校验；缺文件回退内置蚂蚁+象信默认，文件存在但损坏直接报错绝不静默默认），可切换模型 id/凭据环境变量名/能力组合。真实调用必须 `--authorise-paid`，凭据只经环境变量名提供，绝不记录值。
- 证据逐段校验必须精确定位回答卷原文（象信按码点换算 UTF16；蚂蚁按 UTF16/codepoint/UTF8 候选解析 offset，歧义或截断一律标定位失败保留人工）。结果是**仅辅助、需人工确认**的记录（`needsHumanReview` 恒真），追加保存到 trial 目录 `decision-reviews.jsonl` / `decision-review.json`，绝不修改 Grade、报告或原答卷；取消/超时/断连标结果未知（可能已计费）。离线样本评估在 `src/service/decision-evaluation.ts`，指标只报告不自动确认。
- 测试使用本机 HTTP 测试服务与注入的模拟 runner，**未对真实蚂蚁/象信接口做验证**。

## 贡献与验证

欢迎参与贡献。提交流程见 [贡献指南](CONTRIBUTING.md)，开发约束见 [AGENTS.md](AGENTS.md)。

```powershell
npm run typecheck
npm test
npm run build
```

测试使用离线模型和本机 HTTP 测试服务。Windows 目录联接用例需要相应的本机权限。

自有源码采用 [MIT](LICENSE) 许可，第三方和吉祥物素材许可见 [NOTICE](NOTICE.md)。
