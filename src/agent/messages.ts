export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	mimeType: string;
	data: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	argumentError?: string;
}

export interface ToolDeclaration {
	name: string;
	description: string;
	parameters: object;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead?: number;
}

export type ErrorKind = "auth" | "rateLimit" | "contextOverflow" | "network" | "provider" | "protocol";

export interface ChatError {
	kind: ErrorKind;
	message: string;
	code?: string;
	status?: number;
}

export interface UserMessage {
	role: "user";
	content: TextContent[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: Array<TextContent | ToolCall>;
	timestamp: number;
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
	usage?: Usage;
	requestOverhead?: number;
	error?: ChatError;
	errorMessage?: string;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<TextContent | ImageContent>;
	details?: unknown;
	structuredContent?: unknown;
	isError: boolean;
	timestamp: number;
}

export type ChatMessage = UserMessage | AssistantMessage | ToolResultMessage;
export type ModelMessage = Pick<UserMessage, "role" | "content">
	| Pick<AssistantMessage, "role" | "content">
	| Pick<ToolResultMessage, "role" | "content" | "toolCallId" | "toolName" | "isError">
	| { role: "system"; content: TextContent[] };
export type GenerationEvent = { type: "text_delta"; text: string } | { type: "usage"; usage: Usage };

export type StreamReply = (
	messages: readonly ModelMessage[],
	options: { signal: AbortSignal; maxOutputTokens?: number; tools?: readonly ToolDeclaration[]; onEvent: (event: GenerationEvent) => void },
) => Promise<AssistantMessage>;

export function messageText(message: ModelMessage): string {
	return message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
}

export function toolCalls(message: AssistantMessage | Pick<AssistantMessage, "content">): ToolCall[] {
	return message.content.filter((block) => block.type === "toolCall");
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
