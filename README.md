# Ti

本地项目里的终端 coding agent。Ti 会读写文件、运行命令，根据结果继续完成任务，并把会话保存在本地。

## 快速开始

需要 Node.js 22.19 或更新版本。

```sh
git clone https://github.com/lyj00422/Ti-agent.git
cd Ti-agent
npm ci --ignore-scripts
npm start
```

启动后：

1. 输入 `/login`，保存模型供应商的 API Key。
2. 输入 `/model`，选择模型。
3. 输入一个任务，例如 `读 README.md，告诉我这个项目怎么启动`。

也可以直接使用环境变量提供密钥，例如 `OPENAI_API_KEY`、`GEMINI_API_KEY` 或 `DEEPSEEK_API_KEY`。

在其他项目里运行 Ti：

```sh
cd your-project
node /path/to/Ti-agent/src/main.ts
```

## 常用操作

| 命令 | 作用 |
| --- | --- |
| `/model` | 选择模型 |
| `/login [provider]` | 保存或更新 API Key |
| `/new` | 新建会话 |
| `/resume` | 恢复已有会话 |
| `/retry` | 继续未完成的任务 |
| `/compact` | 压缩早期对话 |
| `/usage` | 查看用量 |
| `/exit` | 退出 |

全屏终端按 `Shift+Tab` 切换思考档位，按 `Esc` 停止当前操作。

## 权限

Ti 默认在每次工具调用前询问。输入 `y` 执行，输入 `n` 拒绝。

```sh
npm start -- --yolo
```

`--yolo` 会跳过确认，直接执行工具。SDK 默认也需要权限确认，只有显式设置 `permissionMode: "allow"` 才会跳过。

## 内置工具

Ti 自带文件读写、目录浏览、代码搜索和 Shell 工具。Windows 上另提供 PowerShell，`bash` 使用 WSL。

## 模型

Ti 内置 OpenAI、Anthropic、Gemini、DeepSeek、OpenRouter、Kimi、MiniMax、智谱、阿里云百炼、SiliconFlow、Groq、Mistral、xAI、Together AI、Cerebras 和 Fireworks AI。

自定义兼容服务可以写入 `~/.ti/models.json`，或通过 `TI_MODELS_FILE` 指定配置文件。支持 `openai-completions`、`anthropic-messages` 和 `google-generative-ai` 协议。

## 扩展

扩展可以注册工具、模型和钩子。用 `-e` 加载 JS 或 TS 文件：

```sh
npm start -- -e ./examples/extensions/hello.ts --tools hello
```

扩展默认导出一个接收 `ExtensionAPI` 的函数。扩展代码在 Ti 进程中运行，使用当前账号的权限。Ti 不审核或隔离扩展，请只加载自己信任的代码。

- [工具扩展示例](examples/extensions/hello.ts)
- [模型扩展示例](examples/extensions/model-provider.ts)

## MCP

Ti 默认从 `~/.ti/mcp.json` 读取 MCP 服务，也可以用 `--mcp-config <path>` 指定配置。

```sh
npm run ti -- mcp add firecrawl --url https://mcp.firecrawl.dev/v2/mcp
npm run ti -- mcp list
```

MCP 工具默认通过 `codemode` 按需发现和调用，不会全部放进模型的工具列表。Codemode 脚本可以使用 `ALL_TOOLS`、`searchTools()`、`describeTool()` 和 `tools.<name>(args)`。嵌套调用仍会经过 Ti 的权限确认。

需要直接暴露工具时，在服务配置里设置 `exposure` 为 `direct`、`deferred` 或 `hidden`。

## RPC

用 `--mode rpc` 启动 JSONL 接口，命令和响应通过 stdin/stdout 传递，诊断信息写入 stderr：

```sh
npm run ti -- --mode rpc
```

RPC 支持 prompt、steer、follow-up、取消、队列管理、状态和消息查询、模型设置、会话压缩、重试及权限响应。它用于控制 Ti，不提供远程工具注册。

## SDK

`createAgentSession()` 可以在同一个 Node.js 进程中创建 Agent 和会话。宿主可以注入模型、工具、扩展、资源加载器和权限处理器。

```ts
import { createAgentSession } from "./src/sdk.ts";

const runtime = await createAgentSession({
  cwd,
  store,
  stream,
  contextWindow: 100_000,
});
```

完整入口见 [src/sdk.ts](src/sdk.ts)。

## 会话位置

会话默认保存在项目的 `.ti/sessions/`，凭据保存在用户目录的 `~/.ti/auth.json`。使用 `TI_SESSION_HOME` 和 `TI_HOME` 可以更改对应目录。

## 测试

```sh
node --test test/agent.test.ts test/chat.test.ts test/tools.test.ts test/extensions.test.ts test/mcp.test.ts test/rpc.test.ts
```
