import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TSchema } from "typebox";
import { errorMessage } from "../agent/messages.ts";
import type { ToolDefinition, ToolHook, ToolHookName, ToolInfo, ToolRegistry } from "./registry.ts";

export { Type } from "typebox";
export type { ToolCallEvent, ToolContext, ToolDefinition, ToolResult, ToolResultEvent } from "./registry.ts";

export interface ExtensionAPI {
	registerTool<Schema extends TSchema, Details>(tool: ToolDefinition<Schema, Details>): void;
	getAllTools(): ToolInfo[];
	getActiveTools(): string[];
	setActiveTools(names: readonly string[]): void;
	on<Name extends ToolHookName>(type: Name, handler: ToolHook<Name>): void;
}

export function defineTool<Schema extends TSchema, Details>(tool: ToolDefinition<Schema, Details>): ToolDefinition<Schema, Details> {
	return tool;
}

export async function loadToolExtensions(registry: ToolRegistry, cwd: string, paths: readonly string[]): Promise<void> {
	const loaded = new Set<string>();
	for (const input of paths) {
		const resolved = resolve(cwd, input);
		try {
			const path = await realpath(resolved);
			if (loaded.has(path)) continue;
			const extension = await import(pathToFileURL(path).href);
			if (typeof extension.default !== "function") throw new Error("扩展必须默认导出一个初始化函数。");
			const api: ExtensionAPI = {
				registerTool: (tool) => registry.register(tool, { type: "extension", path }),
				getAllTools: () => registry.getAllTools(),
				getActiveTools: () => registry.getActiveTools(),
				setActiveTools: (names) => registry.setActiveTools(names),
				on: (type, handler) => registry.on(type, handler),
			};
			await extension.default(api);
			loaded.add(path);
		} catch (error) {
			throw new Error(`无法加载工具扩展 ${resolved}。 ${errorMessage(error)}`, { cause: error });
		}
	}
}
