# Meiko Test-Bench

Meiko Test-Bench 是一个基于 Pi 的多学科模型测评工具。它将题目和公开附件转换为模型可读输入，分别运行 **without tool** 与 **with tool**，保存答卷、用量、评分及复核记录。终端界面也支持独立聊天与搜题组卷。

**Creative Is All You Need**

由 Meiko 开发，OpenAI Codex 参与开发。

## 开始使用

需要 Node.js 22.19 或更高版本。若使用 Python 答题工具，另需 Python 3.11 或更高版本。以下示例适用于 Windows PowerShell。

```powershell
npm ci
npm run demo
```

离线演示使用六道自写题和本地脚本作答，无需配置模型或 API Key。启动后按任意键跳过开场，用 `/import` 导入预填的题包，核对后入库，再用 `/run` 运行两种模式。题面、作答、工具执行、判分、复核和续跑走实际流程。作答文本与模型用量来自本地演示提供方，成绩只用于验证流程。[查看演示步骤](datasets/demo/README.md)。

要调用真实模型，首次配置时将 `configs/models.example.json` 复制到 `configs/models.json`，选好模型档案，再在进程环境中提供对应的 API Key。配置文件只存放环境变量名。真实测评以 `npm run tui -- --authorise-paid` 启动，随后在界面核对模型、模式、题量与预算再开始。

使用 Python 工具前，创建项目内环境并安装依赖。

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

测评在独立模式下作答。**两种正式测评模式均禁止联网搜索**。工具模式使用本地 Python 或 TypeScript 子进程，子进程仍共享主机权限。评分依据保存在独立目录，测评请求只包含公开题面和随题附件。

普通聊天、`/collect` 和正式测评分别保存上下文与预算。Spark X2.6 的普通聊天可单独确认供应商原生搜索，默认关闭。缓存或推理用量缺失时界面显示未知。

吉祥物原帧为 640×640 透明 PNG。Kitty 支持的终端使用原帧，其他终端按可用空间使用 48 或 64 像素的真彩色半块。

## 贡献与验证

欢迎参与贡献。提交流程见 [贡献指南](CONTRIBUTING.md)，开发约束见 [AGENTS.md](AGENTS.md)。

```powershell
npm run typecheck
npm test
npm run build
```

测试使用离线模型和本机 HTTP 测试服务。Windows 目录联接用例需要相应的本机权限。

自有源码采用 [MIT](LICENSE) 许可，第三方和吉祥物素材许可见 [NOTICE](NOTICE.md)。
