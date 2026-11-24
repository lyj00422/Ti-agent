import type { Static, TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import type { ImageContent, TextContent, ToolCall, ToolDeclaration } from "../agent/messages.ts";

export interface ToolResult<Details = unknown> {
	content: Array<TextContent | ImageContent>;
	details?: Details;
	structuredContent?: unknown;
	isError?: boolean;
}

export interface ToolDefinition<Schema extends TSchema, Details = unknown> {
	name: string;
	label: string;
	description: string;
	parameters: Schema;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
	outputSchema?: TSchema;
	constrainedSampling?: { type: "json_schema"; strict: "prefer" };
	prepareArguments?: (args: unknown) => Static<Schema>;
	execute(
		id: string,
		args: Static<Schema>,
		signal?: AbortSignal,
		onUpdate?: (result: ToolResult<Details>) => void,
	): Promise<ToolResult<Details>>;
}

export class ToolRegistry {
	private readonly tools = new Map<string, {
		declaration: ToolDeclaration;
		guidelines: readonly string[];
		execute: (call: ToolCall, signal: AbortSignal) => Promise<ToolResult>;
	}>();

	register<Schema extends TSchema, Details>(tool: ToolDefinition<Schema, Details>): void {
		if (this.tools.has(tool.name)) throw new Error("工具名重复 " + tool.name);
		const { name, description, parameters } = tool;
		this.tools.set(name, {
			declaration: { name, description, parameters },
			guidelines: tool.promptGuidelines ?? [],
			execute: async (call, signal) => {
				const args = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
				if (!Check(parameters, args)) {
					const detail = Errors(parameters, args).map(({ instancePath, message }) => instancePath + " " + message).join("; ");
					throw new Error("工具参数无效 " + detail.trim());
				}
				return tool.execute(call.id, args, signal);
			},
		});
	}

	declarations(): ToolDeclaration[] {
		return [...this.tools.values()].map((tool) => tool.declaration);
	}

	guidelines(): string[] {
		return [...this.tools.values()].flatMap((tool) => tool.guidelines);
	}

	async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
		signal.throwIfAborted();
		if (call.argumentError) throw new Error(call.argumentError);
		const tool = this.tools.get(call.name);
		if (!tool) throw new Error("当前未注册工具 " + call.name);
		return tool.execute(call, signal);
	}
}
