import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { messageText } from "../src/agent/messages.ts";
import type { AssistantMessage, ToolCall } from "../src/agent/messages.ts";
import { createAgentSession, defineTool, registerMcpTools, SessionStore, Type } from "../src/sdk.ts";
import type { AgentSessionEvent, McpToolClient } from "../src/sdk.ts";
import type { AgentResourceLoader } from "../src/sdk.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

function fixture(t: TestContext) {
	const cwd = mkdtempSync(join(tmpdir(), "ti extensions "));
	const home = join(cwd, "data");
	t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
	return { cwd, home, store: new SessionStore(home, [], cwd), contextWindow: 100_000 };
}

function call(name: string, args: Record<string, unknown> = {}, id = name): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

function toolReply(...calls: ToolCall[]): AssistantMessage {
	return { role: "assistant", stopReason: "toolUse", content: calls, timestamp: Date.now() };
}

function finalReply(text: string): AssistantMessage {
	return { role: "assistant", stopReason: "stop", content: [{ type: "text", text }], timestamp: Date.now() };
}

test("the CLI loads Pi's hello example, advertises the schema and persists its result", (t) => {
	const { cwd, home, store } = fixture(t);
	const preload = async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body));
		const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name);
		const schema = body.tools[0].function.parameters;
		if (names.join(",") !== "hello" || schema.properties.name.type !== "string" || schema.required[0] !== "name") {
			return new Response("Unexpected tool schema", { status: 400 });
		}
		const last = body.messages.at(-1);
		const choice = last.role === "user"
			? { delta: { tool_calls: [{ index: 0, id: "cli-hello",
				function: { name: "hello", arguments: JSON.stringify({ name: "Ti" }) } }] }, finish_reason: "tool_calls" }
			: { delta: { content: `Received ${last.tool_call_id}: ${last.content}` }, finish_reason: "stop" };
		return new Response("data: " + JSON.stringify({ choices: [choice] }) + "\n\ndata: [DONE]\n\n");
	};
	const importUrl = "data:text/javascript;base64," + Buffer.from("globalThis.fetch = " + preload.toString()).toString("base64");
	const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
	const extension = fileURLToPath(new URL("../examples/extensions/hello.ts", import.meta.url));
	const child = spawnSync(process.execPath, ["--import", importUrl, main, "-e", extension, "--tools", "hello"], {
		cwd, input: "Use hello\n/exit\n", encoding: "utf8", timeout: 15_000,
		env: { ...process.env, TI_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "fake", TI_HOME: join(cwd, "auth"), TI_SESSION_HOME: home, TI_LEGACY_HOME: "" },
	});
	assert.ifError(child.error);
	assert.equal(child.status, 0, child.stderr);
	assert.match(child.stdout, /hello · 完成\r?\nTi> Received cli-hello: Hello, Ti!/);
	const result = store.list()[0].history.find((entry) => entry.role === "toolResult");
	assert.equal(result?.toolCallId, "cli-hello");
	assert.deepEqual(result?.details, { greeted: "Ti" });

	const bad = spawnSync(process.execPath, [main, "--extension", "missing.mjs"], {
		cwd, input: "", encoding: "utf8", timeout: 10_000,
	});
	assert.ifError(bad.error);
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /无法加载扩展 .*missing\.mjs/);
});

test("extensions share a tool snapshot within a batch and hooks guard and update tool execution", async (t) => {
	const options = fixture(t);
	const { cwd, store } = options;
	writeFileSync(join(cwd, "first extension.mjs"), `
const text = (text) => ({ type: "text", text });
const read = (description, execute) => ({
  name: "read", label: "Read", description, promptGuidelines: [description + " guideline"],
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  execute,
});
export default (pi) => {
  pi.registerTool(read("original", async (_id, { path }, _signal, update, context) => {
    if (path === "first!") {
      update({ content: [text("working")] });
      pi.registerTool(read("replacement", async (_id, { path }) => ({ content: [text("new " + path)] })));
      pi.setActiveTools(["read"]);
    }
    return { content: [text("old " + path)], details: { cwd: context.cwd }, structuredContent: { path } };
  }));
  pi.on("tool_call", (event) => {
    if (event.toolName === "write") return { block: true, reason: "fixture blocked write" };
    event.input.path = event.input.path === "invalid" ? 123 : event.input.path + "!";
  });
  pi.on("tool_result", (event) => {
    if (event.input.path === "first!") {
      return { content: [...event.content, text(" verified")], details: event.details, structuredContent: event.structuredContent };
    }
  });
};`);
	writeFileSync(join(cwd, "second.mjs"), `
export default (pi) => pi.registerTool({
  name: "read", label: "Read", description: "ignored", parameters: { type: "object" },
  async execute() { throw new Error("Wrong extension executed"); },
});`);
	const events: AgentSessionEvent[] = [];
	let requests = 0;
	const { session } = await createAgentSession({
		...options, extensionPaths: ["first extension.mjs", "second.mjs"], activeTools: ["read", "write"],
		systemPrompt: "Test tools",
		stream: async (messages, { tools }) => {
			if (++requests === 1) {
				assert.deepEqual(tools?.map(({ name }) => name), ["read", "write"]);
				assert.equal(tools?.[0].description, "original");
				assert.match(messageText(messages[0]), /original guideline/);
				return toolReply(
					call("read", { path: "first" }, "read-1"), call("read", { path: "second" }, "read-2"),
					call("write", { path: "blocked.txt", content: "no" }),
				);
			}
			assert.deepEqual(tools?.map(({ name }) => name), ["read"]);
			assert.equal(tools?.[0].description, "replacement");
			assert.doesNotMatch(messageText(messages[0]), /original guideline/);
			assert.match(messageText(messages[0]), /replacement guideline/);
			if (requests === 2) {
				assert.deepEqual(messages.slice(-3).map(messageText), ["old first! verified", "old second!", "fixture blocked write"]);
				return toolReply(
					call("read", { path: "third" }, "read-3"), call("read", { path: "invalid" }, "read-4"),
					call("write", { path: "inactive.txt", content: "no" }, "inactive-write"),
				);
			}
			assert.equal(messageText(messages.at(-3)!), "new third!");
			assert.match(messageText(messages.at(-2)!), /工具参数无效/);
			assert.match(messageText(messages.at(-1)!), /该请求未注册工具 write/);
			return finalReply("finished");
		},
	});
	assert.equal(session.tools?.getAllTools().find(({ name }) => name === "read")?.source.type, "extension");
	assert.equal(messageText(await session.prompt("Check the loadout", (event) => events.push(event))), "finished");
	assert.equal(requests, 3);
	assert.equal(existsSync(join(cwd, "blocked.txt")), false);
	assert.equal(existsSync(join(cwd, "inactive.txt")), false);
	const update = events.find((event) => event.type === "tool_execution_update");
	assert.equal(update?.call.id, "read-1");
	assert.deepEqual(update?.partialResult.content, [{ type: "text", text: "working" }]);
	const history = store.list()[0].history;
	const original = history.find((entry) => entry.role === "assistant" && entry.stopReason === "toolUse");
	assert.equal(original?.content[0]?.type === "toolCall" && original.content[0].arguments.path, "first");
	const saved = history.find((entry) => entry.role === "toolResult" && entry.toolCallId === "read-1");
	assert.ok(saved?.role === "toolResult");
	assert.deepEqual(saved.details, { cwd });
	assert.deepEqual(saved.structuredContent, { path: "first!" });
});

test("an SDK caller injects a typed tool and chooses its initial exposure", async (t) => {
	const options = fixture(t);
	const length = defineTool({
		name: "length", label: "Length", description: "Count characters", defaultActive: false,
		parameters: Type.Object({ value: Type.String() }),
		async execute(_id, { value }) {
			return { content: [{ type: "text", text: String(value.length) }] };
		},
	});
	let requests = 0;
	const { session } = await createAgentSession({
		...options, customTools: [length],
		stream: async (messages, { tools }) => {
			assert.deepEqual(tools?.map(({ name }) => name), ["length"]);
			if (++requests === 1) return toolReply(call("length", { value: "Ti" }));
			return finalReply(messageText(messages.at(-1)!));
		},
	});
	assert.equal(session.tools?.getAllTools().find((tool) => tool.name === "length")?.source.type, "sdk");
	assert.ok(!session.tools?.getActiveTools().includes("length"));
	session.tools?.setActiveTools(["length"]);
	assert.equal(messageText(await session.prompt("Count it", () => {})), "2");
});

test("the CLI logs in to an extension provider, switches to it and restores it on restart", (t) => {
	const { cwd, home } = fixture(t);
	writeFileSync(join(cwd, "provider.mjs"), `
export default (ti) => ti.registerProvider({
  id: "extension-acme",
  name: "Extension Acme",
  models: [{ id: "chat", contextWindow: 32000, maxTokens: 4000 }],
  async stream(model, messages, options) {
    if (options.resolveApiKey() !== "extension-key") throw new Error("Wrong API key");
    const prompt = messages.at(-1).content[0].text;
    const text = model.id + " received " + prompt;
    options.onEvent({ type: "text_delta", text });
    return {
      role: "assistant", stopReason: "stop", timestamp: Date.now(),
      content: [{ type: "text", text }],
    };
  },
});`);
	const modelsPath = join(cwd, "models.json");
	writeFileSync(modelsPath, "{}");
	const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
	const run = (input: string) => {
		const result = spawnSync(process.execPath, [main, "-e", "provider.mjs"], {
			cwd, input, encoding: "utf8", timeout: 15_000,
			env: { ...process.env, TI_HOME: home, TI_SESSION_HOME: home, TI_MODELS_FILE: modelsPath, TI_PROVIDER: "", TI_MODEL: "" },
		});
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
		assert.doesNotMatch(result.stdout, /请求失败|extension-key/);
		return result.stdout;
	};
	const first = run("/login extension-acme\nextension-key\n/model extension-acme/chat\nhello\n/exit\n");
	assert.match(first, /当前模型：extension-acme\/chat/);
	assert.match(first, /Ti> chat received hello/);
	const restored = run("again\n/exit\n");
	assert.match(restored, /^Ti · extension-acme\/chat/);
	assert.match(restored, /Ti> chat received again/);
});

test("the SDK accepts a replaceable resource loader and disposes its resources", async (t) => {
	const options = fixture(t);
	let disposed = false;
	let loadedCwd = "";
	const resourceLoader: AgentResourceLoader = {
		async load({ cwd }) {
			loadedCwd = cwd;
			return { tools: new ToolRegistry(cwd), dispose: async () => { disposed = true; } };
		},
	};
	const runtime = await createAgentSession({
		...options, resourceLoader,
		stream: async () => finalReply("ready"),
	});
	assert.equal(loadedCwd, options.cwd);
	assert.equal(runtime.agent, runtime.session.runtime);
	await runtime.dispose();
	assert.equal(disposed, true);
});

test("MCP tools register from an in-memory client and forward calls and cancellation", async (t) => {
	const options = fixture(t);
	const { promise: started, resolve: markStarted } = Promise.withResolvers<AbortSignal>();
	const image = { type: "image", mimeType: "image/png", data: "cGl4ZWw=" } as const;
	const calls: string[] = [];
	const client: McpToolClient = {
		async listTools() {
			return [
				{ name: "status-now", inputSchema: {
					properties: { detail: { $ref: "#/$defs/detail" } }, required: ["detail"],
					$defs: { detail: { type: "string" } },
				} },
				{ name: "status_now", inputSchema: { type: "object" } },
				{ name: "a".repeat(80), inputSchema: {} },
				{ name: "cancel", inputSchema: {} },
			];
		},
		async callTool(name, args, { signal }) {
			calls.push(name);
			if (name === "status-now") {
				assert.deepEqual(args, { detail: "yes" });
				return { content: [{ type: "text", text: "fixture error" }, image], structuredContent: { status: 7 }, isError: true };
			}
			assert.equal(name, "cancel");
			assert.ok(signal);
			markStarted(signal);
			await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
			throw new Error("Cancelled call resolved unexpectedly");
		},
	};
	let selected = "";
	let requests = 0;
	const { session } = await createAgentSession({
		...options,
		stream: async (messages, { tools }) => {
			assert.deepEqual(tools?.map((tool) => tool.name), [selected]);
			assert.equal((tools?.[0].parameters as { type: string }).type, "object");
			if (++requests === 1) return toolReply(call(selected, { detail: "yes" }));
			assert.deepEqual(messages.at(-1)?.content, [{ type: "text", text: "fixture error" }, image]);
			return finalReply("handled");
		},
	});
	assert.ok(session.tools);
	const registry = session.tools;
	await registerMcpTools(registry, "test-server", client);
	const names = registry.getAllTools().filter(({ source }) => source.type === "mcp").map(({ name }) => name);
	const [first, second, long, cancel] = names;
	assert.match(first, /^mcp__test_server__status_now_[0-9a-f]{8}$/);
	assert.match(second, /^mcp__test_server__status_now_[0-9a-f]{8}$/);
	assert.notEqual(first, second);
	assert.equal(long.length, 64);
	await assert.rejects(registerMcpTools(registry, "test_server", client), /MCP 服务名重复/);
	selected = first;
	registry.setActiveTools([first]);
	const controller = new AbortController();
	await assert.rejects(registry.execute(call(first, { detail: 1 }), controller.signal), /工具参数无效/);
	assert.equal(messageText(await session.prompt("Call MCP", () => {})), "handled");
	const saved = options.store.list()[0].history.find((entry) => entry.role === "toolResult");
	assert.equal(saved?.isError, true);
	assert.deepEqual(saved?.structuredContent, { status: 7 });
	registry.setActiveTools([cancel]);
	const cancelled = assert.rejects(registry.execute(call(cancel), controller.signal), { name: "AbortError" });
	assert.equal(await started, controller.signal);
	controller.abort();
	await cancelled;
	assert.deepEqual(calls, ["status-now", "cancel"]);
});
