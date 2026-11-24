import { streamReply } from "./deepseek.ts";

export interface ChatMessage {
	role: "user" | "assistant";
	text: string;
	timestamp: number;
	stopReason?: "stop" | "length" | "error" | "aborted";
	errorMessage?: string;
}

export async function runAgentTurn(
	text: string,
	history: readonly ChatMessage[],
	append: (message: ChatMessage) => void,
	getKey: () => string,
	onDelta: (text: string) => void,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	const user: ChatMessage = { role: "user", text, timestamp: Date.now() };
	const context = [...history, user];
	append(user);

	let reply = "";
	let stopReason: ChatMessage["stopReason"] = "stop";
	let failure: { message: string; cause: unknown } | undefined;
	try {
		stopReason = await streamReply(context, getKey(), (delta) => {
			reply += delta;
			onDelta(delta);
		}, signal);
	} catch (cause) {
		stopReason = signal.aborted ? "aborted" : "error";
		failure = { message: cause instanceof Error ? cause.message : String(cause), cause };
	}

	append({
		role: "assistant",
		text: reply,
		timestamp: Date.now(),
		stopReason,
		errorMessage: failure?.message,
	});
	if (failure) throw failure.cause;
}
