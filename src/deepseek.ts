import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "./agent.ts";

export const MODEL_ID = "deepseek-flash";

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
	choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
	error?: { message?: string };
}

export async function streamReply(
	history: readonly ChatMessage[],
	key: string,
	onDelta: (text: string) => void,
	signal: AbortSignal,
): Promise<"stop" | "length"> {
	const messages = history
		.filter((message) => message.text && message.stopReason !== "error" && message.stopReason !== "aborted")
		.map(({ role, text }) => role === "assistant"
			? { role, content: text, reasoning_content: "" }
			: { role, content: text });

	const response = await fetch("https://api.deepseek.com/chat/completions", {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "text/event-stream" },
		body: JSON.stringify({ model: MODEL_ID, messages, stream: true, thinking: { type: "disabled" } }),
		signal,
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`DeepSeek HTTP ${response.status} ${response.statusText}`.trimEnd());
	}
	if (!response.body) throw new Error("DeepSeek 返回了空响应。");

	let stopReason: "stop" | "length" = "stop";
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
			if (payload === "[DONE]") return stopReason;

			const chunk: CompletionChunk = JSON.parse(payload);
			if (chunk.error) throw new Error(chunk.error.message || "DeepSeek 返回了流式错误。");
			const choice = chunk.choices?.[0];
			const delta = choice?.delta?.content;
			if (typeof delta === "string" && delta) onDelta(delta);
			if (choice?.finish_reason === "length") stopReason = "length";
			if (choice?.finish_reason === "content_filter") throw new Error("DeepSeek 已过滤此回复。");
			if (choice?.finish_reason === "tool_calls") throw new Error("Ti 当前仅支持文本回复。");
		}
	}
	throw new Error("DeepSeek 响应提前结束。");
}
