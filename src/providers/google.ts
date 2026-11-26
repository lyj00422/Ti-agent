import { randomUUID } from "node:crypto";
import { errorMessage, messageText, toolCalls } from "../agent/messages.ts";
import type { AssistantMessage, ChatError, ModelMessage, ToolCall, ToolDeclaration, Usage } from "../agent/messages.ts";
import type { ModelDescriptor, ProviderStream, ThinkingLevel } from "./types.ts";

interface GeminiPart {
	text?: string;
	functionCall?: { name?: string; args?: unknown; id?: string };
}

interface GeminiChunk {
	candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
	usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
	error?: { code?: number; message?: string; status?: string };
}

export const streamGoogleReply: ProviderStream = async (model, context, options) => {
	const timestamp = Date.now();
	let text = "";
	let usage: Usage | undefined;
	const calls = new Map<string, ToolCall>();
	const finish = (stopReason: AssistantMessage["stopReason"], error?: ChatError): AssistantMessage => ({
		role: "assistant",
		content: [...(text ? [{ type: "text" as const, text }] : []), ...calls.values()],
		timestamp,
		stopReason,
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

	const level = options.thinkingLevel ?? "off";
	const modelName = model.id.replace(/^models\//, "");
	const endpoint = `${model.baseUrl?.replace(/\/+$/, "")}/models/${encodeURIComponent(modelName)}:streamGenerateContent?alt=sse`;
	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { ...model.headers, "x-goog-api-key": key, "content-type": "application/json", accept: "text/event-stream" },
			body: JSON.stringify(buildRequest(context, model, level, options.maxOutputTokens, options.tools)),
			signal: options.signal,
		});
		if (!response.ok) return finish("error", googleError(response.status, (await response.text()).trim()));
		if (!response.body) return finish("error", { kind: "protocol", message: "Google Gemini 返回了空响应。" });

		let pending = "";
		for await (const part of response.body.pipeThrough(new TextDecoderStream())) {
			pending += part;
			const lines = pending.split(/\r?\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.startsWith("data:")) continue;
				const payload = line.slice(5).trim();
				if (!payload) continue;
				const chunk = JSON.parse(payload) as GeminiChunk;
				if (chunk.error) return finish("error", googleError(chunk.error.code ?? 0, chunk.error.message ?? "Google Gemini 请求失败。"));
				if (chunk.usageMetadata) {
					usage = {
						input: chunk.usageMetadata.promptTokenCount ?? 0,
						output: (chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0),
						cacheRead: chunk.usageMetadata.cachedContentTokenCount ?? 0,
					};
					options.onEvent({ type: "usage", usage });
				}
				for (const candidate of chunk.candidates ?? []) {
					for (const block of candidate.content?.parts ?? []) {
						if (typeof block.text === "string" && block.text) {
							text += block.text;
							options.onEvent({ type: "text_delta", text: block.text });
						}
						if (block.functionCall) {
							const id = block.functionCall.id || randomUUID();
							calls.set(id, {
								type: "toolCall", id, name: block.functionCall.name ?? "",
								arguments: asArguments(block.functionCall.args),
							});
						}
					}
					if (candidate.finishReason === "MAX_TOKENS") return finish("length");
				}
			}
		}
		if (options.signal.aborted) return finish("aborted");
		if (calls.size) return finish("toolUse");
		if (!text) return finish("error", { kind: "protocol", message: "Google Gemini 未返回文本。" });
		return finish("stop");
	} catch (error) {
		if (options.signal.aborted) return finish("aborted");
		return finish("error", { kind: error instanceof SyntaxError ? "protocol" : "network", message: errorMessage(error) });
	}
};

function buildRequest(
	context: readonly ModelMessage[],
	model: ModelDescriptor,
	level: ThinkingLevel,
	maxOutputTokens: number | undefined,
	tools: readonly ToolDeclaration[] | undefined,
): Record<string, unknown> {
	const system: string[] = [];
	const contents: Array<{ role: "user" | "model"; parts: object[] }> = [];
	const push = (role: "user" | "model", parts: object[]) => {
		if (!parts.length) return;
		const previous = contents.at(-1);
		if (previous?.role === role) previous.parts.push(...parts);
		else contents.push({ role, parts });
	};

	for (let index = 0; index < context.length; index++) {
		const message = context[index];
		if (message.role === "system") {
			system.push(messageText(message));
		} else if (message.role === "assistant") {
			push("model", [
				...message.content.flatMap((block) => block.type === "text" ? [{ text: block.text }] : []),
				...toolCalls(message).map((call) => ({ functionCall: { name: call.name, args: call.arguments, id: call.id } })),
			]);
		} else if (message.role === "toolResult") {
			const results: object[] = [];
			let current = message;
			while (true) {
				results.push({ functionResponse: {
					name: current.toolName,
					id: current.toolCallId,
					response: { content: messageText(current), isError: current.isError },
				} });
				for (const image of current.content) {
					if (image.type === "image") results.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
				}
				const next = context[index + 1];
				if (next?.role !== "toolResult") break;
				index++;
				current = next;
			}
			push("user", results);
		} else {
			push("user", message.content.map((block) => ({ text: block.text })));
		}
	}

	const generationConfig: Record<string, unknown> = {};
	if (maxOutputTokens !== undefined) generationConfig.maxOutputTokens = Math.min(maxOutputTokens, model.maxOutputTokens);
	if (model.reasoning) {
		const modelUsesThinkingLevel = /(?:gemini-3|gemini-4)/.test(model.id);
		generationConfig.thinkingConfig = modelUsesThinkingLevel
			? { includeThoughts: level !== "off", thinkingLevel: level === "off" ? "LOW" : level.toUpperCase() }
			: { includeThoughts: level !== "off", thinkingBudget: thinkingBudget(level) };
	}
	return {
		...(system.length ? { systemInstruction: { parts: system.map((text) => ({ text })) } } : {}),
		contents,
		...(tools?.length ? { tools: [{ functionDeclarations: tools.map((tool) => ({
			name: tool.name, description: tool.description, parameters: tool.parameters,
		})) }] } : {}),
		...(Object.keys(generationConfig).length ? { generationConfig } : {}),
	};
}

function thinkingBudget(level: ThinkingLevel): number {
	if (level === "off") return 0;
	if (level === "minimal" || level === "low") return 1_024;
	if (level === "medium") return 4_096;
	return 8_192;
}

function asArguments(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function googleError(status: number, detail: string): ChatError {
	const kind = status === 401 || status === 403 ? "auth" : status === 429 ? "rateLimit"
		: /context|token count|input token/i.test(detail) ? "contextOverflow" : "provider";
	const message = kind === "auth" ? `${detail} 请检查 API Key 或使用 /login google。` : detail;
	return { kind, status: status || undefined, message };
}
