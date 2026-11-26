import { Worker } from "node:worker_threads";
import { Type } from "typebox";
import type { ToolDefinition, ToolResult } from "./registry.ts";

const parameters = Type.Object({
	code: Type.String({ description: "JavaScript async function body that calls tools." }),
});

interface WorkerMessage {
	type: "tool_call" | "output" | "complete";
	id?: number;
	name?: string;
	input?: string;
	kind?: string;
	value?: string;
	error?: string;
}

export function createCodemodeToolDefinition(): ToolDefinition<typeof parameters, { calls: string[] }> {
	return {
		name: "codemode",
		label: "Codemode",
		description: "Run JavaScript to discover, combine, and call tools. Use searchTools(query), describeTool(name), ALL_TOOLS, and tools.<name>(args). Use text(value) to return text to the model.",
		parameters,
		defaultActive: false,
		async execute(id, { code }, signal, onUpdate, context): Promise<ToolResult<{ calls: string[] }>> {
			const tools = context.getCodemodeTools().map(({ name, description, parameters: schema }) => ({ name, description, parameters: schema }));
			const worker = new Worker(new URL("./codemode-worker.ts", import.meta.url), { workerData: { code, tools } });
			const controller = new AbortController();
			const combinedSignal = AbortSignal.any([signal ?? new AbortController().signal, controller.signal]);
			const calls: string[] = [];
			const content: ToolResult["content"] = [];
			let terminate = false;
			const timeout = setTimeout(() => controller.abort(new DOMException("Codemode timed out", "TimeoutError")), 65_000);
			const stop = () => controller.abort(signal?.reason);
			signal?.addEventListener("abort", stop, { once: true });
			try {
				return await new Promise((resolve, reject) => {
					let settled = false;
					const finish = (error?: unknown, result?: ToolResult<{ calls: string[] }>) => {
						if (settled) return;
						settled = true;
						if (error) reject(error);
						else resolve(result!);
					};
					combinedSignal.addEventListener("abort", () => {
						void worker.terminate();
						finish(combinedSignal.reason ?? new Error("Codemode aborted"));
					}, { once: true });
					worker.on("message", (message: WorkerMessage) => {
						if (message.type === "tool_call") {
							calls.push(message.name ?? "");
							void context.executeTool(message.name ?? "", JSON.parse(message.input ?? "{}"), combinedSignal, id).then(
								(result) => {
									terminate ||= result.terminate === true;
									const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
									const value = result.structuredContent ?? (result.content.some((block) => block.type === "image") ? result.content : text);
									if (settled) return;
									worker.postMessage({ type: "tool_result", id: message.id, result: {
										value,
										isError: result.isError === true,
										error: result.isError ? result.content.map((block) => block.type === "text" ? block.text : "").join("\n") : undefined,
									} });
								},
								(error: unknown) => {
									if (!settled) worker.postMessage({ type: "tool_result", id: message.id, error: error instanceof Error ? error.message : String(error) });
								},
						);
						} else if (message.type === "output") {
							if (message.kind === "text" || message.kind === "console") content.push({ type: "text", text: message.value ?? "" });
							else if (message.kind === "image") {
								const image = parseImageOutput(message.value ?? "");
								if (image) content.push(image);
								else content.push({ type: "text", text: "image() expects a data URL or image content block." });
							}
							onUpdate?.({ content: [...content] });
						} else if (message.type === "complete") {
							if (message.error) finish(undefined, { content: [...content, { type: "text", text: "Script error: " + message.error }], details: { calls }, isError: true, terminate });
							else {
								if (message.value && message.value !== "undefined") content.push({ type: "text", text: message.value });
								finish(undefined, { content, details: { calls }, isError: false, terminate });
							}
						}
					});
					worker.once("error", (error) => finish(error));
					worker.once("exit", (code) => {
						if (!settled) finish(new Error(`Codemode worker exited (${code})`));
					});
				});
			} finally {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", stop);
				await worker.terminate();
			}
		},
	};
}

function parseImageOutput(serialized: string): ToolResult["content"][number] | undefined {
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		return undefined;
	}
	if (typeof value !== "string" && (!value || typeof value !== "object" || !("data" in value) || !("mimeType" in value))) return undefined;
	if (typeof value === "string") {
		const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(value);
		return match ? { type: "image", mimeType: match[1], data: match[2] } : undefined;
	}
	const image = value as { data: unknown; mimeType: unknown; type?: unknown };
	return typeof image.data === "string" && typeof image.mimeType === "string"
		? { type: "image", mimeType: image.mimeType, data: image.data }
		: undefined;
}
