import { resolve } from "node:path";
import { ChatSession } from "./session/chat-session.ts";
import type { ChatSessionOptions } from "./session/chat-session.ts";
import type { SessionStore } from "./session/store.ts";
import { loadToolExtensions } from "./tools/extensions.ts";
import { createCoreTools } from "./tools/index.ts";
import { connectMcpServers } from "./tools/mcp-client.ts";
import type { ToolDefinition } from "./tools/registry.ts";

export { SessionStore } from "./session/store.ts";
export { defineTool, Type } from "./tools/extensions.ts";
export { registerMcpTools } from "./tools/mcp.ts";
export type { ExtensionAPI, ToolDefinition } from "./tools/extensions.ts";
export type { McpTool, McpToolClient, McpToolResult } from "./tools/mcp.ts";
export type { McpServerConfig } from "./tools/mcp-client.ts";
export type { StreamReply } from "./agent/messages.ts";
export type { ChatEvent } from "./session/chat-session.ts";

export interface CreateAgentSessionOptions extends Omit<ChatSessionOptions, "tools"> {
	cwd: string;
	store: SessionStore;
	customTools?: readonly ToolDefinition[];
	extensionPaths?: readonly string[];
	activeTools?: readonly string[];
	mcpServers?: Readonly<Record<string, unknown>>;
	onMcpWarning?: (message: string) => void;
	signal?: AbortSignal;
}

export async function createAgentSession(options: CreateAgentSessionOptions): Promise<{ session: ChatSession; dispose: () => Promise<void> }> {
	const {
		cwd: directory, store, customTools = [], extensionPaths = [], activeTools, mcpServers = {},
		onMcpWarning = (message) => process.emitWarning(message), signal, ...sessionOptions
	} = options;
	const cwd = resolve(directory);
	const tools = createCoreTools(cwd);
	await loadToolExtensions(tools, cwd, extensionPaths);
	for (const tool of customTools) tools.register(tool, { type: "sdk" });
	const dispose = await connectMcpServers(tools, cwd, mcpServers, onMcpWarning, signal);
	try {
		signal?.throwIfAborted();
		if (activeTools) tools.setActiveTools(activeTools);
		return { session: new ChatSession(store, { ...sessionOptions, tools }), dispose };
	} catch (error) {
		await dispose();
		throw error;
	}
}
