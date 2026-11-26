import { AgentSession } from "./session/agent-session.ts";
import type { Agent } from "./agent/agent.ts";
import type { AgentSessionOptions } from "./session/agent-session.ts";
import type { SessionRepository } from "./session/store.ts";
import { DefaultAgentResourceLoader } from "./tools/resource-loader.ts";
import type { AgentResourceLoader } from "./tools/resource-loader.ts";
import type { ToolDefinition } from "./tools/registry.ts";
import type { ModelRegistrationAPI } from "./providers/types.ts";

export { SessionStore } from "./session/store.ts";
export { Agent } from "./agent/agent.ts";
export { defineTool, Type } from "./tools/extensions.ts";
export { registerMcpTools } from "./tools/mcp.ts";
export { createModelRuntime } from "./providers/model-runtime.ts";
export type { ExtensionAPI, ToolDefinition } from "./tools/extensions.ts";
export type { McpTool, McpToolClient, McpToolResult } from "./tools/mcp.ts";
export type { McpServerConfig } from "./tools/mcp-client.ts";
export type { AgentResourceLoader, AgentResourceLoadOptions, LoadedAgentResources } from "./tools/resource-loader.ts";
export type { AgentSessionEvent } from "./session/agent-session.ts";
export type { SessionRepository } from "./session/store.ts";
export type { ModelRuntime, ModelRuntimeOptions } from "./providers/model-runtime.ts";
export type { ModelDefinition, ModelDescriptor, ModelProvider, ModelRegistrationAPI, ModelStream, ProviderConfig, ProviderStream } from "./providers/types.ts";

export interface CreateAgentSessionOptions extends Omit<AgentSessionOptions, "tools"> {
	cwd: string;
	store: SessionRepository;
	customTools?: readonly ToolDefinition[];
	extensionPaths?: readonly string[];
	activeTools?: readonly string[];
	mcpServers?: Readonly<Record<string, unknown>>;
	onMcpWarning?: (message: string) => void;
	resourceLoader?: AgentResourceLoader;
	modelRegistry?: ModelRegistrationAPI;
	signal?: AbortSignal;
}

export async function createAgentSession(options: CreateAgentSessionOptions): Promise<{ agent: Agent; session: AgentSession; dispose: () => Promise<void> }> {
	const {
		cwd: directory, store, customTools = [], extensionPaths = [], activeTools, mcpServers = {},
		onMcpWarning, resourceLoader = new DefaultAgentResourceLoader(), modelRegistry, signal, ...sessionOptions
	} = options;
	const resources = await resourceLoader.load({
		cwd: directory, customTools, extensionPaths, activeTools, mcpServers, onMcpWarning, modelRegistry, signal,
	});
	try {
		const session = new AgentSession(store, { ...sessionOptions, tools: resources.tools });
		return { agent: session.runtime, session, dispose: resources.dispose };
	} catch (error) {
		await resources.dispose();
		throw error;
	}
}
