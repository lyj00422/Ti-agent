# Ti 工作交接

## 项目边界

Ti 是独立 harness。当前运行时没有 Pi npm 依赖，也不调用 Pi CLI。对话轮次、DeepSeek HTTP/SSE、凭据存取、线性 JSONL 会话和 readline 交互都由 Ti 自己实现。

Ti 保留既有项目需求：DeepSeek `deepseek-flash`、流式对话、会话新建与恢复、重启恢复、隐藏输入的 `/login`。当前不实现工具调用。

## 调用路径

`terminal-chat.ts` 收到一行文本并调用 main 提供的 send。入口调用 `runAgentTurn`。Agent 先持久化 user 消息，再调用 `streamReply`。DeepSeek SSE 的文本增量显示在终端。最终 assistant 消息追加到当前 JSONL。

`SessionStore` 新建 Ti v3 格式的线性 JSONL。它能读取原 Pi v3 普通线性聊天记录。历史记录只载入 Agent 内存，发送时仅追加新消息一次。旧目录只读兼容，迁入 Ti 目录后才写入。

## 数据目录

会话通常默认放在用户级数据目录，方便跨项目管理。本项目为了学习和检查持久化格式，特意将 JSONL 放在项目 `.ti/sessions/`，可用 `TI_SESSION_HOME` 覆盖。`.ti/` 已加入 Git 忽略规则，不进入提交。API Key 放在用户目录 `~/.ti/auth.json`，可用 `TI_HOME` 覆盖凭据目录。旧 Pi 目录通过 `PI_CODING_AGENT_DIR` 指定，否则按原默认值 `~/.pi/agent` 查找。

环境变量 `DEEPSEEK_API_KEY` 优先。新 Key 写到 `~/.ti/auth.json`。旧 auth.json 只兼容普通字面量 key，不解析 Pi 的命令或环境变量模板。

## 能力边界

- Agent 只处理文本消息，拒绝工具调用响应。
- 会话是线性的，不保留 Pi 的分支选择、压缩、上下文编辑、usage 或扩展状态。
- TTY 使用 Node 原始按键和 ANSI 绘制 Pi 风格全屏界面，包括用户消息底色、助手 Markdown、固定编辑区、状态和页脚。非 TTY 保留 readline 行模式。
- 当前包依赖为空，lockfile 只包含项目元数据。

## 验证

本轮聚焦 TTY 界面，使用 mock fetch 确认全屏视图、流式回复、`/new`、方向键 `/resume`、隐藏式 `/login` 和 `/exit`。Node 语法检查通过。没有改动消息请求或会话存储逻辑。
