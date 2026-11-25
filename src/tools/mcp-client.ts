import { readFile } from "node:fs/promises";
import {
	limitMcpContent, McpClient, McpHttpError, StdioTransport, StreamableHttpTransport, toLlmContent, validateMcpServerConfig,
} from "@earendil-works/pi-mcp";
import type { McpServerConfig as PiMcpServerConfig } from "@earendil-works/pi-mcp";
import { stripVTControlCharacters } from "node:util";
import { errorMessage } from "../agent/messages.ts";
import { resolvePath } from "./files/paths.ts";
import { registerMcpTools } from "./mcp.ts";
import type { ToolExposure, ToolRegistry } from "./registry.ts";

export type McpServerConfig = PiMcpServerConfig & { exposure?: ToolExposure };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
	if (value === undefined) return "deferred";
	if (value === "deferred" || value === "direct" || value === "hidden") return value;
	throw new Error("exposure 必须是 deferred、direct 或 hidden。");
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
	if (error instanceof McpHttpError) return `HTTP ${error.status}`;
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
			const entry = validateMcpServerConfig(name, raw);
			if (entry.kind === "invalid") {
				warn(`MCP 配置无效 · ${diagnostic(entry.error)}`);
				continue;
			}
			const { config } = entry;
			const namespace = name.replaceAll("-", "_");
			let stage = "配置";
			let client: McpClient | undefined;
			try {
				const exposure = mcpExposure(config.exposure);
				if (config.enabled === false) {
					onStatus?.(name, "disabled", exposure);
					continue;
				}
				if (namespaces.has(namespace)) throw new Error("服务名重复。");
				const requestTimeoutMs = (config.timeout ?? 60) * 1000;
				if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 2_147_483_647) {
					throw new Error("timeout 超出支持的秒数范围。");
				}
				if (entry.kind === "http" && entry.config.oauth !== undefined) {
					throw new Error("此版本通过 headers 配置 HTTP 认证。");
				}
				const transport = entry.kind === "http"
					? new StreamableHttpTransport({ url: entry.config.url, headers: resolveVariables(entry.config.headers) })
					: new StdioTransport({
						command: entry.config.command,
						args: entry.config.args,
						cwd: resolvePath(entry.config.cwd ?? ".", cwd),
						env: resolveVariables(entry.config.env),
					});
				stage = "连接";
				const connection = new McpClient({ name: "Ti", version: "0.1.0", requestTimeoutMs });
				client = connection;
				clients.set(connection, name);
				await connection.connect(transport);
				signal?.throwIfAborted();

				stage = "发现工具";
				if (connection.serverCapabilities?.tools) {
					await registerMcpTools(registry, name, {
						listTools: () => connection.listTools(),
						async callTool(tool, args, options) {
							const result = await connection.callTool(tool, args, options);
							const { content } = await limitMcpContent(toLlmContent(result));
							return { content, structuredContent: result.structuredContent, isError: result.isError };
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
