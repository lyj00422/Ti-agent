# Ti 工作交接

## 当前进度

2026-11-24 在原有聊天基础上加入 Agent Loop、工具注册表和八个内置工具。Windows 注册 `read`、`bash`、`powershell`、`edit`、`write`、`grep`、`find` 和 `ls`。TTY 和 readline 共用会话、工具和流式事件。

2026-11-25 加入与 Pi 工具层对齐的本地扩展、工具启用列表和执行钩子。扩展通过 `-e` 显式加载，SDK 通过同进程接口注入工具，MCP 通过调用方提供的客户端适配成直接声明的工具。用 `examples/extensions/hello.ts` 和 `test/extensions.test.ts` 可以逐步查看和复现。

2026-11-25 接入 Pi 的独立 MCP 客户端 `@earendil-works/pi-mcp@1.5.2`。CLI 和 SDK 均可从配置连接 stdio 和 Streamable HTTP 服务，启动时注册发现的工具，退出时关闭连接。CLI 默认读取用户级 `mcp.json`，项目配置通过 `--mcp-config` 显式指定。用 `test/mcp.test.ts` 验证握手、发现、调用和关闭。

Ti 的配置式 MCP 服务默认按需声明。`tool_search` 使用 Pi 的 BM25 排序，搜索结果随工具结果写入会话，从下一次请求起启用。恢复会话时，仍可用的搜索结果会重新进入模型的工具列表。`ti mcp add/list/remove` 管理用户级配置，`list` 实际连接并列出发现的工具。

## 项目边界

Ti 是独立 harness。对话轮次、DeepSeek HTTP/SSE、凭据存取、线性 JSONL 会话和 readline 交互都由 Ti 自己实现。

工具注册入口在 `src/tools/index.ts`。实现按文件、搜索、Shell、图像与输出分目录。文件命令与工具注册表通过工具定义相接，Bash 和 PowerShell 共享执行结果、超时和输出截断逻辑。许可信息见 `THIRD_PARTY_NOTICES.md`。

## 调用路径

`main.ts` 调用 `src/sdk.ts` 组装内置工具、外部扩展和 `ChatSession`。每次模型请求捕获当前工具列表，用同一份快照生成声明、提示和执行函数。`src/agent/loop.ts` 调用模型，提交完整助手消息，按顺序执行调用，并在继续请求模型前提交每个结果。单轮上限是 32 批调用。会话层持有整轮中止信号，并根据当前工具列表计算上下文预算和提示。

`src/agent/messages.ts` 定义文本、图片、工具调用和工具结果。`src/providers/deepseek.ts` 按 SSE 索引组装工具参数，并在请求中用 `tool_call_id` 关联结果。图片经过格式转换或缩放后，由适配器随工具结果附上。

`SessionStore` 读写 Ti v3 线性 JSONL，也能读取旧版 v3 文本聊天记录。旧目录会话在首次写入时复制到主目录。`/retry` 从已保存的用户消息或工具结果继续。进程重启后，若末尾有调用缺少结果，会追加同 ID 的「结果未知」记录，供模型先检查现场。压缩保留完整的近期用户轮次，早期工具调用和结果纳入摘要。

上下文估算优先使用压缩后最近一次有效的实际用量，再估算后续消息。缺少基准时按文本 UTF-8 长度近似。`deepseek-flash` 的上下文窗口配置为 100 万 token。Ti 为普通回复预留并限制 16,384 token，保留近期原文的目标是 20,000 token，摘要输出上限为 4,096 token。手动 `/compact` 和发送前自动压缩共用流程。API 明确报告上下文超限时，`/retry` 先尝试压缩再复用原问题。失败、截断或无效摘要不会启用新边界，已上报的摘要用量仍计入累计。

## 数据目录

会话通常默认放在用户级数据目录，方便跨项目管理。本项目为了学习和检查持久化格式，特意将 JSONL 放在项目 `.ti/sessions/`，可用 `TI_SESSION_HOME` 覆盖。`.ti/` 已加入 Git 忽略规则，不进入提交。API Key 放在用户目录 `~/.ti/auth.json`，可用 `TI_HOME` 覆盖凭据目录。需要读取旧目录时，通过 `TI_LEGACY_HOME` 指定。

环境变量 `DEEPSEEK_API_KEY` 优先。新 Key 写到 `~/.ti/auth.json`。旧 auth.json 只兼容普通字面量 key，不解析命令或环境变量模板。

## 能力边界

- Windows 上 `bash` 使用 Ubuntu-24.04 WSL，并在取消时终止对应 Linux 进程组。本机 Git 使用 `powershell`。Shell 和文件工具使用启动账号的权限。
- `find` 沿用 `fd`。本机安装的是 `D:\ruanjian\fd\fd.exe`，版本 10.5.2。`grep` 优先使用本机 `rg`，Windows 缺少原生副本时使用 WSL。
- TTY 支持 Esc 停止，Ctrl+C 退出并等待当前操作收尾。两种终端入口都显示工具调用和结果状态。
- 用量统计以 API 实报为准。会话累计包含摘要请求，模型上下文估算只计算本轮投影。

## 验证

`node --test test/chat.test.ts test/tools.test.ts test/extensions.test.ts test/mcp.test.ts` 覆盖聊天、内置工具、本地扩展、SDK 注入、MCP 注册和传输、图片回传、工具分片、重启重试、工具轮次压缩和终端入口。真实模型体验示例见 README。

手动体验时，用 `npm start` 启动 Ti，聊几轮后执行 `/usage` 查看实报用量和上下文估算，再用 `/compact` 压缩早期对话。重启后继续当前会话，可以在 JSONL 中查看完整消息和追加的压缩记录。
\n
