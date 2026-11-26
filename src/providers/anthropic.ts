import { errorMessage, messageText, toolCalls } from "../agent/messages.ts";
import type { AssistantMessage, ChatError, ModelMessage, ToolCall, Usage } from "../agent/messages.ts";
import type { ProviderStream, ThinkingLevel } from "./types.ts";

const ANTHROPIC_VERSION = "2023-06-01";

interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: unknown;
}

interface StreamEvent {
	type?: string;
	index?: number;
	message?: { usage?: AnthropicUsage };
	content_block?: ContentBlock;
	delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string | null };
	usage?: AnthropicUsage;
	error?: { type?: string; message?: string };
}

interface AnthropicUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

export const streamAnthropicReply: ProviderStream = async (model, context, streamOptions) => {
	const { signal, maxOutputTokens, tools, onEvent } = streamOptions;
	const providerName = model.name ?? model.provider;
	const timestamp = Date.now();
	let reply = "";
	let stopReason: "stop" | "length" | "toolUse" = "stop";
	let usage: Usage | undefined;
	const blocks = new Map<number, { type: string; id: string; name: string; arguments: string }>();
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
		key = streamOptions.resolveApiKey();
	} catch (error) {
		return finish("error", { kind: "auth", message: errorMessage(error) });
	}
	const { system, messages } = encodeMessages(context);
	const baseUrl = model.baseUrl!.replace(/\/+$/, "");
	const versionedUrl = /\/v1(?:\/messages)?$/i.test(baseUrl) ? baseUrl : baseUrl + "/v1";
	const endpoint = /\/messages$/i.test(versionedUrl) ? versionedUrl : versionedUrl + "/messages";

	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				...model.headers,
				"x-api-key": key,
				"anthropic-version": ANTHROPIC_VERSION,
				"content-type": "application/json",
				accept: "text/event-stream",
			},
			body: JSON.stringify({
				model: model.id,
				messages,
				stream: true,
				max_tokens: Math.min(maxOutputTokens ?? model.maxOutputTokens, model.maxOutputTokens),
				...(model.reasoning && streamOptions.thinkingLevel && streamOptions.thinkingLevel !== "off" ? {
					thinking: {
						type: "enabled",
						budget_tokens: thinkingBudget(streamOptions.thinkingLevel,
							Math.min(maxOutputTokens ?? model.maxOutputTokens, model.maxOutputTokens)),
					},
				} : {}),
				...(system ? { system } : {}),
				...(tools?.length ? {
					tools: tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						input_schema: tool.parameters,
					})),
				} : {}),
			}),
			signal,
		});
		if (!response.ok) {
			const body = (await response.text()).trim();
			const error = body.startsWith("{") ? parseErrorBody(body) : undefined;
			return finish("error", classifyError(error, `${providerName} HTTP ${response.status}`, response.status));
		}
		if (!response.body) return finish("error", { kind: "protocol", message: `${providerName} 返回了空响应。` });

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
				if (!payload) continue;
				let event: StreamEvent;
				try {
					event = JSON.parse(payload) as StreamEvent;
				} catch (error) {
					if (error instanceof SyntaxError) return finish("error", { kind: "protocol", message: `${providerName} 返回了无法解析的流式数据。` });
					throw error;
				}

				if (event.type === "error") {
					return finish("error", classifyError(event.error, `${providerName} 返回了流式错误。`));
				}
				const rawUsage = event.message?.usage ?? (event.type === "message_delta" ? event.usage : undefined);
				if (rawUsage) {
					const input = rawUsage.input_tokens;
					const output = rawUsage.output_tokens;
					if (typeof input === "number" && typeof output === "number" && (input > 0 || output > 0)) {
						const cacheRead = rawUsage.cache_read_input_tokens;
						usage = {
							input: input + (rawUsage.cache_creation_input_tokens ?? 0),
							output,
							...(typeof cacheRead === "number" ? { cacheRead } : {}),
						};
						onEvent({ type: "usage", usage });
					}
				}

				if (event.type === "content_block_start" && typeof event.index === "number") {
					const block = event.content_block ?? { type: "text" };
					blocks.set(event.index, {
						type: block.type,
						id: block.id ?? "",
						name: block.name ?? "",
						arguments: block.type === "tool_use" && block.input && Object.keys(block.input as object).length
							? JSON.stringify(block.input)
							: "",
					});
					continue;
				}
				if (event.type === "content_block_delta") {
					const delta = event.delta;
					if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
						reply += delta.text;
						onEvent({ type: "text_delta", text: delta.text });
					} else if (delta?.type === "input_json_delta" && typeof event.index === "number") {
						const entry = blocks.get(event.index);
						if (entry && typeof delta.partial_json === "string") entry.arguments += delta.partial_json;
					}
					continue;
				}
				if (event.type === "message_delta") {
					const reason = event.delta?.stop_reason;
					if (reason === "tool_use") stopReason = "toolUse";
					else if (reason === "max_tokens") stopReason = "length";
					else if (reason === "refusal") return finish("error", { kind: "provider", message: `${providerName} 已拒绝此回复。` });
					continue;
				}
				if (event.type === "message_stop") {
					if (signal.aborted) return finish("aborted");
					const calls = [...blocks.entries()]
						.sort(([a], [b]) => a - b)
						.map(([, entry]) => entry)
						.filter((entry) => entry.type === "tool_use")
						.map((entry) => parseToolCall(entry));
					if (stopReason === "toolUse") {
						if (!calls.length || calls.some((call) => !call.id || !call.name) || new Set(calls.map((call) => call.id)).size !== calls.length) {
							return finish("error", { kind: "protocol", message: `${providerName} 返回了不完整或重复的工具调用标识。` });
						}
						return finish("toolUse", undefined, calls);
					}
					if (calls.length && stopReason !== "length") {
						return finish("error", { kind: "protocol", message: `${providerName} 未完整结束工具调用。` });
					}
					if (!reply && !calls.length && stopReason === "stop") return finish("error", { kind: "protocol", message: `${providerName} 未返回文本。` });
					return finish(stopReason, undefined, calls);
				}
			}
		}
		return signal.aborted ? finish("aborted") : finish("error", { kind: "network", message: `${providerName} 响应提前结束。` });
	} catch (error) {
		if (signal.aborted) return finish("aborted");
		return finish("error", { kind: error instanceof SyntaxError ? "protocol" : "network", message: errorMessage(error) });
	}
};

function thinkingBudget(level: ThinkingLevel, maxTokens: number): number {
	const desired = level === "low" || level === "minimal" ? 1_024
		: level === "medium" ? 4_096
			: level === "high" ? 8_192 : 16_384;
	return Math.max(1_024, Math.min(desired, Math.floor(maxTokens * 0.75), maxTokens - 1));
}

function parseToolCall(entry: { id: string; name: string; arguments: string }): ToolCall {
	const base = { type: "toolCall" as const, id: entry.id, name: entry.name };
	try {
		const args: unknown = entry.arguments.trim() ? JSON.parse(entry.arguments) : {};
		if (args && typeof args === "object" && !Array.isArray(args)) {
			return { ...base, arguments: args as Record<string, unknown> };
		}
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
	}
	return { ...base, arguments: {}, argumentError: "工具参数必须是完整的 JSON 对象。" };
}

/** Converts Ti's flat message list into Anthropic's system prompt plus alternating message blocks. */
function encodeMessages(context: readonly ModelMessage[]): { system?: string; messages: object[] } {
	const system: string[] = [];
	const messages: object[] = [];
	const push = (role: "user" | "assistant", blocks: object[]) => {
		if (!blocks.length) return;
		const previous = messages.at(-1) as { role: string; content: object[] } | undefined;
		if (previous?.role === role) previous.content.push(...blocks);
		else messages.push({ role, content: blocks });
	};

	for (let index = 0; index < context.length; index++) {
		const message = context[index];
		if (message.role === "system") {
			const text = messageText(message);
			if (text) system.push(text);
			continue;
		}
		if (message.role === "user") {
			push("user", textBlocks(message));
			continue;
		}
		if (message.role === "assistant") {
			const calls = toolCalls(message);
			const blocks = [
				...textBlocks(message),
				...calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })),
			];
			push("assistant", blocks);
			continue;
		}
		const results: object[] = [];
		let result = message;
		while (true) {
			const attachments = result.content.filter((block) => block.type === "image");
			const text = messageText(result) || (attachments.length ? "(see attached image)" : "(no tool output)");
			results.push({
				type: "tool_result",
				tool_use_id: result.toolCallId,
				content: text,
				...(result.isError ? { is_error: true } : {}),
			});
			for (const image of attachments) {
				results.push({
					type: "image",
					source: { type: "base64", media_type: image.mimeType, data: image.data },
				});
			}
			const next = context[index + 1];
			if (next?.role !== "toolResult") break;
			index++;
			result = next;
		}
		push("user", results);
	}
	return system.length ? { system: system.join("\n\n"), messages } : { messages };
}

function textBlocks(message: ModelMessage): object[] {
	return message.content.flatMap((block) => {
		if (block.type !== "text") return [];
		return block.text ? [{ type: "text", text: block.text }] : [];
	});
}

function parseErrorBody(body: string): StreamEvent["error"] {
	try {
		const parsed = JSON.parse(body) as { error?: StreamEvent["error"] };
		return parsed.error;
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		return undefined;
	}
}

function classifyError(error: StreamEvent["error"], fallback: string, status?: number): ChatError {
	const code = error?.type;
	const detail = error?.message;
	const message = detail && status !== undefined ? `${fallback}  ${detail}` : detail || fallback;
	if (status === 401 || status === 403 || code === "authentication_error" || code === "permission_error") {
		return { kind: "auth", status, code, message: message + "。请检查 API Key 或使用 /login。" };
	}
	if (status === 429 || code === "rate_limit_error" || code === "rate_limit_exceeded") {
		return { kind: "rateLimit", status, code, message };
	}
	if (code === "context_length_exceeded" || /maximum context length|exceeds? (?:the )?(?:model's )?(?:maximum )?context (?:length|window)|prompt (?:is )?too long|too many (?:input )?tokens/i.test(detail ?? "")) {
		return { kind: "contextOverflow", status, code, message };
	}
	if (code === "overloaded_error") return { kind: "rateLimit", status, code, message };
	return { kind: "provider", status, code, message };
}
