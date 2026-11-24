import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, messageText, toolCalls } from "../agent/messages.ts";
import type { AssistantMessage, ChatError, ModelMessage, StreamReply, ToolCall, Usage } from "../agent/messages.ts";

export const MODEL_ID = "deepseek-flash";
export const CONTEXT_WINDOW = 1_000_000;

function readKey(directory: string): string | undefined {
	const path = join(directory, "auth.json");
	let file: string;
	try {
		file = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const credential = JSON.parse(file.replace(/^\uFEFF/, ""))?.deepseek;
	return credential?.type === "api_key" && typeof credential.key === "string" ? credential.key.trim() : undefined;
}

export function getKey(home: string, legacyHome?: string): string {
	const key = process.env.DEEPSEEK_API_KEY?.trim() || readKey(home);
	if (key) return key;

	const legacyKey = legacyHome ? readKey(legacyHome) : undefined;
	if (legacyKey && !legacyKey.startsWith("!") && !legacyKey.includes("$")) return legacyKey;
	throw new Error("请用 /login 保存 DeepSeek API Key，或设置 DEEPSEEK_API_KEY。");
}

export function saveKey(home: string, value: string): void {
	const key = value.trim();
	if (!key || /\s/.test(key)) throw new Error("请输入有效的 DeepSeek API Key。");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const temporary = join(home, `auth-${randomUUID()}.tmp`);
	writeFileSync(temporary, JSON.stringify({ deepseek: { type: "api_key", key } }) + "\n", { mode: 0o600, flag: "wx" });
	try {
		renameSync(temporary, join(home, "auth.json"));
	} finally {
		rmSync(temporary, { force: true });
	}
}

interface ToolCallDelta {
	index: number;
	id?: string;
	function?: { name?: string; arguments?: string };
}

interface CompletionChunk {
	choices?: Array<{ delta?: { content?: string | null; tool_calls?: ToolCallDelta[] }; finish_reason?: string | null }>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
	error?: { message?: string; code?: string; type?: string };
}

export async function streamReply(
	context: readonly ModelMessage[],
	getKey: () => string,
	{ signal, maxOutputTokens, tools, onEvent }: Parameters<StreamReply>[1],
): Promise<AssistantMessage> {
	const timestamp = Date.now();
	let reply = "";
	let stopReason: "stop" | "length" | "toolUse" = "stop";
	let usage: Usage | undefined;
	const pendingCalls = new Map<number, { id: string; name: string; arguments: string }>();
	const finish = (reason: AssistantMessage["stopReason"], error?: ChatError, calls: ToolCall[] = []): AssistantMessage => ({
		role: "assistant",
		content: reply ? [{ type: "text", text: reply }, ...calls] : calls,
		timestamp,
		stopReason: reason,
		usage,
		error,
		errorMessage: error?.message,
	});
	let key: string;
	try {
		key = getKey();
	} catch (error) {
		return finish("error", { kind: "auth", message: errorMessage(error) });
	}
	const messages = encodeMessages(context);

	try {
		const response = await fetch("https://api.deepseek.com/chat/completions", {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "text/event-stream" },
			body: JSON.stringify({
				model: MODEL_ID, messages, stream: true, stream_options: { include_usage: true },
				thinking: { type: "disabled" }, max_tokens: maxOutputTokens,
				tools: tools?.length ? tools.map((tool) => ({ type: "function", function: tool })) : undefined,
			}),
			signal,
		});
		if (!response.ok) {
			const body = (await response.text()).trim();
			const error = body.startsWith("{") ? parseErrorBody(body) : undefined;
			return finish("error", classifyError(error, `DeepSeek HTTP ${response.status}`, response.status));
		}
		if (!response.body) return finish("error", { kind: "protocol", message: "DeepSeek 返回了空响应。" });

		let pending = "";
		let data: string[] = [];
		for await (const text of response.body.pipeThrough(new TextDecoderStream())) {
			pending += text;
			const lines = pending.split(/\r?\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) {
				if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
				if (line || data.length === 0) continue;

				const payload = data.join("\n");
				data = [];
				if (payload === "[DONE]") {
					if (signal.aborted) return finish("aborted");
					if (stopReason === "toolUse") {
						const calls = [...pendingCalls].sort(([a], [b]) => a - b).map(([, call]) => parseToolCall(call));
						if (!calls.length || calls.some((call) => !call.id || !call.name) || new Set(calls.map((call) => call.id)).size !== calls.length) {
							return finish("error", { kind: "protocol", message: "DeepSeek 返回了不完整或重复的工具调用标识。" });
						}
						return finish("toolUse", undefined, calls);
					}
					if (pendingCalls.size && stopReason !== "length") {
						return finish("error", { kind: "protocol", message: "DeepSeek 未完整结束工具调用。" });
					}
					if (!reply && stopReason === "stop") return finish("error", { kind: "protocol", message: "DeepSeek 未返回文本。" });
					return finish(stopReason);
				}

				const chunk: CompletionChunk = JSON.parse(payload);
				if (chunk.error) return finish("error", classifyError(chunk.error, "DeepSeek 返回了流式错误。"));
				const raw = chunk.usage;
				if (typeof raw?.prompt_tokens === "number" && typeof raw.completion_tokens === "number") {
					usage = {
						input: raw.prompt_tokens,
						output: raw.completion_tokens,
						cacheRead: raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens,
					};
					onEvent({ type: "usage", usage });
				}
				const choice = chunk.choices?.[0];
				for (const update of choice?.delta?.tool_calls ?? []) {
					if (!Number.isSafeInteger(update.index) || update.index < 0) {
						return finish("error", { kind: "protocol", message: "DeepSeek 返回了无效的工具调用索引。" });
					}
					const call = pendingCalls.get(update.index) ?? { id: "", name: "", arguments: "" };
					if (!call.id && typeof update.id === "string") call.id = update.id;
					if (!call.name && typeof update.function?.name === "string") call.name = update.function.name;
					if (typeof update.function?.arguments === "string") call.arguments += update.function.arguments;
					pendingCalls.set(update.index, call);
				}
				const delta = choice?.delta?.content;
				if (typeof delta === "string" && delta) {
					reply += delta;
					onEvent({ type: "text_delta", text: delta });
				}
				switch (choice?.finish_reason) {
					case "tool_calls": stopReason = "toolUse"; break;
					case "length": stopReason = "length"; break;
					case "content_filter": return finish("error", { kind: "provider", message: "DeepSeek 已过滤此回复。" });
				}
			}
		}
		return signal.aborted ? finish("aborted") : finish("error", { kind: "network", message: "DeepSeek 响应提前结束。" });
	} catch (error) {
		if (signal.aborted) return finish("aborted");
		return finish("error", { kind: error instanceof SyntaxError ? "protocol" : "network", message: errorMessage(error) });
	}
}

function parseToolCall(call: { id: string; name: string; arguments: string }): ToolCall {
	const base = { type: "toolCall" as const, id: call.id, name: call.name };
	try {
		const args: unknown = JSON.parse(call.arguments);
		if (args && typeof args === "object" && !Array.isArray(args)) {
			return { ...base, arguments: args as Record<string, unknown> };
		}
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
	}
	return { ...base, arguments: {}, argumentError: "工具参数必须是完整的 JSON 对象。" };
}

function encodeMessages(context: readonly ModelMessage[]): object[] {
	const messages: object[] = [];
	for (let index = 0; index < context.length; index++) {
		const message = context[index];
		const content = messageText(message);
		if (message.role === "assistant") {
			const calls = toolCalls(message);
			messages.push({
				role: "assistant", content: content || (calls.length ? null : ""), reasoning_content: "",
				tool_calls: calls.length ? calls.map((call) => ({
					id: call.id, type: "function",
					function: { name: call.name, arguments: JSON.stringify(call.arguments) },
				})) : undefined,
			});
		} else if (message.role === "toolResult") {
			const images: object[] = [];
			let result = message;
			while (true) {
				const attachments = result.content.filter((block) => block.type === "image");
				messages.push({ role: "tool", tool_call_id: result.toolCallId,
					content: messageText(result) || (attachments.length ? "(see attached image)" : "(no tool output)") });
				for (const image of attachments) {
					images.push({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } });
				}
				const next = context[index + 1];
				if (next?.role !== "toolResult") break;
				index++;
				result = next;
			}
			if (images.length) messages.push({ role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...images] });
		} else {
			messages.push({ role: message.role, content });
		}
	}
	return messages;
}

function parseErrorBody(body: string): CompletionChunk["error"] {
	try {
		return (JSON.parse(body) as CompletionChunk).error;
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		return undefined;
	}
}

function classifyError(error: CompletionChunk["error"], fallback: string, status?: number): ChatError {
	const code = error?.code ?? error?.type;
	const detail = error?.message;
	const message = detail && status !== undefined ? `${fallback}  ${detail}` : detail || fallback;
	if (status === 401 || status === 403 || code === "authentication_error") {
		return { kind: "auth", status, code, message: message + "。请检查 API Key 或使用 /login。" };
	}
	if (status === 429 || code === "rate_limit_error" || code === "rate_limit_exceeded") {
		return { kind: "rateLimit", status, code, message };
	}
	if (code === "context_length_exceeded" || /maximum context length|exceeds? (?:the )?(?:model's )?(?:maximum )?context (?:length|window)|prompt (?:is )?too long/i.test(detail ?? "")) {
		return { kind: "contextOverflow", status, code, message };
	}
	return { kind: "provider", status, code, message };
}
