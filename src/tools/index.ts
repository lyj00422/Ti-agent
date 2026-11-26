import { createBashToolDefinition } from "./shell/bash.ts";
import { createEditToolDefinition } from "./files/edit.ts";
import { createFindToolDefinition } from "./search/find.ts";
import { createGrepToolDefinition } from "./search/grep.ts";
import { createLsToolDefinition } from "./files/ls.ts";
import { createPowerShellToolDefinition } from "./shell/powershell.ts";
import { createReadToolDefinition } from "./files/read.ts";
import { createWriteToolDefinition } from "./files/write.ts";
import { createCodemodeToolDefinition } from "./codemode.ts";
import { ToolRegistry } from "./registry.ts";
import type { ToolRegistryOptions } from "./registry.ts";

export function createCoreTools(cwd: string, options: ToolRegistryOptions = {}): ToolRegistry {
	const registry = new ToolRegistry(cwd, options);
	registry.register(createReadToolDefinition(cwd));
	registry.register(createBashToolDefinition(cwd));
	if (process.platform === "win32") registry.register(createPowerShellToolDefinition(cwd));
	registry.register(createEditToolDefinition(cwd));
	registry.register(createWriteToolDefinition(cwd));
	registry.register(createGrepToolDefinition(cwd));
	registry.register(createFindToolDefinition(cwd));
	registry.register(createLsToolDefinition(cwd));
	registry.register(createCodemodeToolDefinition());
	return registry;
}
