export interface TextContent {
	type: "text";
	text: string;
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
	content: TextContent[];
	timestamp: number;
	stopReason: "stop" | "length" | "error" | "aborted";
	usage?: Usage;
	error?: ChatError;
	errorMessage?: string;
}

export type ChatMessage = UserMessage | AssistantMessage;
export type ModelMessage = Pick<ChatMessage, "role" | "content">;
export type GenerationEvent = { type: "text_delta"; text: string } | { type: "usage"; usage: Usage };

export type StreamReply = (
	messages: readonly ModelMessage[],
	options: { signal: AbortSignal; maxOutputTokens?: number; onEvent: (event: GenerationEvent) => void },
) => Promise<AssistantMessage>;

export function messageText(message: ModelMessage): string {
	return message.content.map((block) => block.text).join("");
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
