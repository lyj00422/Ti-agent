import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgentSession, registerMcpTools, SessionStore } from "../src/sdk.ts";
import { messageText } from "../src/agent/messages.ts";
import type { AssistantMessage, ToolCall } from "../src/agent/messages.ts";
import type { ModelStream } from "../src/providers/types.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const stdioFixture = fileURLToPath(new URL("./mcp-stdio-fixture.ts", import.meta.url));
const echoSchema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };

function fixture(t: TestContext) {
	const cwd = mkdtempSync(join(tmpdir(), "ti mcp "));
	const home = join(cwd, "profile");
	const data = join(cwd, "data");
	mkdirSync(home);
	t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
	return { cwd, home, store: new SessionStore(data, [], cwd),
		env: { ...process.env, TI_HOME: home, TI_SESSION_HOME: data, TI_LEGACY_HOME: "", TI_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "mock",
			TI_FIXTURE_SECRET: "fixture-value" } };
}

type Fixture = ReturnType<typeof fixture>;

function cli({ cwd, env }: Fixture, args: string[], input = "", toolName?: string, discover = false) {
	const loadMock = (name: string, discover: boolean) => {
		const fetchMcp = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			if (String(input) !== "https://api.deepseek.com/chat/completions") return fetchMcp(input, init);
			const body = JSON.parse(String(init?.body));
			const tools = body.tools?.map((tool: { function: { name: string; parameters: unknown } }) => tool.function) ?? [];
			const names = tools.map((tool: { name: string }) => tool.name);
			const last = body.messages.at(-1);
			const toolResponse = (name: string, id: string, args: object) => ({
				delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls",
			});
			const searching = discover && last.role === "user";
			const schema = tools.find((tool: { name: string }) => tool.name === name)?.parameters;
			if (searching ? !names.includes("tool_search") || names.includes(name)
				: (!discover && names.join(",") !== name) || schema?.required?.join(",") !== "text" || schema.properties.text.type !== "string") {
				return new Response("Unexpected MCP tools", { status: 400 });
			}
			const choice = searching ? toolResponse("tool_search", "find-echo", { query: name })
				: last.role === "user" || last.tool_call_id === "find-echo" ? toolResponse(name, "echo-call", { text: "hello" })
				: { delta: { content: last.tool_call_id + " " + last.content }, finish_reason: "stop" };
			return new Response("data: " + JSON.stringify({ choices: [choice] }) + "\n\ndata: [DONE]\n\n");
		};
	};
	const preload = toolName ? ["--import", "data:text/javascript;base64," +
		Buffer.from(`(${loadMock.toString()})(${JSON.stringify(toolName)}, ${discover})`).toString("base64")] : [];
	return new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve, reject) => {
		const child = execFile(process.execPath, [...preload, main, ...args], { cwd, env, timeout: 12_000 }, (error, stdout, stderr) => {
			if (error?.killed) reject(error);
			else resolve({ code: error?.code ?? 0, stdout, stderr });
		});
		child.stdin?.end(input);
	});
}

async function listen(t: TestContext, handle: (request: IncomingMessage, response: ServerResponse) => void) {
	const server = createServer(handle);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
		server.closeAllConnections();
	}));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return `http://127.0.0.1:${address.port}/mcp`;
}

function saveConfig(file: string, mcpServers: Record<string, unknown>) {
	writeFileSync(file, JSON.stringify({ mcpServers }));
}

test("CLI starts a stdio server from its default config and cleans it up on exit", async (t) => {
	const options = fixture(t);
	const serverCwd = join(options.cwd, "server workspace");
	mkdirSync(serverCwd);
	saveConfig(join(options.home, "mcp.json"), {
		"bad-entry": { url: "not an http URL" },
		"missing-executable": { command: join(serverCwd, "does-not-exist"), timeout: 1 },
		disabled: { command: "disabled-must-not-start", enabled: false },
		local: { command: process.execPath, args: [stdioFixture], cwd: "server workspace",
			env: { TI_FIXTURE_PREFIX: "${TI_FIXTURE_SECRET}:" }, timeout: 3 },
	});
	const name = "mcp__local__echo";
	const result = await cli(options, ["--tools", name], "Call the tool\n/exit\n", name);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stderr, /bad-entry/);
	assert.match(result.stderr, /missing-executable · 连接失败/);
	assert.doesNotMatch(result.stderr, /disabled|fixture-value/);
	assert.match(result.stdout, /echo-call fixture-value:hello/);
	const message = options.store.list()[0].history.find((entry) => entry.role === "toolResult");
	assert.equal(message?.toolCallId, "echo-call");
	assert.deepEqual(message?.structuredContent, { transport: "stdio" });
	assert.match(readFileSync(join(serverCwd, "mcp-closed"), "utf8"), /^\d+$/);
});

test("CLI connects to Streamable HTTP, discovers multiple pages and closes the authenticated session", async (t) => {
	const options = fixture(t);
	const requests: { method: string; authorization?: string; session?: string; cursor?: string }[] = [];
	const url = await listen(t, (request, response) => {
		const record = { method: request.method ?? "", authorization: request.headers.authorization,
			session: String(request.headers["mcp-session-id"] ?? "") };
		if (request.method !== "POST") {
			requests.push(record);
			response.writeHead(request.method === "DELETE" ? 204 : 405).end();
			return;
		}
		let body = "";
		request.setEncoding("utf8").on("data", (chunk) => { body += chunk; }).on("end", () => {
			const message = JSON.parse(body);
			requests.push({ ...record, method: message.method, cursor: message.params?.cursor });
			if (message.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			let result: object;
			if (message.method === "initialize") {
				response.setHeader("Mcp-Session-Id", "http-fixture");
				result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "HTTP fixture", version: "1" } };
			} else if (message.method === "tools/list") {
				result = message.params?.cursor === "next"
					? { tools: [{ name: "echo", inputSchema: echoSchema }] }
					: { tools: [{ name: "other", inputSchema: { type: "object" } }], nextCursor: "next" };
			} else {
				result = { content: [], structuredContent: [message.params?.name, message.params?.arguments?.text] };
			}
			const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
			if (message.method === "tools/call") response.writeHead(200, { "Content-Type": "text/event-stream" }).end(`event: message\ndata: ${payload}\n\n`);
			else response.writeHead(200, { "Content-Type": "application/json" }).end(payload);
		});
	});
	saveConfig(join(options.home, "mcp.json"), { "default-should-not-load": {} });
	saveConfig(join(options.cwd, "remote.json"), {
		"missing-env": { url, headers: { Authorization: "Bearer ${TI_FIXTURE_MISSING_ENV}" } },
		remote: { type: "streamable-http", url, headers: { Authorization: "Bearer ${TI_FIXTURE_SECRET}" }, timeout: 3 },
	});
	delete (options.env as NodeJS.ProcessEnv).TI_FIXTURE_MISSING_ENV;
	const name = "mcp__remote__echo";
	const result = await cli(options, ["--mcp-config", "remote.json", "--tools", name], "Call HTTP MCP\n", name);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /echo-call[\s\S]*"echo"[\s\S]*"hello"/);
	assert.match(result.stderr, /missing-env · 配置失败 · 缺少环境变量 TI_FIXTURE_MISSING_ENV/);
	assert.doesNotMatch(result.stderr, /default-should-not-load|fixture-value/);
	assert.deepEqual(requests.filter(({ method }) => method !== "GET").map(({ method }) => method),
		["initialize", "notifications/initialized", "tools/list", "tools/list", "tools/call", "DELETE"]);
	assert.equal(requests.filter(({ method }) => method === "tools/list")[1].cursor, "next");
	assert.ok(requests.every(({ authorization }) => authorization === "Bearer fixture-value"));
	assert.ok(requests.filter(({ method }) => method !== "initialize").every(({ session }) => session === "http-fixture"));
	const message = options.store.list()[0].history.find((entry) => entry.role === "toolResult");
	assert.deepEqual(message?.structuredContent, ["echo", "hello"]);
});

test("bad config files halt startup with the filename", async (t) => {
	const options = fixture(t);
	writeFileSync(join(options.cwd, "bad.json"), "{");
	const invalid = await cli(options, ["--mcp-config", "bad.json"]);
	assert.equal(invalid.code, 1);
	assert.match(invalid.stderr, /bad\.json 不是有效的 JSON/);
	const missing = await cli(options, ["--mcp-config", "missing.json"]);
	assert.equal(missing.code, 1);
	assert.match(missing.stderr, /无法读取 MCP 配置 .*missing\.json/);
	assert.equal(existsSync(join(options.home, "mcp.json")), false);
	assert.equal((await cli(options, [])).code, 0);
});

test("mcp add persists a service for normal CLI startup, list probes it and remove drops it", async (t) => {
	const options = fixture(t);
	const configPath = join(options.home, "mcp.json");
	const closed = join(options.cwd, "mcp-closed");
	const tool = "mcp__fixture__echo";
	const added = await cli(options, ["mcp", "add", "fixture", "--env", "TI_FIXTURE_PREFIX=keep=", "--",
		process.execPath, stdioFixture]);
	assert.equal(added.code, 0, added.stderr);
	assert.equal(existsSync(closed), false);
	const existing = JSON.parse(readFileSync(configPath, "utf8"));
	const remote = await cli(options, ["mcp", "add", "remote", "--url", "https://example.org/mcp",
		"--header", 'Authorization=Bearer ${TOKEN}', "--header", "X-Client=ti", "--exposure", "hidden"]);
	assert.equal(remote.code, 0, remote.stderr);
	const saved = JSON.parse(readFileSync(configPath, "utf8"));
	assert.deepEqual(saved.mcpServers.fixture, existing.mcpServers.fixture);
	assert.deepEqual(saved.mcpServers.remote, {
		url: "https://example.org/mcp", headers: { Authorization: 'Bearer ${TOKEN}', "X-Client": "ti" }, exposure: "hidden",
	});
	assert.equal((await cli(options, ["mcp", "remove", "remote"])).code, 0);
	const listed = await cli(options, ["mcp", "list"]);
	assert.equal(listed.code, 0, listed.stderr);
	assert.match(listed.stdout, /fixture · 已连接 · deferred/);
	assert.match(listed.stdout, /mcp__fixture__echo · deferred/);
	assert.ok(existsSync(closed));

	const chat = await cli(options, [], "Echo through MCP\n/exit\n", tool, true);
	assert.equal(chat.code, 0, chat.stderr);
	assert.match(chat.stdout, /tool_search · 完成/);
	assert.match(chat.stdout, /echo-call keep=hello/);
	assert.equal((await cli(options, ["mcp", "remove", "fixture"])).code, 0);
	assert.match((await cli(options, ["mcp", "list"])).stdout, /尚未配置/);
	assert.match((await cli(options, ["--tools", tool])).stderr, /未注册工具/);
	assert.equal((await cli(options, ["mcp", "remove", "fixture"])).code, 1);
});

test("management keeps a malformed config and reports failing services", async (t) => {
	const options = fixture(t);
	const path = join(options.home, "mcp.json");
	writeFileSync(path, "{");
	assert.equal((await cli(options, ["mcp", "add", "fixture", "--url", "https://example.org/mcp"])).code, 1);
	assert.equal(readFileSync(path, "utf8"), "{");
	writeFileSync(path, JSON.stringify({ other: { keep: true }, mcpServers: {
		missing: { command: join(options.cwd, "absent"), timeout: 1 },
		disabled: { command: "not-run", enabled: false },
	} }));
	const added = await cli(options, ["mcp", "add", "fixture", "--", process.execPath, stdioFixture]);
	assert.equal(added.code, 0, added.stderr);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).other, { keep: true });
	const list = await cli(options, ["mcp", "list"]);
	assert.equal(list.code, 1);
	assert.match(list.stderr, /missing · 连接失败/);
	assert.match(list.stdout, /disabled · 已停用/);
	assert.match(list.stdout, /fixture · 已连接/);
	assert.ok(existsSync(join(options.cwd, "mcp-closed")));
});

test("deferred tools activate on the next request and survive session restore and compaction", { timeout: 15_000 }, async (t) => {
	const { cwd, store } = fixture(t);
	const deferred = "mcp__deferred__echo";
	const direct = "mcp__direct__echo";
	const hidden = "mcp__hidden__echo";
	const server = { command: process.execPath, args: [stdioFixture], env: { TI_FIXTURE_PREFIX: "echo:" } };
	const base = { cwd, store, contextWindow: 50_000, keepRecentTokens: 1 };
	const mcpServers = { deferred: server, direct: { ...server, exposure: "direct" }, hidden: { ...server, exposure: "hidden" } };
	const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id, name, arguments: args });
	const reply = (text: string, calls: ToolCall[] = []): AssistantMessage => ({ role: "assistant", timestamp: Date.now(),
		content: calls.length ? calls : [{ type: "text", text }], stopReason: calls.length ? "toolUse" : "stop" });
	let step = 0;
	const stream: ModelStream = async (messages, { tools }) => {
		if (!tools) return reply("Earlier conversation used echo");
		const names = tools.map(({ name }) => name);
		assert.ok(!names.includes(hidden));
		assert.ok(names.includes(direct));
		assert.ok(names.includes("tool_search"));
		if (step++ === 0) {
			assert.ok(!names.includes(deferred));
			return reply("", [call("find", "tool_search", { query: "echo", limit: 1 }), call("too-early", deferred, { text: "bad" })]);
		}
		assert.ok(names.includes(deferred));
		if (step === 2) {
			assert.match(messageText(messages.at(-2)!), new RegExp(deferred));
			assert.match(messageText(messages.at(-1)!), /未注册工具/);
			return reply("", [call("now", deferred, { text: "ok" })]);
		}
		if (step === 3) assert.equal(messageText(messages.at(-1)!), "echo:ok");
		return reply("done");
	};
	const runtime = await createAgentSession({ ...base, mcpServers, stream });
	try {
		assert.throws(() => runtime.session.tools?.setActiveTools([hidden]), /隐藏/);
		await runtime.session.prompt("find and use echo", () => {});
		await runtime.session.prompt("later turn", () => {});
		await runtime.session.compact(() => {});
		assert.equal(step, 4);
		const stored = store.list()[0];
		assert.equal(stored.compactions.length, 1);
		const search = stored.history.find((entry) => entry.role === "toolResult" && entry.toolCallId === "find");
		assert.ok(search?.role === "toolResult");
		assert.deepEqual(search.details, { loaded: [deferred] });
	} finally {
		await runtime.dispose();
	}

	const resumed = await createAgentSession({ ...base, mcpServers, stream: async (messages, { tools }) => {
		assert.equal(tools?.some(({ name }) => name === deferred), messageText(messages.at(-1)!) !== "fresh");
		return reply("done");
	} });
	try {
		await resumed.session.prompt("restart", () => {});
		const saved = store.list()[0];
		resumed.session.newSession();
		await resumed.session.prompt("fresh", () => {});
		resumed.session.resume(saved);
		await resumed.session.prompt("resume", () => {});
	} finally {
		await resumed.dispose();
	}
	const discovered = store.list().find(({ title }) => title === "find and use echo");
	assert.ok(discovered);
	for (const servers of [
		{ another: server },
		{ another: server, deferred: { ...server, enabled: false } },
		{ another: server, deferred: { ...server, exposure: "hidden" } },
	]) {
		const changed = await createAgentSession({ ...base, mcpServers: servers, stream: async (_messages, { tools }) => {
			assert.ok(tools?.some(({ name }) => name === "tool_search"));
			assert.ok(!tools?.some(({ name }) => name === deferred));
			return reply("done");
		} });
		try {
			changed.session.resume(discovered);
			await changed.session.prompt("check old discoveries", () => {});
		} finally {
			await changed.dispose();
		}
	}
});

test("a 50-tool server adds only ranked matches to the model request", async (t) => {
	const { cwd, store } = fixture(t);
	const called: string[] = [];
	const runtime = await createAgentSession({ cwd, store, contextWindow: 100_000, stream: async (messages, { tools }) => {
		const names = tools?.map(({ name }) => name);
		const last = messages.at(-1)!;
		if (last.role === "user") {
			assert.deepEqual(names, ["tool_search"]);
			return { role: "assistant", stopReason: "toolUse", timestamp: 0,
				content: [{ type: "toolCall", id: "catalog", name: "tool_search", arguments: { query: "page_49" } }] };
		}
		assert.equal(names?.length, 9, "The search tool and at most eight matches should be declared");
		assert.match(messageText(last).split("\n")[1], /mcp__catalog__page_49/);
		assert.ok(names?.includes("mcp__catalog__page_49"));
		return { role: "assistant", stopReason: "stop", timestamp: 0, content: [{ type: "text", text: "done" }] };
	} });
	try {
		const registry = runtime.session.tools;
		assert.ok(registry);
		await registerMcpTools(registry, "catalog", {
			async listTools() {
				return Array.from({ length: 50 }, (_, index) => ({ name: `page_${index}`, inputSchema: echoSchema }));
			},
			async callTool(name) {
				called.push(name);
				return { content: [{ type: "text", text: name }] };
			},
		}, "deferred");
		registry.setActiveTools(["tool_search"]);
		assert.equal(messageText(await runtime.session.prompt("Find page 49", () => {})), "done");
		assert.deepEqual(called, []);
	} finally {
		await runtime.dispose();
	}
});

test("SDK enforces MCP call timeout and cancellation and can dispose twice", { timeout: 8_000 }, async (t) => {
	const options = fixture(t);
	const calls = Promise.withResolvers<void>();
	const cancellation = Promise.withResolvers<void>();
	let cancelledCall: number | string | undefined;
	let hangTimeoutCall = true;
	let deletes = 0;
	const url = await listen(t, (request, response) => {
		if (request.method !== "POST") {
			if (request.method === "DELETE") deletes++;
			response.writeHead(request.method === "DELETE" ? 204 : 405).end();
			return;
		}
		let body = "";
		request.setEncoding("utf8").on("data", (chunk) => { body += chunk; }).on("end", () => {
			const message = JSON.parse(body);
			if (message.id === undefined) {
				if (message.method === "notifications/cancelled" && message.params.requestId === cancelledCall) cancellation.resolve();
				response.writeHead(202).end();
				return;
			}
			if (message.method === "tools/call") {
				if (hangTimeoutCall) hangTimeoutCall = false;
				else {
					cancelledCall = message.id;
					calls.resolve();
				}
				return;
			}
			if (message.method === "initialize") response.setHeader("Mcp-Session-Id", "slow-fixture");
			const result = message.method === "initialize"
				? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "slow fixture", version: "1" } }
				: { tools: [{ name: "echo", inputSchema: echoSchema }] };
			response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
	});
	const runtime = await createAgentSession({ cwd: options.cwd, store: options.store, contextWindow: 100_000,
		mcpServers: { slow: { url, timeout: 0.5, exposure: "direct" } }, stream: async () => { throw new Error("Unexpected model request"); } });
	try {
		const call: ToolCall = { type: "toolCall", id: "slow-call", name: "mcp__slow__echo", arguments: { text: "hello" } };
		assert.ok(runtime.session.tools);
		await assert.rejects(runtime.session.tools.execute(call, new AbortController().signal), { name: "McpTimeoutError" });
		const controller = new AbortController();
		const aborted = assert.rejects(runtime.session.tools.execute(call, controller.signal), { name: "AbortError" });
		await calls.promise;
		controller.abort();
		await aborted;
		await cancellation.promise;
	} finally {
		await Promise.all([runtime.dispose(), runtime.dispose()]);
	}
	assert.equal(deletes, 1);
});
