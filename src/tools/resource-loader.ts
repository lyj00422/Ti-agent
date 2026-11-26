import { resolve } from "node:path";
import { createCoreTools } from "./index.ts";
import { loadExtensions } from "./extensions.ts";
import { connectMcpServers } from "./mcp-client.ts";
import { ToolRegistry } from "./registry.ts";
import type { ToolDefinition } from "./registry.ts";
import type { ModelRegistrationAPI } from "../providers/types.ts";
import type { ToolApprovalHandler } from "./permissions.ts";

export interface AgentResourceLoadOptions {
	cwd: string;
	customTools?: readonly ToolDefinition[];
	extensionPaths?: readonly string[];
	activeTools?: readonly string[];
	mcpServers?: Readonly<Record<string, unknown>>;
	signal?: AbortSignal;
	onMcpWarning?: (message: string) => void;
	modelRegistry?: ModelRegistrationAPI;
	permissionMode?: "ask" | "allow";
	requestApproval?: ToolApprovalHandler;
}

export interface LoadedAgentResources {
	tools: ToolRegistry;
	dispose: () => Promise<void>;
}

export interface AgentResourceLoader {
	load(options: AgentResourceLoadOptions): Promise<LoadedAgentResources>;
}

/** Loads agent tools and binds local extensions to the session's registries. */
export class DefaultAgentResourceLoader implements AgentResourceLoader {
	async load(options: AgentResourceLoadOptions): Promise<LoadedAgentResources> {
		const cwd = resolve(options.cwd);
		const tools = createCoreTools(cwd, {
			permissionMode: options.permissionMode,
			requestApproval: options.requestApproval,
		});
		await loadExtensions(tools, cwd, options.extensionPaths ?? [], options.modelRegistry);
		for (const tool of options.customTools ?? []) tools.register(tool, { type: "sdk" });
		const dispose = await connectMcpServers(
			tools,
			cwd,
			options.mcpServers ?? {},
			options.onMcpWarning ?? ((message) => process.emitWarning(message)),
			options.signal,
		);
		try {
			options.signal?.throwIfAborted();
			if (options.activeTools) tools.setActiveTools(options.activeTools);
			return { tools, dispose };
		} catch (error) {
			await dispose();
			throw error;
		}
	}
}
