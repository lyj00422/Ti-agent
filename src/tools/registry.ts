import type { Static, TSchema } from "typebox";
import { randomUUID } from "node:crypto";
import { Check, Errors } from "typebox/value";
import { errorMessage } from "../agent/messages.ts";
import type { ImageContent, TextContent, ToolCall, ToolDeclaration } from "../agent/messages.ts";
import type { ToolExecutorSnapshot, ToolExecutionResult } from "../agent/contracts.ts";
import type { ToolApprovalHandler } from "./permissions.ts";
import { createToolSearch, TOOL_SEARCH_NAME } from "./tool-search.ts";

export interface ToolResult<Details = unknown> extends ToolExecutionResult {
	details?: Details;
}

export interface ToolContext {
	readonly cwd: string;
	getCodemodeTools: () => ToolInfo[];
	executeTool: (
		name: string,
		input: Record<string, unknown>,
		signal: AbortSignal,
		parentToolCallId?: string,
	) => Promise<ToolResult>;
}

export interface ToolDefinition<Schema extends TSchema = TSchema, Details = unknown> {
	name: string;
	label: string;
	description: string;
	access?: "read" | "write" | "execute";
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

export type ToolExposure = "direct" | "deferred" | "codemode" | "hidden";

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
	parentToolCallId?: string;
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
	access: "read" | "write" | "execute";
	prompt: string[];
	executionMode: "parallel" | "sequential";
	prepare: (input: ToolArguments) => ToolArguments;
	validate: (input: ToolArguments) => void;
	execute: (id: string, input: ToolArguments, signal: AbortSignal, onUpdate?: (result: ToolResult) => void) => Promise<ToolResult>;
}

export type ToolSnapshot = ToolExecutorSnapshot;

export interface ToolRegistryOptions {
	permissionMode?: "ask" | "default" | "yolo" | "allow";
	requestApproval?: ToolApprovalHandler;
}

export class ToolRegistry {
	private readonly tools = new Map<string, RegisteredTool>();
	private readonly active = new Set<string>();
	private readonly hooks: { [Name in ToolHookName]: ToolHook<Name>[] } = { tool_call: [], tool_result: [] };
	private readonly context: ToolContext;
	private permissionMode: "ask" | "default" | "yolo";
	private readonly requestApproval?: ToolApprovalHandler;

	constructor(cwd = process.cwd(), options: ToolRegistryOptions = {}) {
		this.permissionMode = options.permissionMode === "allow" ? "yolo" : options.permissionMode ?? "default";
		this.requestApproval = options.requestApproval;
		this.context = Object.freeze({
			cwd,
			getCodemodeTools: this.getCodemodeTools.bind(this),
			executeTool: this.executeNested.bind(this),
		});
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
			access: tool.access ?? "execute",
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

	private async executeNested(name: string, input: ToolArguments, signal: AbortSignal, parentToolCallId?: string): Promise<ToolResult> {
		const tool = this.tools.get(name);
		if (!tool || !this.isCodemodeCallable(tool)) {
			throw new Error("工具不可由 Codemode 调用 " + name);
		}
		const call: ToolCall = {
			type: "toolCall",
			id: `${parentToolCallId ?? "codemode"}/${randomUUID()}`,
			name,
			arguments: input,
		};
		return this.executeRegistered(tool, call, signal, undefined, parentToolCallId);
	}

	private async executeRegistered(
		tool: RegisteredTool,
		call: ToolCall,
		signal: AbortSignal,
		onUpdate?: (result: ToolResult) => void,
		parentToolCallId?: string,
	): Promise<ToolResult> {
		signal.throwIfAborted();
		if (call.argumentError) throw new Error(call.argumentError);
		const identity = { toolName: call.name, toolCallId: call.id, parentToolCallId };
		let input = tool.prepare(structuredClone(call.arguments));
		tool.validate(input);
		let result: ToolResult | undefined;
		if (this.hooks.tool_call.length) {
			const event: ToolCallEvent = { type: "tool_call", ...identity, input };
			for (const handler of this.hooks.tool_call) {
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
		const requiresApproval = this.permissionMode === "ask"
			|| (this.permissionMode === "default" && tool.access !== "read");
		if (!result && requiresApproval) {
			const approved = this.requestApproval
				? await this.requestApproval({ id: call.id, toolName: call.name, input, parentToolCallId }, signal)
				: false;
			if (!approved) result = { content: [{ type: "text", text: "用户拒绝了工具调用。" }], isError: true, terminate: true };
		}
		signal.throwIfAborted();
		if (!result) {
			let running = true;
			const publish = onUpdate && ((update: ToolResult) => {
				if (running && !signal.aborted) onUpdate(update);
			});
			try {
				result = await tool.execute(call.id, input, signal, publish, this.context);
			} catch (error) {
				if (signal.aborted || !this.hooks.tool_result.length) throw error;
				result = { content: [{ type: "text", text: errorMessage(error) }], isError: true };
			} finally {
				running = false;
			}
		}
		for (const handler of this.hooks.tool_result) {
			signal.throwIfAborted();
			const event: ToolResultEvent = { ...result, type: "tool_result", ...identity, input, isError: result.isError === true };
			const patch = await handler(event, this.context);
			if (patch) {
				result = { ...result, ...patch };
				if (patch.content !== undefined && patch.structuredContent === undefined) delete result.structuredContent;
			}
		}
		return result;
	}

	on<Name extends ToolHookName>(type: Name, handler: ToolHook<Name>): void {
		this.hooks[type].push(handler);
	}

	getAllTools(): ToolInfo[] {
		return [...this.tools.values()].map(({ info }) => structuredClone(info));
	}

	getPermissionMode(): "ask" | "default" | "yolo" {
		return this.permissionMode;
	}

	setPermissionMode(mode: "ask" | "default" | "yolo"): void {
		this.permissionMode = mode;
	}

	getCodemodeTools(): ToolInfo[] {
		return [...this.tools.values()]
			.filter((tool) => this.isCodemodeCallable(tool))
			.map(({ info }) => structuredClone(info));
	}

	private isCodemodeCallable(tool: RegisteredTool): boolean {
		const { info } = tool;
		if (info.name === "codemode" || info.exposure === "hidden") return false;
		if (info.source.type === "mcp") return info.exposure === "codemode" || info.exposure === "deferred" || this.active.has(info.name);
		return this.active.has(info.name);
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

	activate(name: string): void {
		const tool = this.tools.get(name);
		if (!tool) throw new Error("当前未注册工具 " + name);
		if (tool.info.exposure === "hidden") throw new Error("工具已隐藏 " + name);
		this.active.add(name);
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
		return {
			declarations: [...tools.values()].map(({ info: { name, description, parameters } }) => ({
				name, description, parameters: structuredClone(parameters),
			})),
			prompt: [...tools.values()].flatMap((tool) => tool.prompt),
			executionMode: [...tools.values()].some((tool) => tool.executionMode === "sequential") ? "sequential" : "parallel",
			execute: async (call, signal, onUpdate, parentToolCallId) => {
				const tool = tools.get(call.name);
				if (!tool) throw new Error("该请求未注册工具 " + call.name);
				return this.executeRegistered(tool, call, signal, onUpdate, parentToolCallId);
			},
		};
	}
}
