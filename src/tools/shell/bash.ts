import { getShellConfig } from "./process.ts";
import { createLocalShellOperations, createShellToolDefinition } from "./shell-tool.ts";
import { createWslBashOperations } from "./wsl-bash.ts";

export function createBashToolDefinition(cwd: string) {
	const operations = process.platform === "win32"
		? createWslBashOperations()
		: createLocalShellOperations("bash", getShellConfig);
	return createShellToolDefinition(cwd, {
		name: "bash",
		label: "bash",
		shellName: "bash",
		promptSnippet: "Execute Bash commands",
		tempFilePrefix: "ti-bash",
	}, operations);
}
