interface WorkflowCommand {
	name: string;
	aliases: readonly string[];
	description: string;
	buildPrompt: (argument: string) => string;
}

const workflowCommands: readonly WorkflowCommand[] = [
	{
		name: "ref", aliases: [], description: "阅读文件并提出修改建议",
		buildPrompt: (argument) => `Read ${argument}, explain its current behavior, and suggest focused edits.`,
	},
	{
		name: "search", aliases: ["s"], description: "搜索项目并查看匹配文件",
		buildPrompt: (argument) => `Search the project for ${argument} and inspect the most relevant matching files.`,
	},
	{
		name: "fix", aliases: [], description: "定位并修复问题",
		buildPrompt: (argument) => argument
			? `Investigate and fix the issue in ${argument}. Run relevant checks.`
			: "Investigate the latest reported issue, identify its cause, fix it, and run relevant checks.",
	},
	{
		name: "test", aliases: ["t"], description: "运行测试",
		buildPrompt: (argument) => argument
			? `Run the relevant tests matching ${argument} and report the results.`
			: "Identify the project's test command, run the relevant test suite, and report the results.",
	},
	{
		name: "build", aliases: ["b"], description: "构建项目",
		buildPrompt: () => "Identify the project's build command, build it, and report the result.",
	},
	{
		name: "run", aliases: ["r"], description: "运行项目",
		buildPrompt: (argument) => argument
			? `Run the project with arguments ${argument} and report the result.`
			: "Identify how this project is run, run it, and report the result.",
	},
	{
		name: "commit", aliases: ["c"], description: "检查更改并创建提交",
		buildPrompt: (argument) => argument
			? `Review the current changes and create a commit with message: ${argument}`
			: "Review the current changes, summarize them, and create an appropriate commit.",
	},
	{
		name: "lint", aliases: ["l"], description: "运行代码检查",
		buildPrompt: (argument) => argument
			? `Run the project's lint checks on ${argument} and report any issues.`
			: "Identify and run the project's lint checks, then report any issues.",
	},
	{
		name: "format", aliases: ["fmt"], description: "格式化代码",
		buildPrompt: (argument) => argument
			? `Format ${argument} using the project's existing formatting rules.`
			: "Identify and run the project's formatter on the relevant source files.",
	},
	{
		name: "doc", aliases: ["d"], description: "创建或更新文档",
		buildPrompt: (argument) => argument
			? `Create or update documentation for ${argument}.`
			: "Review the project and create or update its relevant documentation.",
	},
];

export interface SlashCommand {
	name: string;
	description: string;
}

const builtinCommands: readonly SlashCommand[] = [
	{ name: "help", description: "打开命令导航" },
	{ name: "logout", description: "清除保存的 API 密钥" },
	{ name: "login", description: "保存或更新 API 密钥" },
	{ name: "goal", description: "设置工作目标" },
	{ name: "compact", description: "压缩上下文" },
	{ name: "reload", description: "重新加载扩展" },
	{ name: "model", description: "选择或切换模型" },
	{ name: "theme", description: "切换终端主题" },
	{ name: "mode", description: "选择 ask、default 或 yolo 权限模式" },
	{ name: "resume", description: "恢复已有会话" },
	{ name: "undo", description: "撤销上一轮改动" },
	{ name: "clear", description: "开始新会话" },
	{ name: "cost", description: "查看用量" },
	{ name: "thinking", description: "选择思考强度" },
	{ name: "new", description: "新建会话" },
	{ name: "retry", description: "继续未完成的请求" },
	{ name: "usage", description: "查看 token 用量" },
	{ name: "exit", description: "退出 Ti" },
];

export function listSlashCommands(): SlashCommand[] {
	return [
		...builtinCommands,
		...workflowCommands.map(({ name, aliases, description }) => ({
			name,
			description: aliases.length ? `${description}（别名 /${aliases.join("、/")}）` : description,
		})),
	];
}

export type WorkflowCommandResult =
	| { type: "help"; text: string }
	| { type: "prompt"; text: string }
	| { type: "error"; text: string }
	| undefined;

export function resolveWorkflowCommand(input: string): WorkflowCommandResult {
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input.trim());
	if (!match) return undefined;
	const [, requested, rawArgument = ""] = match;
	const argument = rawArgument.trim();
	if (requested === "help" || requested === "keys" || requested === "shortcuts") {
		return { type: "help", text: [
			"命令导航",
			...listSlashCommands().map(({ name, description }) => `/${name}  ${description}`),
			"Tab  切换思考强度",
			"Shift+Tab  切换权限模式",
		].join("\n") };
	}
	const command = workflowCommands.find(({ name, aliases }) => name === requested || aliases.includes(requested));
	if (!command) return undefined;
	if ((command.name === "ref" || command.name === "search") && !argument) {
		return { type: "error", text: `Usage: /${command.name} <${command.name === "ref" ? "file" : "pattern"}>` };
	}
	return { type: "prompt", text: command.buildPrompt(argument) };
}
