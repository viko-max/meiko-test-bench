# Meiko Test-Bench

Meiko Test-Bench 是一个基于 Pi 的多学科模型测评工具。它将题目和公开附件转换为模型可读输入，分别运行 **without tool** 与 **with tool**，保存答卷、用量、评分及复核记录。终端界面也支持独立聊天与搜题组卷。

**Creative Is All You Need**

## 开始使用

需要 Node.js 22.19 或更高版本。若使用 Python 答题工具，另需 Python 3.11 或更高版本。以下示例适用于 Windows PowerShell。

```powershell
npm ci
Copy-Item configs/models.example.json configs/models.json
npm run tui
```

仓库附带一组自写示例题。启动后用 `/bank` 查看，或用 `/run` 查看题集检查和模型选择流程。浏览题库和配置界面无需模型凭据。

要调用真实模型，请选择或编辑 `configs/models.json` 中的档案，并在进程环境中提供对应的 API Key。配置文件只存放环境变量名。真实测评以 `npm run tui -- --authorise-paid` 启动，随后在界面核对模型、模式、题量与预算再开始。

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

代码贡献者需要能够使用 **Codex**。提交流程见 [贡献指南](CONTRIBUTING.md)，开发约束见 [AGENTS.md](AGENTS.md)。

```powershell
npm run typecheck
npm test
npm run build
```

测试使用离线模型和本机 HTTP 测试服务。Windows 目录联接用例需要相应的本机权限。

自有源码采用 [MIT](LICENSE) 许可，第三方和吉祥物素材许可见 [NOTICE](NOTICE.md)。
