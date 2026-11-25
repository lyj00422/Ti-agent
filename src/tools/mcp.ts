import { createHash } from "node:crypto";
import type { ImageContent, TextContent } from "../agent/messages.ts";
import type { ToolDefinition, ToolExposure, ToolRegistry } from "./registry.ts";

export interface McpTool {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
	content: readonly (TextContent | ImageContent)[];
	structuredContent?: unknown;
	isError?: boolean;
}

export interface McpToolClient {
	listTools(): Promise<readonly McpTool[]>;
	callTool(
		name: string,
		args: Record<string, unknown>,
		options: { signal: AbortSignal | undefined },
	): Promise<McpToolResult>;
}

const MAX_TOOL_NAME_LENGTH = 64;

// Naming and schema defaults adapted from Pi. See THIRD_PARTY_NOTICES.md.
export async function registerMcpTools(
	registry: ToolRegistry, server: string, client: McpToolClient, exposure: ToolExposure = "direct",
): Promise<void> {
	if (!/^[A-Za-z0-9_-]+$/.test(server)) throw new Error("MCP 服务名无效 " + server);
	const tools = await client.listTools();
	const existing = registry.getAllTools();
	const namespace = server.replaceAll("-", "_");
	if (existing.some(({ source }) => source.type === "mcp" && source.server.replaceAll("-", "_") === namespace)) {
		throw new Error("MCP 服务名重复 " + server);
	}
	const occupied = new Set(existing.map(({ name }) => name));
	const names = tools.map(({ name }) => `mcp__${server}__${name}`.replace(/[^A-Za-z0-9_]/g, "_"));
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);

	const definitions = tools.map((tool, index): ToolDefinition => {
		const plain = names[index];
		let name = plain;
		if (plain.length > MAX_TOOL_NAME_LENGTH || occupied.has(plain) || counts.get(plain)! > 1) {
			const hash = createHash("sha256").update(`${server}\0${tool.name}`).digest("hex").slice(0, 8);
			name = `${plain.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
		}
		if (occupied.has(name)) throw new Error("MCP 工具名重复 " + name);
		occupied.add(name);
		const { type = "object", properties = {}, ...schema } = tool.inputSchema;
		if (type !== "object") throw new Error(`MCP 工具 ${server}/${tool.name} 必须使用对象参数。`);
		return {
			name,
			label: `${server}/${tool.name}`,
			description: tool.description?.trim() || `MCP tool ${tool.name} from server ${server}`,
			parameters: { ...schema, type, properties },
			async execute(_id, args, signal) {
				const { content, structuredContent, isError } = await client.callTool(tool.name, args as Record<string, unknown>, { signal });
				return { content: [...content], structuredContent, isError };
			},
		};
	});
	for (const definition of definitions) registry.register(definition, { type: "mcp", server, exposure });
}
