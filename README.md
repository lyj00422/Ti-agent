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
- `src/tools/` 按文件、搜索、Shell、图片及输出组织工具和配套逻辑，入口负责注册工具。
- `src/providers/` 处理 DeepSeek 请求和流式响应。`src/terminal/` 提供交互终端和管道输入。

## 验证

```sh
node --test test/chat.test.ts test/tools.test.ts
```

测试使用模拟 DeepSeek 响应，并在临时目录中执行本地工具。工具测试需要上述搜索程序和 Shell 环境。
