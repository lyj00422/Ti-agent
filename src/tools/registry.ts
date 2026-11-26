import type { Static, TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { errorMessage } from "../agent/messages.ts";
import type { ImageContent, TextContent, ToolCall, ToolDeclaration } from "../agent/messages.ts";
import { createToolSearch, TOOL_SEARCH_NAME } from "./tool-search.ts";

export interface ToolResult<Details = unknown> {
	content: Array<TextContent | ImageContent>;
	details?: Details;
	structuredContent?: unknown;
	isError?: boolean;
}

export interface ToolContext {
	readonly cwd: string;
}

export interface ToolDefinition<Schema extends TSchema = TSchema, Details = unknown> {
	name: string;
	label: string;
	description: string;
	parameters: Schema;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
	outputSchema?: TSchema;
	constrainedSampling?: { type: "json_schema"; strict: "prefer" };
	executionMode?: "parallel" | "sequential";
	defaultActive?: boolean;
	prepareArguments?: (args: unknown) => Static<Schema>;
	execute(
		id: string,
		args: Static<Schema>,
		signal: AbortSignal | undefined,
		onUpdate: ((result: ToolResult<Details>) => void) | undefined,
		context: ToolContext,
	): Promise<ToolResult<Details>>;
}

export type ToolExposure = "direct" | "deferred" | "hidden";

export type ToolSource =
	| { type: "builtin" }
	| { type: "extension"; path: string }
	| { type: "sdk" }
	| { type: "mcp"; server: string; exposure: ToolExposure };

export interface ToolInfo extends ToolDeclaration {
	label: string;
	source: ToolSource;
	exposure: ToolExposure;
}

type ToolArguments = Record<string, unknown>;

export interface ToolCallEvent {
	type: "tool_call";
	toolName: string;
	toolCallId: string;
	input: ToolArguments;
}

export interface ToolResultEvent extends ToolResult {
	type: "tool_result";
	toolName: string;
	toolCallId: string;
	input: ToolArguments;
	isError: boolean;
}

type HookEvents = { tool_call: ToolCallEvent; tool_result: ToolResultEvent };
type HookResults = { tool_call: { block: true; reason?: string }; tool_result: Partial<ToolResult> };
export type ToolHookName = keyof HookEvents;
export type ToolHook<Name extends ToolHookName> = (
	event: HookEvents[Name],
	context: ToolContext,
) => HookResults[Name] | void | Promise<HookResults[Name] | void>;

interface RegisteredTool {
	info: ToolInfo;
	prompt: string[];
	executionMode: "parallel" | "sequential";
	prepare: (input: ToolArguments) => ToolArguments;
	validate: (input: ToolArguments) => void;
	execute: (id: string, input: ToolArguments, signal: AbortSignal, onUpdate?: (result: ToolResult) => void) => Promise<ToolResult>;
}

export interface ToolSnapshot {
	declarations: readonly ToolDeclaration[];
	prompt: readonly string[];
	executionMode: "parallel" | "sequential";
	execute: (call: ToolCall, signal: AbortSignal, onUpdate?: (result: ToolResult) => void) => Promise<ToolResult>;
}

export class ToolRegistry {
	private readonly tools = new Map<string, RegisteredTool>();
	private readonly active = new Set<string>();
	private readonly hooks: { [Name in ToolHookName]: ToolHook<Name>[] } = { tool_call: [], tool_result: [] };
	private readonly context: ToolContext;

	constructor(cwd = process.cwd()) {
		this.context = Object.freeze({ cwd });
	}

	register<Schema extends TSchema, Details>(
		tool: ToolDefinition<Schema, Details>,
		source: ToolSource = { type: "builtin" },
	): void {
		const { name } = tool;
		if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
			throw new Error("工具名必须为 1 到 64 个英文字母、数字、下划线或连字符。");
		}
		if (name === TOOL_SEARCH_NAME && source.type !== "builtin") throw new Error("保留工具名 " + name);
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters) || typeof tool.execute !== "function") {
			throw new Error(`工具 ${name} 必须提供参数 schema 和 execute 函数。`);
		}
		const previous = this.tools.get(name)?.info.source;
		if (previous) {
			// Pi keeps the first extension's definition, and SDK definitions take precedence.
			if (previous.type === "extension" && source.type === "extension" && previous.path !== source.path) return;
			if (previous.type === "sdk" && source.type === "extension") return;
			const replacesBuiltin = previous.type === "builtin" && (source.type === "extension" || source.type === "sdk");
			const updatesExtension = previous.type === "extension" && (source.type === "extension" || source.type === "sdk");
			if (!replacesBuiltin && !updatesExtension) throw new Error("工具名重复 " + name);
		}
		const registered = this.bind(tool, source);
		this.tools.set(name, registered);
		if (!previous && registered.info.exposure === "direct" && tool.defaultActive !== false) this.active.add(name);
		if (registered.info.exposure === "deferred" && !this.tools.has(TOOL_SEARCH_NAME)) {
			this.register(createToolSearch([]));
		}
	}

	private bind<Schema extends TSchema, Details>(tool: ToolDefinition<Schema, Details>, source: ToolSource): RegisteredTool {
		const { name, label, description, prepareArguments, execute } = tool;
		const parameters = structuredClone(tool.parameters);
		return {
			info: { name, label, description, parameters, source, exposure: source.type === "mcp" ? source.exposure : "direct" },
			executionMode: tool.executionMode ?? "parallel",
			prompt: [
				...(tool.promptSnippet ? [`- ${name}: ${tool.promptSnippet}`] : []),
				...(tool.promptGuidelines ?? []),
			],
			prepare: prepareArguments ? (input) => prepareArguments.call(tool, input) as ToolArguments : (input) => input,
			validate: (input) => {
				if (!Check(parameters, input)) {
					const detail = Errors(parameters, input).map(({ instancePath, message }) => instancePath + " " + message).join("; ");
					throw new Error("工具参数无效 " + detail.trim());
				}
			},
			execute: (id, input, signal, onUpdate) => execute.call(tool, id, input as Static<Schema>, signal, onUpdate, this.context),
		};
	}

	on<Name extends ToolHookName>(type: Name, handler: ToolHook<Name>): void {
		this.hooks[type].push(handler);
	}

	getAllTools(): ToolInfo[] {
		return [...this.tools.values()].map(({ info }) => structuredClone(info));
	}

	getActiveTools(): string[] {
		return [...this.active];
	}

	setActiveTools(names: readonly string[]): void {
		for (const name of names) {
			const tool = this.tools.get(name);
			if (!tool) throw new Error("当前未注册工具 " + name);
			if (tool.info.exposure === "hidden") throw new Error("工具已隐藏 " + name);
		}
		this.active.clear();
		for (const name of names) this.active.add(name);
	}

	declarations(): readonly ToolDeclaration[] {
		return this.snapshot().declarations;
	}

	execute(call: ToolCall, signal: AbortSignal, onUpdate?: (result: ToolResult) => void): Promise<ToolResult> {
		return this.snapshot().execute(call, signal, onUpdate);
	}

	snapshot(loaded: ReadonlySet<string> = new Set()): ToolSnapshot {
		const searchEnabled = this.active.has(TOOL_SEARCH_NAME);
		const tools = new Map<string, RegisteredTool>();
		const candidates: ToolInfo[] = [];
		for (const [name, tool] of this.tools) {
			const deferred = tool.info.exposure === "deferred";
			if (this.active.has(name) || (searchEnabled && deferred && loaded.has(name))) {
				tools.set(name, tool);
			} else if (searchEnabled && deferred) {
				candidates.push(tool.info);
			}
		}
		if (searchEnabled) tools.set(TOOL_SEARCH_NAME, this.bind(createToolSearch(candidates), { type: "builtin" }));
		const before = [...this.hooks.tool_call];
		const after = [...this.hooks.tool_result];
		return {
			declarations: [...tools.values()].map(({ info: { name, description, parameters } }) => ({
				name, description, parameters: structuredClone(parameters),
			})),
			prompt: [...tools.values()].flatMap((tool) => tool.prompt),
			executionMode: [...tools.values()].some((tool) => tool.executionMode === "sequential") ? "sequential" : "parallel",
			execute: async (call, signal, onUpdate) => {
				signal.throwIfAborted();
				if (call.argumentError) throw new Error(call.argumentError);
				const tool = tools.get(call.name);
				if (!tool) throw new Error("该请求未注册工具 " + call.name);
				const identity = { toolName: call.name, toolCallId: call.id };
				let input = tool.prepare(structuredClone(call.arguments));
				tool.validate(input);
				let result: ToolResult | undefined;
				if (before.length) {
					const event: ToolCallEvent = { type: "tool_call", ...identity, input };
					for (const handler of before) {
						signal.throwIfAborted();
						const outcome = await handler(event, this.context);
						if (outcome?.block) {
							result = { content: [{ type: "text", text: outcome.reason ?? "工具调用已被扩展拦截。" }], isError: true };
							break;
						}
					}
					input = event.input;
					if (!result) tool.validate(input);
				}
				signal.throwIfAborted();
				if (!result) {
					let running = true;
					const publish = onUpdate && ((update: ToolResult) => {
						if (running && !signal.aborted) onUpdate(update);
					});
					try {
						result = await tool.execute(call.id, input, signal, publish);
					} catch (error) {
						if (signal.aborted || !after.length) throw error;
						result = { content: [{ type: "text", text: errorMessage(error) }], isError: true };
					} finally {
						running = false;
					}
				}
				for (const handler of after) {
					signal.throwIfAborted();
					const event: ToolResultEvent = { ...result, type: "tool_result", ...identity, input, isError: result.isError === true };
					const patch = await handler(event, this.context);
					if (patch) {
						// Match Pi when a hook replaces content without supplying matching structured content.
						result = { ...result, ...patch };
						if (patch.content !== undefined && patch.structuredContent === undefined) delete result.structuredContent;
					}
				}
				return result;
			},
		};
	}
}
