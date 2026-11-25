# Ti

Ti 是一个面向本地代码库的终端编码 harness。它用 DeepSeek `deepseek-flash` 流式处理对话，并在同一轮中查看文件、修改代码、运行检查，再根据结果继续。对话、工具调用和结果保存在可检查的 JSONL 会话里。

## 快速开始

需要 Node.js 22.19 或更新版本。在仓库目录运行：

```sh
npm ci --ignore-scripts
npm start
```

启动后用 `/login` 保存 DeepSeek API Key，也可以提前设置 `DEEPSEEK_API_KEY`。在其他项目里使用时，从该项目目录运行 `node /path/to/Ti-agent/src/main.ts`。

试试输入「读 README.md，告诉我怎么恢复会话」。终端会显示文件读取状态，随后给出答案。

## 工具

| 用途 | 工具 |
|---|---|
| 读取、修改和创建文件 | `read` 读取文本或图片，`edit` 精确替换，`write` 创建或覆盖 |
| 定位代码 | `ls` 列目录，`find` 按 glob 找文件，`grep` 搜文件内容 |
| 运行检查 | `bash` 运行命令，Windows 上另提供 `powershell` |

`grep` 和 `find` 分别使用 ripgrep 和 fd。可以通过 PATH 或 `TI_RG_PATH`、`TI_FD_PATH` 提供可执行文件。Windows 上 `bash` 使用 Ubuntu-24.04 WSL，`grep` 在缺少原生 ripgrep 时会使用同一发行版的 `/usr/bin/rg`。文件和 Shell 工具以启动 Ti 的账号权限运行。

### 加载本地扩展

在 Ti 仓库运行以下命令，再输入「调用 hello 工具向 Ti 打招呼」。

```sh
npm start -- -e ./examples/extensions/hello.ts --tools hello
```

`-e` 可以重复使用，路径相对于 Ti 的启动目录解析。JS 或 TS 文件默认导出一个接收 `ExtensionAPI` 的函数，通过 `pi.registerTool()` 注册工具。`--tools` 接受逗号分隔的工具名，用来选择启动时启用的工具。扩展代码在 Ti 进程中运行，使用启动账号的权限。

扩展加载器把 `hello` 的定义交给工具注册表，同一份请求快照用于声明和执行。注册表先校验参数，再运行 `tool_call` 钩子，钩子可以改写参数或拦截调用。`tool_result` 钩子可以修改最终结果。工具执行过程可通过 `onUpdate` 报告，最终结果由执行循环保存并回传给模型。会话记录可以保留 JSON 可序列化的 `details` 和 `structuredContent`。 [hello 示例](examples/extensions/hello.ts) · [扩展加载器](src/tools/extensions.ts) · [工具注册表](src/tools/registry.ts) · [执行循环](src/agent/loop.ts)

### 配置 MCP 服务

Ti 默认读取 `~/.ti/mcp.json`。设置 `TI_HOME` 后从该目录读取，也可以用 `--mcp-config <path>` 指定本次使用的配置文件。

可以用命令管理用户级配置。以下示例添加 Firecrawl 官方托管服务，查看连接状态和工具列表，再启动普通会话。

```sh
ti mcp add firecrawl --url https://mcp.firecrawl.dev/v2/mcp
ti mcp list
ti
```

在会话里输入「先用 `tool_search` 找到 `firecrawl_scrape`，再抓取 `https://firecrawl.dev` 的页面标题」。终端会先显示搜索调用，再显示抓取调用。移除服务时运行 `ti mcp remove firecrawl`。

本地 stdio 示例使用 Time MCP Server，需要 `uvx`。

```json
{
  "mcpServers": {
    "time": {
      "command": "uvx",
      "args": ["mcp-server-time"]
    }
  }
}
```

保存配置后，可运行 `npm start -- --tools mcp__time__get_current_time`，再让 Ti 用该工具查询上海时间。

下面是 Streamable HTTP 配置。将示例 URL 换成服务的 MCP 地址，并在启动 Ti 的环境中设置 `DOCS_MCP_TOKEN`。

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://docs.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${DOCS_MCP_TOKEN}"
      }
    }
  }
}
```

stdio 支持 `cwd` 和 `env`，相对工作目录从 Ti 的启动目录解析。HTTP 服务通过 `headers` 传入凭据。`env` 和 `headers` 支持 `${变量名}`。每个服务可用 `enabled: false` 停用，或用 `timeout` 设置单次请求的超时秒数，默认 60 秒。

Ti 启动时连接服务，并以 `mcp__<server>__<tool>` 注册发现的工具。服务的 `exposure` 默认为 `deferred`。模型通过 `tool_search` 查找工具，命中项从下一次请求开始可用，并随会话保存。设为 `direct` 可从第一条请求声明该服务的工具，设为 `hidden` 则从模型调用和搜索中隐藏。使用 `--tools` 时，点名的非隐藏工具可直接调用。把 `tool_search` 加进列表可搜索其他按需工具。

单台服务器失败时，Ti 会报告服务名和阶段，其他服务继续加载。退出时关闭连接和 Ti 启动的 MCP 子进程。 [管理命令](src/tools/mcp-cli.ts) · [连接流程](src/tools/mcp-client.ts) · [工具搜索](src/tools/tool-search.ts) · [本地协议测试](test/mcp.test.ts)

### SDK

同进程调用方可以用 `createAgentSession({ cwd, store, stream, contextWindow, customTools, extensionPaths, mcpServers })` 创建会话。返回值包含 `session` 和异步 `dispose()`，后者负责释放该会话建立的 MCP 连接。调用方自己管理连接时，可以使用 `registerMcpTools(registry, serverName, client, exposure?)`。这个底层接口默认直接声明工具。 [SDK 入口](src/sdk.ts)

## 会话

| 命令 | 行为 |
|---|---|
| `/new`、`/resume` | 新建会话或从已有会话继续 |
| `/retry` | 从已保存的消息和工具结果恢复未完成的轮次 |
| `/compact` | 摘要早期对话，保留完整的近期轮次 |
| `/usage` | 查看服务端上报的用量和本地上下文估算 |
| `/exit` | 退出 Ti |

在交互终端按 Esc 停止当前操作，按 Ctrl+J 在输入中换行，空输入时用方向键浏览历史。

会话默认写入项目的 `.ti/sessions/`，凭据默认保存在用户目录的 `~/.ti/auth.json`。`TI_SESSION_HOME` 和 `TI_HOME` 可覆盖对应位置。需要读取旧数据时，将 `TI_LEGACY_HOME` 指向包含旧 `sessions/` 或 `auth.json` 的目录。项目的 `.ti/` 目录已加入 Git 忽略规则。

## 代码结构

- `src/agent/` 定义消息和执行循环。循环先保存工具调用，再执行并保存对应结果，最后把结果交给模型。
- `src/session/` 管理 JSONL 会话、上下文压缩、中止和重试。
- `src/tools/` 提供内置工具、注册表、扩展加载和 MCP 适配。`src/sdk.ts` 组装工具和会话。
- `src/providers/` 处理 DeepSeek 请求和流式响应。`src/terminal/` 提供交互终端和管道输入。

## 验证

```sh
node --test test/chat.test.ts test/tools.test.ts test/extensions.test.ts test/mcp.test.ts
```

测试使用模拟 DeepSeek 响应，并在临时目录中执行本地工具。工具测试需要上述搜索程序和 Shell 环境。
