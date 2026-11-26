import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TSchema } from "typebox";
import { errorMessage } from "../agent/messages.ts";
import type { ModelProvider, ModelRegistrationAPI, ProviderConfig } from "../providers/types.ts";
import type { ToolDefinition, ToolHook, ToolHookName, ToolInfo, ToolRegistry } from "./registry.ts";

export { Type } from "typebox";
export type { ToolCallEvent, ToolContext, ToolDefinition, ToolResult, ToolResultEvent } from "./registry.ts";

export interface ExtensionAPI extends ModelRegistrationAPI {
	registerTool<Schema extends TSchema, Details>(tool: ToolDefinition<Schema, Details>): void;
	getAllTools(): ToolInfo[];
	getActiveTools(): string[];
	setActiveTools(names: readonly string[]): void;
	on<Name extends ToolHookName>(type: Name, handler: ToolHook<Name>): void;
}

export function defineTool<Schema extends TSchema, Details>(tool: ToolDefinition<Schema, Details>): ToolDefinition<Schema, Details> {
	return tool;
}

export async function loadExtensions(registry: ToolRegistry, cwd: string, paths: readonly string[], models?: ModelRegistrationAPI): Promise<void> {
	const loaded = new Set<string>();
	for (const input of paths) {
		const resolved = resolve(cwd, input);
		try {
			const path = await realpath(resolved);
			if (loaded.has(path)) continue;
			const extension = await import(pathToFileURL(path).href);
			if (typeof extension.default !== "function") throw new Error("扩展必须默认导出一个初始化函数。");
			const registerProvider = (providerOrName: ModelProvider | string, config?: ProviderConfig) => {
				if (!models) throw new Error("当前扩展运行时未连接模型注册表。");
				if (typeof providerOrName === "string") {
					if (!config) throw new Error(`供应商 ${providerOrName} 缺少配置。`);
					models.registerProvider(providerOrName, config);
				} else {
					models.registerProvider(providerOrName);
				}
			};
			const api: ExtensionAPI = {
				registerTool: (tool) => registry.register(tool, { type: "extension", path }),
				registerProvider,
				unregisterProvider: (name) => {
					if (!models) throw new Error("当前扩展运行时未连接模型注册表。");
					models.unregisterProvider(name);
				},
				getAllTools: () => registry.getAllTools(),
				getActiveTools: () => registry.getActiveTools(),
				setActiveTools: (names) => registry.setActiveTools(names),
				on: (type, handler) => registry.on(type, handler),
			};
			await extension.default(api);
			loaded.add(path);
		} catch (error) {
			throw new Error(`无法加载扩展 ${resolved}。 ${errorMessage(error)}`, { cause: error });
		}
	}
}
