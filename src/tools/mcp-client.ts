import { readFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { errorMessage } from "../agent/messages.ts";
import type { ImageContent, TextContent } from "../agent/messages.ts";
import { resolvePath } from "./files/paths.ts";
import { httpTransport, McpClient, stdioTransport } from "./mcp-protocol.ts";
import { registerMcpTools } from "./mcp.ts";
import type { McpTool, McpToolResult } from "./mcp.ts";
import { truncateHead, truncateTail } from "./output/truncate.ts";
import type { ToolExposure, ToolRegistry } from "./registry.ts";

interface McpServerOptions {
	description?: string;
	enabled?: boolean;
	timeout?: number;
	exposure?: ToolExposure;
}

interface StdioServer extends McpServerOptions {
	type?: "stdio";
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
}

interface HttpServer extends McpServerOptions {
	type?: "http" | "streamable-http";
	url: string;
	headers?: Record<string, string>;
}

export type McpServerConfig = StdioServer | HttpServer;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateMcpServerConfig(name: string, raw: unknown): (StdioServer & { type: "stdio" }) | (HttpServer & { type: "streamable-http" }) {
	if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`MCP 服务名无效 ${name}`);
	if (!isRecord(raw)) throw new Error("MCP 服务配置必须是对象。");
	const { type, url, command, enabled, timeout } = raw;
	if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("enabled 必须是布尔值。");
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout >= 0.001 && timeout <= 2_147_483.647))) {
		throw new Error("timeout 超出支持的秒数范围。");
	}
	mcpExposure(raw.exposure);
	const checkVariables = (field: "headers" | "env") => {
		const values = raw[field];
		if (values !== undefined && (!isRecord(values) || Object.values(values).some((value) => typeof value !== "string"))) {
			throw new Error(`${field} 必须是字符串键值对。`);
		}
	};
	if (typeof url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) throw new Error("url 必须使用 HTTP 或 HTTPS。");
		if (raw.oauth !== undefined) throw new Error("此版本通过 headers 配置 HTTP 认证。");
		checkVariables("headers");
		return { ...raw, type: "streamable-http", url } as HttpServer & { type: "streamable-http" };
	}
	if (typeof command === "string" && command.trim() && (type === undefined || type === "stdio")) {
		const { args, cwd } = raw;
		if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))) {
			throw new Error("args 必须是字符串数组。");
		}
		if (cwd !== undefined && typeof cwd !== "string") throw new Error("cwd 必须是字符串。");
		checkVariables("env");
		return { ...raw, type: "stdio", command } as StdioServer & { type: "stdio" };
	}
	throw new Error("请配置 stdio 的 command 或 Streamable HTTP 的 url。");
}

export async function readMcpConfig(path: string, optional: boolean): Promise<Record<string, unknown> & { mcpServers: Record<string, unknown> }> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return { mcpServers: {} };
		throw new Error(`无法读取 MCP 配置 ${path}（${(error as NodeJS.ErrnoException).code ?? "读取失败"}）`, { cause: error });
	}
	let config: unknown;
	try {
		config = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch (error) {
		throw new Error(`MCP 配置 ${path} 不是有效的 JSON。`, { cause: error });
	}
	if (!isRecord(config) || !isRecord(config.mcpServers)) {
		throw new Error(`MCP 配置 ${path} 必须包含 mcpServers 对象。`);
	}
	return { ...config, mcpServers: config.mcpServers };
}

export async function readMcpServers(path: string, optional: boolean): Promise<Record<string, unknown>> {
	return (await readMcpConfig(path, optional)).mcpServers;
}

export function mcpExposure(value: unknown): ToolExposure {
	if (value === undefined) return "codemode";
	if (value === "deferred" || value === "codemode" || value === "direct" || value === "hidden") return value;
	throw new Error("exposure 必须是 codemode、deferred、direct 或 hidden。");
}

function resolveVariables(values: Record<string, string> | undefined): Record<string, string> {
	return Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [
		key,
		value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
			const variable = process.env[name];
			if (variable === undefined) throw new Error("缺少环境变量 " + name);
			return variable;
		}),
	]));
}

function diagnostic(error: unknown): string {
	return stripVTControlCharacters(errorMessage(error)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 300);
}

export async function connectMcpServers(
	registry: ToolRegistry,
	cwd: string,
	servers: Readonly<Record<string, unknown>>,
	warn: (message: string) => void,
	signal?: AbortSignal,
	onStatus?: (name: string, status: "connected" | "disabled", exposure: ToolExposure) => void,
): Promise<() => Promise<void>> {
	const clients = new Map<McpClient, string>();
	const namespaces = new Set<string>();
	const closeClient = async (client: McpClient, name: string) => {
		clients.delete(client);
		try {
			await client.close();
		} catch (error) {
			warn(`MCP ${name} · 关闭失败 · ${diagnostic(error)}`);
		}
	};
	let closing: Promise<void> | undefined;
	const dispose = () => {
		closing ??= Promise.all(Array.from(clients, ([client, name]) => closeClient(client, name))).then(() => {});
		return closing;
	};
	const abortConnections = () => { void dispose(); };
	signal?.addEventListener("abort", abortConnections, { once: true });
	try {
		signal?.throwIfAborted();
		for (const [name, raw] of Object.entries(servers)) {
			const namespace = name.replaceAll("-", "_");
			let stage = "配置";
			let client: McpClient | undefined;
			try {
				const config = validateMcpServerConfig(name, raw);
				const exposure = mcpExposure(config.exposure);
				if (config.enabled === false) {
					onStatus?.(name, "disabled", exposure);
					continue;
				}
				if (namespaces.has(namespace)) throw new Error("服务名重复。");
				const timeoutMs = Math.round((config.timeout ?? 60) * 1000);
				const transport = config.type === "streamable-http"
					? httpTransport(config.url, new Headers(resolveVariables(config.headers)), timeoutMs)
					: stdioTransport(config.command, config.args ?? [], resolvePath(config.cwd ?? ".", cwd), {
						...process.env, ...resolveVariables(config.env),
					});
				stage = "连接";
				const connection = new McpClient(transport, timeoutMs);
				client = connection;
				clients.set(connection, name);
				const hasTools = await connection.initialize(signal);
				signal?.throwIfAborted();

				stage = "发现工具";
				if (hasTools) {
					await registerMcpTools(registry, name, {
						async listTools() {
							const tools: McpTool[] = [];
							let cursor: string | undefined;
							do {
								const page = await connection.request<{ tools: McpTool[]; nextCursor?: string }>(
									"tools/list", cursor ? { cursor } : undefined, signal,
								);
								tools.push(...page.tools);
								cursor = page.nextCursor;
							} while (cursor);
							return tools;
						},
						async callTool(tool, args, options) {
							const result = await connection.request<RemoteToolResult>(
								"tools/call", { name: tool, arguments: args }, options.signal,
							);
							return modelToolResult(result);
						},
					}, exposure);
				}
				namespaces.add(namespace);
				onStatus?.(name, "connected", exposure);
			} catch (error) {
				if (client && clients.has(client)) await closeClient(client, name);
				signal?.throwIfAborted();
				warn(`MCP ${name} · ${stage}失败 · ${diagnostic(error)}`);
			}
			signal?.throwIfAborted();
		}
		return dispose;
	} catch (error) {
		await dispose();
		throw error;
	} finally {
		signal?.removeEventListener("abort", abortConnections);
	}
}

interface ContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	name?: string;
	uri?: string;
	resource?: { uri: string; text?: string; blob?: string; mimeType?: string };
}

interface RemoteToolResult {
	content?: ContentBlock[];
	structuredContent?: unknown;
	isError?: boolean;
}

function modelToolResult(result: RemoteToolResult): McpToolResult {
	const { structuredContent, isError } = result;
	const content = (result.content ?? []).map((block): TextContent | ImageContent => {
		if (block.type === "text") return { type: "text", text: block.text! };
		if (block.type === "image") return { type: "image", mimeType: block.mimeType!, data: block.data! };
		if (block.type === "resource_link") return { type: "text", text: `${block.name}: ${block.uri}` };
		if (block.type === "resource") {
			const resource = block.resource!;
			if (resource.text !== undefined) return { type: "text", text: resource.text };
			if (resource.mimeType?.startsWith("image/")) {
				return { type: "image", mimeType: resource.mimeType, data: resource.blob! };
			}
			return { type: "text", text: `[MCP resource: ${resource.uri}]` };
		}
		return { type: "text", text: `[MCP ${block.type} content omitted]` };
	});
	if (!content.length && structuredContent !== undefined) {
		content.push({ type: "text", text: JSON.stringify(structuredContent, null, 2) });
	}
	const text = content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
	if (Buffer.byteLength(text) <= 20 * 1024) return { content, structuredContent, isError };
	const limits = { maxBytes: 10 * 1024 };
	const head = truncateHead(text, limits).content;
	const tail = truncateTail(text, limits).content;
	return {
		content: [
			{ type: "text", text: `${head}\n[部分 MCP 文本输出已截断]\n${tail}` },
			...content.filter((block) => block.type === "image"),
		],
		structuredContent, isError,
	};
}
