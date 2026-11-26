import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { connectMcpServers, mcpExposure, readMcpConfig, readMcpServers, validateMcpServerConfig } from "./mcp-client.ts";
import { ToolRegistry } from "./registry.ts";

const usage = [
	"ti mcp add <name> --url <url> [--header NAME=VALUE] [--exposure deferred|direct|hidden]",
	"ti mcp add <name> [--cwd <path>] [--env NAME=VALUE] [--exposure deferred|direct|hidden] -- <command> [args...]",
	"ti mcp list",
	"ti mcp remove <name>",
].join("\n");

function parsePairs(entries: readonly string[] | undefined, flag: string): Record<string, string> {
	return Object.fromEntries((entries ?? []).map((entry) => {
		const separator = entry.indexOf("=");
		if (separator <= 0 || /\s/.test(entry.slice(0, separator))) throw new Error(`${flag} 需要 NAME=VALUE。`);
		return [entry.slice(0, separator), entry.slice(separator + 1)];
	}));
}

async function updateConfig(path: string, update: (servers: Record<string, unknown>) => void): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const lockPath = path + ".lock";
	const lock = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "EEXIST") throw new Error(`MCP 配置正在编辑，锁文件在 ${lockPath}。`);
		throw error;
	});
	try {
		const config = await readMcpConfig(path, true);
		update(config.mcpServers);
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
			await rename(temporary, path);
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
	} finally {
		await lock.close();
		await unlink(lockPath);
	}
}

export async function runMcpCommand(args: string[], path: string, cwd: string, signal: AbortSignal): Promise<number> {
	const [action, ...rest] = args;
	if (action === "--help" || action === "-h") {
		process.stdout.write(usage + "\n");
		return 0;
	}
	if (action === "list" && rest.length === 0) {
		const servers = await readMcpServers(path, true);
		const registry = new ToolRegistry(cwd);
		let failed = false;
		const dispose = await connectMcpServers(registry, cwd, servers, (message) => {
			failed = true;
			process.stderr.write(message + "\n");
		}, signal, (name, status, exposure) => {
			process.stdout.write(`${name} · ${status === "connected" ? "已连接" : "已停用"} · ${exposure}\n`);
			if (status === "connected") {
				for (const tool of registry.getAllTools()) {
					if (tool.source.type === "mcp" && tool.source.server === name) {
						process.stdout.write(`  ${tool.name} · ${tool.exposure}\n`);
					}
				}
			}
		});
		await dispose();
		if (Object.keys(servers).length === 0) process.stdout.write("尚未配置 MCP 服务。\n");
		return failed ? 1 : 0;
	}
	if (action === "remove" && rest.length === 1) {
		const [name] = rest;
		await updateConfig(path, (servers) => {
			if (!Object.hasOwn(servers, name)) throw new Error("未配置 MCP 服务 " + name);
			delete servers[name];
		});
		process.stdout.write(`已移除 MCP 服务 ${name}\n`);
		return 0;
	}
	if (action !== "add") throw new Error(usage);

	const separator = rest.indexOf("--");
	const launch = separator < 0 ? [] : rest.slice(separator + 1);
	const { values, positionals } = parseArgs({
		args: separator < 0 ? rest : rest.slice(0, separator),
		allowPositionals: true,
		options: {
			url: { type: "string" }, header: { type: "string", multiple: true },
			cwd: { type: "string" }, env: { type: "string", multiple: true }, exposure: { type: "string" },
		},
	});
	if (positionals.length !== 1 || (separator < 0 ? values.url === undefined : !launch[0] || values.url !== undefined)) {
		throw new Error(usage);
	}
	const [name] = positionals;
	const exposure = mcpExposure(values.exposure);
	let config: Record<string, unknown>;
	if (values.url !== undefined) {
		if (values.cwd !== undefined || values.env) throw new Error("--cwd 和 --env 用于 stdio 服务。");
		config = { url: values.url, ...(values.header ? { headers: parsePairs(values.header, "--header") } : {}) };
	} else {
		if (values.header) throw new Error("--header 用于 HTTP 服务。");
		const [command, ...commandArgs] = launch;
		config = { command, args: commandArgs, cwd: values.cwd, ...(values.env ? { env: parsePairs(values.env, "--env") } : {}) };
	}
	if (values.exposure !== undefined) config.exposure = exposure;
	validateMcpServerConfig(name, config);
	signal.throwIfAborted();
	await updateConfig(path, (servers) => {
		const namespace = name.replaceAll("-", "_");
		if (Object.keys(servers).some((other) => other !== name && other.replaceAll("-", "_") === namespace)) {
			throw new Error("MCP 服务名重复 " + name);
		}
		Object.defineProperty(servers, name, { value: config, enumerable: true, writable: true, configurable: true });
	});
	process.stdout.write(`已保存 MCP 服务 ${name} 到 ${path}\n`);
	return 0;
}
