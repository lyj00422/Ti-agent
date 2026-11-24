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
- `/retry` 从当前会话重试最后一个失败、中止或尚未回复的问题
- `/usage` 查看最近回复和会话累计的实报用量，以及当前上下文估算
- `/compact` 把早期对话压缩成摘要，保留最近对话原文
- TTY 空输入时用 ↑ / ↓ 翻看历史，生成或压缩期间按 Esc 停止当前操作
- TTY 输入中按 Ctrl+J 换行
- `/exit` 或 Ctrl+C 退出

常见应用会把会话默认放在用户级数据目录，方便跨项目管理；凭据也应留在用户级配置或凭据管理器。Ti 为了让这个学习项目能直接检查 JSONL，特意把会话放在项目 `.ti/sessions/`，并通过 Git 忽略规则排除。API Key 保存在用户目录 `~/.ti/auth.json`，`DEEPSEEK_API_KEY` 环境变量优先。仍可读取用户 Ti 目录和 Pi 配置目录中的会话，恢复后写入项目 `.ti/`。`TI_SESSION_HOME` 可覆盖会话目录，`TI_HOME` 可覆盖凭据目录。

## 执行路径

TTY 使用 Node 原始按键和 ANSI 绘制全屏对话，非 TTY 使用 readline。两个入口共用 `ChatSession`，由它管理当前会话和运行状态。发送时先保存用户消息，再构造模型上下文，DeepSeek 适配器解析 SSE 并返回完整的助手消息。已有问题重试时直接从当前上下文生成。

Ti 在发请求前检查上下文预算，超出预算时先尝试压缩。JSONL 保留完整对话，并追加摘要和保留边界。之后的请求以及重启恢复都从同一边界构造「摘要 + 近期原文」。缓存命中量由 DeepSeek 上报，仍计入上下文占用。缺失的命中量显示为未知。

运行回归测试可用 `node --test test/chat.test.ts`。测试使用模拟响应和临时会话目录。
