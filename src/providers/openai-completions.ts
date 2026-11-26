import { errorMessage, messageText, toolCalls } from "../agent/messages.ts";
import type { AssistantMessage, ChatError, ModelMessage, ToolCall, Usage } from "../agent/messages.ts";
import type { ProviderStream } from "./types.ts";

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

export const streamOpenAiCompletions: ProviderStream = async (model, context, options) => {
	const { signal, maxOutputTokens, tools, onEvent } = options;
	const provider = model.provider === "deepseek" ? "DeepSeek" : model.provider;
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
		key = options.resolveApiKey();
	} catch (error) {
		return finish("error", { kind: "auth", message: errorMessage(error) });
	}
	const messages = encodeMessages(context, model.provider === "deepseek");

	try {
		const baseUrl = model.baseUrl!;
		const maxTokensField = model.compat?.maxTokensField
			?? (new URL(baseUrl).hostname === "api.openai.com" ? "max_completion_tokens" : "max_tokens");
		const endpoint = /\/chat\/completions\/?$/i.test(baseUrl)
			? baseUrl
			: baseUrl.replace(/\/+$/, "") + "/chat/completions";
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { ...model.headers, authorization: `Bearer ${key}`, "content-type": "application/json", accept: "text/event-stream" },
			body: JSON.stringify({
				model: model.id, messages, stream: true,
				...(model.compat?.supportsUsageInStreaming === false ? {} : { stream_options: { include_usage: true } }),
				...(model.provider === "deepseek" ? {
					thinking: options.thinkingLevel && options.thinkingLevel !== "off" ? { type: "enabled" } : { type: "disabled" },
					...(options.thinkingLevel && options.thinkingLevel !== "off"
						? { reasoning_effort: model.thinkingLevelMap?.[options.thinkingLevel] ?? options.thinkingLevel } : {}),
				} : options.thinkingLevel && options.thinkingLevel !== "off" && model.reasoning
					? { reasoning_effort: model.thinkingLevelMap?.[options.thinkingLevel] ?? options.thinkingLevel } : {}),
				[maxTokensField]: Math.min(maxOutputTokens ?? model.maxOutputTokens, model.maxOutputTokens),
				tools: tools?.length ? tools.map((tool) => ({ type: "function", function: tool })) : undefined,
			}),
			signal,
		});
		if (!response.ok) {
			const body = (await response.text()).trim();
			const error = body.startsWith("{") ? parseErrorBody(body) : undefined;
			return finish("error", classifyError(error, `${provider} HTTP ${response.status}`, response.status));
		}
		if (!response.body) return finish("error", { kind: "protocol", message: `${provider} 返回了空响应。` });

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
							return finish("error", { kind: "protocol", message: `${provider} 返回了不完整或重复的工具调用标识。` });
						}
						return finish("toolUse", undefined, calls);
					}
					if (pendingCalls.size && stopReason !== "length") {
						return finish("error", { kind: "protocol", message: `${provider} 未完整结束工具调用。` });
					}
					if (!reply && stopReason === "stop") return finish("error", { kind: "protocol", message: `${provider} 未返回文本。` });
					return finish(stopReason);
				}

				const chunk: CompletionChunk = JSON.parse(payload);
				if (chunk.error) return finish("error", classifyError(chunk.error, `${provider} 返回了流式错误。`));
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
						return finish("error", { kind: "protocol", message: `${provider} 返回了无效的工具调用索引。` });
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
					case "content_filter": return finish("error", { kind: "provider", message: `${provider} 已过滤此回复。` });
				}
			}
		}
		return signal.aborted ? finish("aborted") : finish("error", { kind: "network", message: `${provider} 响应提前结束。` });
	} catch (error) {
		if (signal.aborted) return finish("aborted");
		return finish("error", { kind: error instanceof SyntaxError ? "protocol" : "network", message: errorMessage(error) });
	}
};

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

function encodeMessages(context: readonly ModelMessage[], deepseek: boolean): object[] {
	const messages: object[] = [];
	for (let index = 0; index < context.length; index++) {
		const message = context[index];
		const content = messageText(message);
		if (message.role === "assistant") {
			const calls = toolCalls(message);
			messages.push({
				role: "assistant", content: content || (calls.length ? null : ""),
				...(deepseek ? { reasoning_content: "" } : {}),
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
