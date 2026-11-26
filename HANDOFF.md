# Ti 工作交接

## 当前进度

2026-11-26 模型接入统一到 Ti 自有 provider registry。内置目录、兼容 `models.json` 和扩展 `registerProvider()` 共用模型组合、`/login` 凭据存取与 `/model` 选择。扩展可注册兼容协议配置或提供自己的流式实现。USTC 通过用户的 `models.json` 注册，复用 Anthropic Messages 适配器，并沿用 `ustc` 凭据 ID。OpenAI Chat Completions、Anthropic Messages 与 Gemini 的适配器均由 Ti 源码实现。

2026-11-25 将执行循环抽到 `src/agent/agent.ts`，提供 Agent/turn/message/tool 生命周期事件、异步订阅结算、steer/follow-up 队列和默认并行工具调度。工具定义可声明 sequential，结果仍按模型调用顺序提交。会话门面改为 `AgentSession`，入口改为 `prompt`/`continue`，SDK 返回 `agent` 与 `session`。DeepSeek 实现接入 `ModelProvider`/`ModelStream` 抽象并由模型描述提供 ID 和 token 上限。`AgentResourceLoader` 负责可替换的工具/扩展/MCP 组装，默认实现保留现有加载行为。旧 `src/agent/loop.ts` 和 `ChatSession` API 已删除。

2026-11-24 在原有聊天基础上加入 Agent Loop、工具注册表和八个内置工具。Windows 注册 `read`、`bash`、`powershell`、`edit`、`write`、`grep`、`find` 和 `ls`。TTY 和 readline 共用会话、工具和流式事件。

2026-11-25 加入与 Pi 工具层对齐的本地扩展、工具启用列表和执行钩子。扩展通过 `-e` 显式加载，SDK 通过同进程接口注入工具，MCP 通过调用方提供的客户端适配成直接声明的工具。用 `examples/extensions/hello.ts` 和 `test/extensions.test.ts` 可以逐步查看和复现。

2026-11-27 内核开始按 Agent 循环、上下文会话和工具执行三个边界重整。Agent 对 `ToolExecutorSnapshot` 端口编程，单个 prompt 移除了 32 回合硬上限。工具注册表默认逐次询问，拒绝结果带 `terminate`；TTY 提供本地确认，RPC 客户端可以响应权限请求，`--yolo` 或 SDK 的 `permissionMode: "allow"` 跳过确认。扩展仍在宿主进程运行，由用户自行信任。

MCP `exposure` 默认改为 `codemode`。工具元数据留在内部目录中，模型仅看到 `codemode`，脚本通过 QuickJS/WASM worker 使用 `ALL_TOOLS`、`searchTools()`、`describeTool()` 和 `tools.<name>()`。嵌套工具调用仍通过同一注册表、权限处理与工具钩子。`direct`、`hidden` 保留，`deferred` 和 `tool_search` 继续支持显式按需直接暴露。Codemode 引擎使用独立 `quickjs-wasi`，不导入 Pi runtime。

增加 `--mode rpc` 的 JSONL stdin/stdout 子进程接口，支持 prompt、steer/follow-up、abort、队列清理、状态/消息、模型/思考设置、compact、retry、权限响应和 shutdown，并流式转发 Agent 事件。MCP 仍负责外部工具服务接入，RPC 不提供通用远程工具注册。

## 项目边界

Ti 是独立 harness。对话轮次、DeepSeek HTTP/SSE、凭据存取、线性 JSONL 会话和 readline 交互都由 Ti 自己实现。

模型实现必须保持 Ti 自有：借鉴其他项目的 provider 职责划分和 API 协议处理思路，在 Ti 的 `ModelDescriptor`、`ModelProvider`、`ModelStream` 接口内实现。禁止把 Pi AI/provider/model-catalog 包作为 npm 运行时依赖，禁止从 Pi 包导入模型实现代码，禁止直接复制 Pi 构建产物到 Ti。内置供应商在 `src/providers/catalog.ts` 维护，OpenAI-compatible、Anthropic Messages、Gemini 请求由 Ti 自有适配器处理。兼容配置格式不等于运行时依赖。

工具注册入口在 `src/tools/index.ts`。实现按文件、搜索、Shell、图像与输出分目录。文件命令与工具注册表通过工具定义相接，Bash 和 PowerShell 共享执行结果、超时和输出截断逻辑。许可信息见 `THIRD_PARTY_NOTICES.md`。

## 调用路径

`main.ts` 调用 `src/sdk.ts` 组装内置工具、外部扩展、MCP、模型 Provider 与 `AgentSession`，并选择 TTY 或 RPC 宿主。`Agent` 管理不设固定回合上限的运行循环和输入队列，`AgentSession` 提供持久化 transcript、上下文预算和压缩请求。工具快照在每次模型请求时捕获，默认并行执行，声明 sequential 的工具会令整批顺序执行。工具权限在注册表的执行管线中检查。

`src/agent/messages.ts` 定义文本、图片、工具调用和工具结果。`src/providers/model-registry.ts` 组合三种模型来源，按协议选择内置或扩展流式实现。`src/providers/openai-completions.ts` 按 SSE 索引组装工具参数，并在请求中用 `tool_call_id` 关联结果。图片经过格式转换或缩放后，由适配器随工具结果附上。

`SessionStore` 读写 Ti v3 线性 JSONL，也能读取旧版 v3 文本聊天记录。旧目录会话在首次写入时复制到主目录。`/retry` 从已保存的用户消息或工具结果继续。进程重启后，若末尾有调用缺少结果，会追加同 ID 的「结果未知」记录，供模型先检查现场。工具结果可记录 `terminate`，供恢复和批次语义判断。压缩保留完整的近期用户轮次，早期工具调用和结果纳入摘要。

上下文估算优先使用压缩后最近一次有效的实际用量，再估算后续消息。缺少基准时按文本 UTF-8 长度近似。`deepseek-flash` 的上下文窗口配置为 100 万 token。Ti 为普通回复预留并限制 16,384 token，保留近期原文的目标是 20,000 token，摘要输出上限为 4,096 token。手动 `/compact` 和发送前自动压缩共用流程。API 明确报告上下文超限时，`/retry` 先尝试压缩再复用原问题。失败、截断或无效摘要不会启用新边界，已上报的摘要用量仍计入累计。

## 数据目录

会话通常默认放在用户级数据目录，方便跨项目管理。本项目为了学习和检查持久化格式，特意将 JSONL 放在项目 `.ti/sessions/`，可用 `TI_SESSION_HOME` 覆盖。`.ti/` 已加入 Git 忽略规则，不进入提交。API Key 放在用户目录 `~/.ti/auth.json`，可用 `TI_HOME` 覆盖凭据目录。需要读取旧目录时，通过 `TI_LEGACY_HOME` 指定。

凭据保存到 `~/.ti/auth.json`，按 provider ID 隔离。各 provider 也可通过自身 API Key 环境变量认证。旧 auth.json 只兼容普通字面量 key，不解析命令或环境变量模板。

## 能力边界

- Windows 上 `bash` 使用 Ubuntu-24.04 WSL，并在取消时终止对应 Linux 进程组。本机 Git 使用 `powershell`。Shell 和文件工具使用启动账号的权限。
- `find` 沿用 `fd`。本机安装的是 `D:\ruanjian\fd\fd.exe`，版本 10.5.2。`grep` 优先使用本机 `rg`，Windows 缺少原生副本时使用 WSL。
- TTY 支持 Esc 停止，Ctrl+C 退出并等待当前操作收尾。两种终端入口都显示工具调用和结果状态。
- 用量统计以 API 实报为准。会话累计包含摘要请求，模型上下文估算只计算本轮投影。

## 验证

`node --test test/agent.test.ts test/chat.test.ts test/tools.test.ts test/extensions.test.ts test/mcp.test.ts test/rpc.test.ts` 覆盖实际变更的 Agent 超过 32 轮、工具授权终止、Codemode 嵌套 MCP 调用、RPC 命令/事件和现有主要会话行为。模型端点使用模拟响应验证。

手动体验时，用 `npm start` 启动 Ti，聊几轮后执行 `/usage` 查看实报用量和上下文估算，再用 `/compact` 压缩早期对话。重启后继续当前会话，可以在 JSONL 中查看完整消息和追加的压缩记录。
\n
