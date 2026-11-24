# Ti

Ti 是独立的终端对话 harness。它用 Node.js 实现对话轮次、DeepSeek 流式请求、JSONL 会话和命令行交互，不依赖 Pi npm 包。当前使用 DeepSeek `deepseek-flash`，不提供工具调用。

## 运行

需要 Node.js 22.19 或更新版本。

```sh
npm start
```

也可通过全局 `ti` 命令启动。

- `/login` 保存 DeepSeek API Key，输入时隐藏
- `/new` 创建会话
- `/resume` 用方向键选择会话并回车恢复
- TTY 输入中按 Ctrl+J 换行
- `/exit` 或 Ctrl+C 退出

常见应用会把会话默认放在用户级数据目录，方便跨项目管理；凭据也应留在用户级配置或凭据管理器。Ti 为了让这个学习项目能直接检查 JSONL，特意把会话放在项目 `.ti/sessions/`，并通过 Git 忽略规则排除。API Key 保存在用户目录 `~/.ti/auth.json`，`DEEPSEEK_API_KEY` 环境变量优先。仍可读取用户 Ti 目录和 Pi 配置目录中的会话，恢复后写入项目 `.ti/`。`TI_SESSION_HOME` 可覆盖会话目录，`TI_HOME` 可覆盖凭据目录。

## 执行路径

TTY 模式下，`src/terminal-chat.ts` 使用 Node 原始按键输入和 ANSI 绘制全屏对话视口，采用 Pi 的用户消息蓝底、助手 Markdown、固定输入区和目录/模型页脚。非 TTY 输入保留 readline 行模式。界面调用 `src/agent.ts`，后者追加用户消息并请求 `src/deepseek.ts`。DeepSeek 模块用 fetch 解析 SSE，消息由 `src/sessions.ts` 写入 JSONL。

Ti 使用独立的线性会话记录，不解析 Pi 的压缩、分支编辑和扩展条目，也不复用 Pi 的 auth.json 解析、请求运行时或 TUI 组件。
