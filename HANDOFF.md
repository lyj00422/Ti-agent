# Ti 工作交接

## 当前进度

2026-11-24 完成纯文本聊天阶段。TTY 和 readline 共用会话层，支持流式聊天、会话恢复、失败后重试、用量查询和上下文压缩。下一阶段接入第一个工具和聊天系统提示词。收到工具调用时，下一阶段需要保存助手的调用记录、追加带对应调用 ID 的工具结果，再从已有上下文继续生成。

## 项目边界

Ti 是独立 harness。当前运行时没有 Pi npm 依赖，也不调用 Pi CLI。对话轮次、DeepSeek HTTP/SSE、凭据存取、线性 JSONL 会话和 readline 交互都由 Ti 自己实现。

Ti 保留既有项目需求：DeepSeek `deepseek-flash`、流式对话、会话新建与恢复、重启恢复、隐藏输入的 `/login`。当前不实现工具调用。

## 调用路径

`main.ts` 把 DeepSeek 的流式生成函数注入 `ChatSession`。TTY 和 readline 都使用该会话层的发送、重试、切换和压缩入口。会话层持有本次操作的中止信号。普通发送先写入用户消息，重试直接复用历史，再由同一条生成路径构造上下文、发送请求和保存助手消息。

`agent.ts` 定义内容块、模型流事件和最终助手消息。DeepSeek 适配器向终端传递文本和用量事件，最终返回文本块、结束原因、可选用量和错误。

`SessionStore` 读写 Ti v3 线性 JSONL，也能读取原 Pi v3 的普通文本聊天记录。旧目录会话在首次写入时复制到主目录。压缩记录保存摘要、`firstKeptEntryId`、压缩前 token 估算和可用的摘要请求用量。恢复从最新压缩记录重建模型上下文，显示仍使用完整历史。

上下文估算优先使用压缩后最近一次有效的实际用量，再估算后续消息。缺少基准时按文本 UTF-8 长度近似。模型窗口采用本地 Pi 对 `deepseek-flash` 的 100 万 token 配置。Ti 为普通回复预留并限制 16,384 token，保留近期原文的目标是 20,000 token，摘要输出上限为 4,096 token。手动 `/compact` 和发送前自动压缩共用流程。API 明确报告上下文超限时，`/retry` 先尝试压缩再复用原问题。失败、截断或无效摘要不会启用新边界，已上报的摘要用量仍计入累计。

## 数据目录

会话通常默认放在用户级数据目录，方便跨项目管理。本项目为了学习和检查持久化格式，特意将 JSONL 放在项目 `.ti/sessions/`，可用 `TI_SESSION_HOME` 覆盖。`.ti/` 已加入 Git 忽略规则，不进入提交。API Key 放在用户目录 `~/.ti/auth.json`，可用 `TI_HOME` 覆盖凭据目录。旧 Pi 目录通过 `PI_CODING_AGENT_DIR` 指定，否则按原默认值 `~/.pi/agent` 查找。

环境变量 `DEEPSEEK_API_KEY` 优先。新 Key 写到 `~/.ti/auth.json`。旧 auth.json 只兼容普通字面量 key，不解析 Pi 的命令或环境变量模板。

## 能力边界

- 当前范围是单模型、线性纯文本聊天。工具和聊天系统提示词留到下一阶段。
- TTY 支持 Esc 停止，Ctrl+C 退出并等待当前操作收尾。readline 同样支持 `/retry`、`/usage` 和 `/compact`。
- 用量统计以 API 实报为准。会话累计包含摘要请求，模型上下文估算只计算本轮投影。

## 验证

`node --test test/chat.test.ts` 的 9 项回归测试覆盖 SSE 文本和用量、请求错误、重启重试、压缩与恢复、旧会话迁入、CLI 和 TTY 操作。测试使用模拟 DeepSeek 响应和临时会话目录，并用小上下文窗口触发自动压缩。

手动体验时，用 `npm start` 启动 Ti，聊几轮后执行 `/usage` 查看实报用量和上下文估算，再用 `/compact` 压缩早期对话。重启后继续当前会话，可以在 JSONL 中查看完整消息和追加的压缩记录。

本地 Pi 对照入口为 `packages/agent/src/agent-loop.ts` 中的继续生成，`packages/ai/src/api/openai-completions.ts` 中的流式用量解析，以及 `packages/coding-agent/src/core/compaction/compaction.ts` 中的上下文估算与压缩。
