import type { ToolCall } from "./messages.ts";
import type { ImageContent, TextContent, ToolDeclaration } from "./messages.ts";

export interface ToolExecutionResult {
	content: Array<TextContent | ImageContent>;
	details?: unknown;
	structuredContent?: unknown;
	isError?: boolean;
	terminate?: boolean;
}

export interface ToolExecutorSnapshot {
	declarations: readonly ToolDeclaration[];
	prompt: readonly string[];
	executionMode: "parallel" | "sequential";
	execute: (
		call: ToolCall,
		signal: AbortSignal,
		onUpdate?: (result: ToolExecutionResult) => void,
		parentToolCallId?: string,
	) => Promise<ToolExecutionResult>;
}
