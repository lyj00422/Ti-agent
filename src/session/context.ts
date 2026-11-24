import { toolCalls } from "../agent/messages.ts";
import type { ModelMessage, ToolCall, ToolResultMessage } from "../agent/messages.ts";
import type { Session } from "./store.ts";

export function buildContext(session: Session): ModelMessage[] {
	const checkpoint = session.compactions.at(-1);
	const start = checkpoint ? session.history.findIndex((message) => message.id === checkpoint.firstKeptEntryId) : 0;
	const messages: ModelMessage[] = [];
	if (checkpoint) messages.unshift(summaryMessage(checkpoint.summary));
	for (let index = start; index < session.history.length; index++) {
		const message = session.history[index];
		if (message.role === "user") {
			messages.push(message);
			continue;
		}
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
		if (!message.content.length) continue;
		messages.push(message);
		const calls = toolCalls(message);
		if (!calls.length) continue;
		const results = new Map<string, ToolResultMessage>();
		let next = session.history[index + 1];
		while (next?.role === "toolResult") {
			results.set(next.toolCallId, next);
			index++;
			next = session.history[index + 1];
		}
		for (const call of calls) messages.push(results.get(call.id) ?? unknownToolResult(call, message.timestamp));
	}
	return messages;
}

export function estimateTokens(messages: readonly ModelMessage[]): number {
	// UTF-8 length gives CJK text more weight than ASCII when no tokenizer is available.
	return messages.reduce((total, message) => total + 4 + Math.ceil(Buffer.byteLength(messageForSummary(message)) / 3.5)
		+ 1024 * message.content.filter((block) => block.type === "image").length, 0);
}

export function estimateContext(session: Session, messages: readonly ModelMessage[], requestOverhead = 0): number {
	const firstCurrentIndex = session.compactions.at(-1)?.historyLength ?? 0;
	for (let index = session.history.length - 1; index >= firstCurrentIndex; index--) {
		const message = session.history[index];
		if (message.role !== "assistant" || !message.usage || message.usage.input + message.usage.output <= 0) continue;
		const contextIndex = messages.indexOf(message);
		if (contextIndex >= 0) {
			return message.usage.input + message.usage.output + estimateTokens(messages.slice(contextIndex + 1))
				+ requestOverhead - (message.requestOverhead ?? 0);
		}
	}
	return estimateTokens(messages) + requestOverhead;
}

export function messageForSummary(message: ModelMessage): string {
	return message.content.map((block) => {
		if (block.type === "text") return block.text;
		if (block.type === "image") return "[Tool image: " + block.mimeType + "]";
		return "\n" + block.name + "(" + JSON.stringify(block.arguments) + ")";
	}).join("");
}

export function unknownToolResult(call: ToolCall, timestamp = Date.now()): ToolResultMessage {
	return {
		role: "toolResult", toolCallId: call.id, toolName: call.name, isError: true, timestamp,
		content: [{ type: "text", text: "上次工具调用结果未知。请先核查现场，再决定下一步。" }],
	};
}

export function summaryMessage(summary: string): ModelMessage {
	return { role: "user", content: [{ type: "text", text: "Earlier conversation summary (context only):\n" + summary }] };
}
