import { messageText } from "./agent.ts";
import type { ModelMessage } from "./agent.ts";
import type { Session } from "./sessions.ts";

export function buildContext(session: Session): ModelMessage[] {
	const checkpoint = session.compactions.at(-1);
	const start = checkpoint ? session.history.findIndex((message) => message.id === checkpoint.firstKeptEntryId) : 0;
	const messages: ModelMessage[] = session.history.slice(start).filter((message) =>
		message.content.some((block) => block.text) &&
		(message.role === "user" || (message.stopReason !== "error" && message.stopReason !== "aborted")),
	);
	if (checkpoint) messages.unshift(summaryMessage(checkpoint.summary));
	return messages;
}

export function estimateTokens(messages: readonly ModelMessage[]): number {
	// UTF-8 length gives CJK text more weight than ASCII when no tokenizer is available.
	return messages.reduce((total, message) => total + 4 + Math.ceil(Buffer.byteLength(messageText(message)) / 3.5), 0);
}

export function estimateContext(session: Session, messages: readonly ModelMessage[]): number {
	const firstCurrentIndex = session.compactions.at(-1)?.historyLength ?? 0;
	for (let index = session.history.length - 1; index >= firstCurrentIndex; index--) {
		const message = session.history[index];
		if (message.role !== "assistant" || !message.usage || message.usage.input + message.usage.output <= 0) continue;
		const contextIndex = messages.indexOf(message);
		if (contextIndex >= 0) {
			return message.usage.input + message.usage.output + estimateTokens(messages.slice(contextIndex + 1));
		}
	}
	return estimateTokens(messages);
}

export function summaryMessage(summary: string): ModelMessage {
	return { role: "user", content: [{ type: "text", text: "Earlier conversation summary (context only):\n" + summary }] };
}
