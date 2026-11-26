# Ti

Ti 是一个运行在本地项目里的终端 coding agent。它能读写文件、运行命令，并根据结果继续完成任务。会话保存在本地，方便恢复和检查。

## 安装

需要 Node.js 22.19 或更新版本。

```sh
git clone https://github.com/lyj00422/Ti-agent.git
cd Ti-agent
npm ci --ignore-scripts
npm start
```

启动后输入 `/login` 保存模型供应商的 API Key，再输入 `/model` 选择模型。也可以用环境变量提供密钥，例如 `OPENAI_API_KEY` 或 `GEMINI_API_KEY`。

在自己的项目里使用 Ti 时，从项目目录运行：

```sh
node /path/to/Ti-agent/src/main.ts
```

## 模型

Ti 内置 OpenAI、Anthropic、Gemini、DeepSeek、OpenRouter、Kimi、MiniMax、智谱、阿里云百炼、SiliconFlow、Groq、Mistral、xAI、Together AI、Cerebras 和 Fireworks AI。

自定义兼容服务可写入 `~/.ti/models.json`，或通过 `TI_MODELS_FILE` 指定配置文件。Ti 支持 `openai-completions`、`anthropic-messages` 和 `google-generative-ai` 协议。扩展也可以注册模型供应商，见 [示例](examples/extensions/model-provider.ts)。

全屏终端按 `Shift+Tab` 切换思考档位，输入 `/thinking` 查看选项。

## 工具与权限

Ti 自带文件读写、搜索和 Shell 工具。Windows 上另提供 PowerShell，`bash` 使用 WSL。

每次调用工具前，Ti 默认询问是否批准。输入 `y` 执行，输入 `n` 拒绝。`--yolo` 会跳过确认：

```sh
npm start -- --yolo
```

## 扩展

用 `-e` 加载 JS 或 TS 扩展。扩展默认导出一个接收 `ExtensionAPI` 的函数，可注册工具、模型和钩子。

```sh
npm start -- -e ./examples/extensions/hello.ts --tools hello
```

扩展代码在 Ti 进程中运行，使用当前账号的权限。Ti 不审核或隔离扩展，请只加载你信任的代码。更多接口见 [扩展示例](examples/extensions/hello.ts) 和 [模型扩展示例](examples/extensions/model-provider.ts)。

## MCP

Ti 默认从 `~/.ti/mcp.json` 读取 MCP 服务，也可以用 `--mcp-config <path>` 指定配置。

```sh
npm run ti -- mcp add firecrawl --url https://mcp.firecrawl.dev/v2/mcp
npm run ti -- mcp list
```

MCP 工具默认通过 `codemode` 按需发现和调用，不会全部放进模型的工具列表。脚本可使用 `ALL_TOOLS`、`searchTools()`、`describeTool()` 和 `tools.<name>(args)`。嵌套调用仍会经过 Ti 的权限确认。也可为服务设置 `exposure` 为 `direct`、`deferred` 或 `hidden`。

## 外部进程

用 `--mode rpc` 启动 JSONL 接口。命令和响应通过 stdin/stdout 传递，诊断信息写入 stderr。

```sh
npm run ti -- --mode rpc
```

RPC 支持 prompt、steer、follow-up、取消、队列管理、状态和消息查询、模型设置、会话压缩、重试及权限响应。它用于控制 Ti，不提供远程工具注册。

## SDK

`createAgentSession()` 可在同一 Node.js 进程中创建 Agent 和会话。宿主可注入模型、工具、扩展、资源加载器和权限处理器。工具默认需要确认，设 `permissionMode: "allow"` 可跳过确认。入口见 [src/sdk.ts](src/sdk.ts)。

## 会话

会话默认保存在项目的 `.ti/sessions/`，凭据保存在用户目录的 `~/.ti/auth.json`。`TI_SESSION_HOME` 和 `TI_HOME` 可更改对应目录。

常用命令：`/new` 新建会话，`/resume` 恢复会话，`/retry` 继续未完成的任务，`/compact` 压缩早期对话，`/usage` 查看用量，`/exit` 退出。按 Esc 可停止当前操作。

## 测试

```sh
node --test test/agent.test.ts test/chat.test.ts test/tools.test.ts test/extensions.test.ts test/mcp.test.ts test/rpc.test.ts
```
