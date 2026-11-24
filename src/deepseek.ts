import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, messageText } from "./agent.ts";
import type { AssistantMessage, ChatError, ModelMessage, StreamReply, Usage } from "./agent.ts";

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

export function getKey(home: string, legacyHome: string): string {
	const key = process.env.DEEPSEEK_API_KEY?.trim() || readKey(home);
	if (key) return key;

	const legacyKey = readKey(legacyHome);
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

interface CompletionChunk {
	choices?: Array<{ delta?: { content?: string | null; tool_calls?: unknown[] }; finish_reason?: string | null }>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
	error?: { message?: string; code?: string; type?: string };
}

export async function streamReply(
	context: readonly ModelMessage[],
	getKey: () => string,
	{ signal, maxOutputTokens, onEvent }: Parameters<StreamReply>[1],
): Promise<AssistantMessage> {
	const timestamp = Date.now();
	let reply = "";
	let stopReason: "stop" | "length" = "stop";
	let usage: Usage | undefined;
	const finish = (reason: AssistantMessage["stopReason"], error?: ChatError): AssistantMessage => ({
		role: "assistant",
		content: reply ? [{ type: "text", text: reply }] : [],
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
	const messages = context.map((message) => {
		const content = messageText(message);
		return message.role === "assistant"
			? { role: message.role, content, reasoning_content: "" }
			: { role: message.role, content };
	});

	try {
		const response = await fetch("https://api.deepseek.com/chat/completions", {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "text/event-stream" },
			body: JSON.stringify({
				model: MODEL_ID, messages, stream: true, stream_options: { include_usage: true },
				thinking: { type: "disabled" }, max_tokens: maxOutputTokens,
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
				if (choice?.delta?.tool_calls?.length || choice?.finish_reason === "tool_calls") {
					return finish("error", { kind: "protocol", message: "Ti 当前仅支持文本回复。" });
				}
				const delta = choice?.delta?.content;
				if (typeof delta === "string" && delta) {
					reply += delta;
					onEvent({ type: "text_delta", text: delta });
				}
				switch (choice?.finish_reason) {
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
