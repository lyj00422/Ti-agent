import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { messageText } from "../src/agent/messages.ts";
import type { AssistantMessage, ToolCall } from "../src/agent/messages.ts";
import { AgentSession } from "../src/session/agent-session.ts";
import { BUILTIN_MODELS } from "../src/providers/catalog.ts";
import { streamOpenAiCompletions } from "../src/providers/openai-completions.ts";
import { SessionStore } from "../src/session/store.ts";
import { createCoreTools } from "../src/tools/index.ts";
import { findSearchBinary } from "../src/tools/search/binaries.ts";

const deepseek = BUILTIN_MODELS.find((model) => model.provider === "deepseek")!;

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "ti tools "));
	const cwd = join(root, "working space");
	mkdirSync(cwd);
	// WSL can briefly retain a handle on the search directory after the launcher exits.
	t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
	const tools = createCoreTools(cwd, { permissionMode: "allow" });
	const run = (name: string, args: Record<string, unknown>, signal = new AbortController().signal) =>
		tools.execute(call(name, args), signal);
	return { cwd, tools, run, store: new SessionStore(join(root, "data"), [], cwd) };
}

function call(name: string, args: Record<string, unknown>, id = "call_" + name): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

function assistant(text: string, options: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", content: text ? [{ type: "text", text }] : [], timestamp: Date.now(), stopReason: "stop", ...options };
}

function sse(...choices: object[]): Response {
	return new Response(choices.map((choice) => "data: " + JSON.stringify({ choices: [choice] }) + "\n\n").join("")
		+ "data: [DONE]\n\n");
}

test("the core tools declare schemas and read, edit, write, list, search and find workspace files", async (t) => {
	const { cwd, tools, run } = fixture(t);
	assert.deepEqual(tools.declarations().map((tool) => tool.name), [
		"read", "bash", ...(process.platform === "win32" ? ["powershell"] : []), "edit", "write", "grep", "find", "ls",
	]);
	await assert.rejects(run("read", { path: 7 }), /工具参数无效/);
	await assert.rejects(run("unknown", {}), /未注册工具/);
	await run("write", { path: "sub/notes.txt", content: "\uFEFFfirst\r\nsecond\r\nthird\r\n" });
	assert.match(JSON.stringify((await run("read", { path: "sub/notes.txt", offset: 2, limit: 1 })).content), /second.*offset=3/);
	await assert.rejects(run("edit", { path: "sub/notes.txt", edits: [{ oldText: "absent", newText: "new" }] }), /Could not find the exact text/);
	await run("edit", { path: "sub/notes.txt", edits: [{ oldText: "second", newText: "changed" }] });
	assert.equal(readFileSync(join(cwd, "sub/notes.txt"), "utf8"), "\uFEFFfirst\r\nchanged\r\nthird\r\n");
	assert.match(JSON.stringify((await run("ls", {})).content), /sub\//);

	mkdirSync(join(cwd, ".git"));
	writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
	writeFileSync(join(cwd, "ignored.txt"), "changed\n");
	assert.ok(findSearchBinary("rg"), "install ripgrep or set TI_RG_PATH");
	assert.ok(findSearchBinary("fd"), "install fd or set TI_FD_PATH");
	const found = JSON.stringify((await run("find", { pattern: "*.txt" })).content);
	assert.match(found, /sub\/notes\.txt/);
	assert.doesNotMatch(found, /ignored/);
	const matches = JSON.stringify((await run("grep", { pattern: "changed", context: 1 })).content);
	assert.match(matches, /notes\.txt:2: changed/);
	assert.doesNotMatch(matches, /ignored/);
});

test("the shell tools use the workspace and return failure exit codes and timeouts", async (t) => {
	const { cwd, run } = fixture(t);
	const bash = await run("bash", { command: "pwd; printf '%s' 'ok 中文'; exit 7", timeout: 15 });
	assert.equal(bash.isError, true);
	assert.match(JSON.stringify(bash.content), /working space.*ok 中文.*code 7/);
	if (process.platform === "win32") {
		const ps = await run("powershell", { command: "(Get-Location).Path; Write-Output 'ok 中文'; exit 9", timeout: 15 });
		assert.equal(ps.isError, true);
		assert.match(JSON.stringify(ps.content), /working space.*ok 中文.*code 9/);
	}
	await assert.rejects(run("bash", { command: "sleep 30", timeout: 0.5 }), /timed out/);
	assert.equal(basename(cwd), "working space");
});

test("grep uses the installed WSL ripgrep when Windows PATH has no native copy", { skip: process.platform !== "win32" }, async (t) => {
	const { cwd, run } = fixture(t);
	writeFileSync(join(cwd, "a file.txt"), "literal [ok]\n");
	const savedPath = process.env.PATH;
	const savedOverride = process.env.TI_RG_PATH;
	process.env.PATH = "";
	delete process.env.TI_RG_PATH;
	try {
		const result = await run("grep", { path: "a file.txt", literal: true, pattern: "[ok]" });
		assert.match(JSON.stringify(result.content), /a file\.txt:1: literal \[ok\]/);
	} finally {
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
		if (savedOverride !== undefined) process.env.TI_RG_PATH = savedOverride;
	}
});

test("aborting bash stops the Linux or POSIX process group before its child can write", async (t) => {
	const { cwd, run } = fixture(t);
	const controller = new AbortController();
	const command = run("bash", {
		command: "(sleep 2; printf survived > late.txt) &\nprintf ready > started.txt\nwait",
		timeout: 12,
	}, controller.signal);
	const stopped = assert.rejects(command, /Command aborted/);
	try {
		for (let attempt = 0; attempt < 120 && !existsSync(join(cwd, "started.txt")); attempt++) await setTimeout(50);
		assert.ok(existsSync(join(cwd, "started.txt")));
	} finally {
		controller.abort();
		await stopped;
	}
	await setTimeout(2200);
	assert.equal(existsSync(join(cwd, "late.txt")), false);
});

test("read image results survive a restart and reach DeepSeek after the matching tool result", async (t) => {
	const { cwd, tools, store } = fixture(t);
	writeFileSync(join(cwd, "pixel.png"), Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64",
	));
	let request = 0;
	t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
		const body = JSON.parse(String(options.body));
		if (++request === 1) {
			return sse({ delta: { tool_calls: [{ index: 0, id: "pic", function: { name: "read", arguments: '{"path":"pixel.png"}' } }] }, finish_reason: "tool_calls" });
		}
		assert.equal(body.messages.at(-2).tool_call_id, "pic");
		assert.match(body.messages.at(-1).content[1].image_url.url, /^data:image\/png;base64,/);
		return sse({ delta: { content: "Read the image" }, finish_reason: "stop" });
	});
	const session = new AgentSession(store, {
		tools, contextWindow: 100_000,
		stream: (context, options) => streamOpenAiCompletions(deepseek, context, { ...options, resolveApiKey: () => "test" }),
	});
	const reply = await session.prompt("read it", () => {});
	assert.equal(messageText(reply), "Read the image", reply.errorMessage);
	const result = store.list()[0].history.find((entry) => entry.role === "toolResult");
	assert.equal(result?.toolCallId, "pic");
	assert.ok(result?.content.some((block) => block.type === "image"));
});

test("the agent completes fragmented batches, survives tool failures and checks its edits", async (t) => {
	const { cwd, tools, store } = fixture(t);
	writeFileSync(join(cwd, "answer.txt"), "before\n");
	let request = 0;
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body));
		assert.equal(body.messages[0].role, "system");
		assert.ok(body.tools.some((tool: { function: { name: string } }) => tool.function.name === "edit"));
		switch (++request) {
			case 1:
				return sse(
					{ delta: { tool_calls: [
						{ index: 1, id: "bad", function: { name: "write", arguments: '{"path":' } },
						{ index: 0, id: "search", function: { name: "grep", arguments: '{"pattern":"be' } },
					] } },
					{ delta: { tool_calls: [{ index: 0, function: { arguments: 'fore"}' } }] } },
					{ finish_reason: "tool_calls" },
				);
			case 2:
				assert.equal(body.messages.at(-2).tool_call_id, "search");
				assert.match(body.messages.at(-2).content, /answer\.txt:1: before/);
				assert.equal(body.messages.at(-1).tool_call_id, "bad");
				assert.match(body.messages.at(-1).content, /完整的 JSON/);
				assert.deepEqual(body.messages.at(-3).tool_calls.map((tool: { id: string }) => tool.id), ["search", "bad"]);
				return sse({ delta: { tool_calls: [
					{ index: 0, id: "edit", function: { name: "edit",
						arguments: '{"path":"answer.txt","edits":[{"oldText":"before","newText":"after"}]}' } },
					{ index: 1, id: "check", function: { name: "bash", arguments: JSON.stringify({ command: "grep -Fx after answer.txt", timeout: 15 }) } },
				] }, finish_reason: "tool_calls" });
			default:
				assert.equal(body.messages.at(-1).tool_call_id, "check");
				assert.equal(body.messages.at(-1).content.trim(), "after");
				return sse({ delta: { content: "Verified the change" }, finish_reason: "stop" });
		}
	});
	const session = new AgentSession(store, {
		tools, systemPrompt: "Use the active project tools.", contextWindow: 100_000,
		stream: (context, options) => streamOpenAiCompletions(deepseek, context, { ...options, resolveApiKey: () => "test" }),
	});
	const started: string[] = [];
	assert.equal(messageText(await session.prompt("Replace before with after", (event) => {
		if (event.type === "tool_execution_start") {
			assert.ok(store.list()[0].history.some((entry) => entry.role === "assistant"
				&& entry.content.some((block) => block.type === "toolCall" && block.id === event.call.id)));
			started.push(event.call.id);
		}
	})), "Verified the change");
	assert.deepEqual(started, ["search", "bad", "edit", "check"]);
	assert.equal(readFileSync(join(cwd, "answer.txt"), "utf8"), "after\n");
});

test("truncated tool arguments do not execute", async (t) => {
	const { cwd, tools, store } = fixture(t);
	t.mock.method(globalThis, "fetch", async () => sse(
		{ delta: { tool_calls: [{ index: 0, id: "cut", function: { name: "write", arguments: '{"path":"bad.txt","content":"bad"}' } }] } },
		{ finish_reason: "length" },
	));
	const session = new AgentSession(store, {
		tools, contextWindow: 100_000,
		stream: (context, options) => streamOpenAiCompletions(deepseek, context, { ...options, resolveApiKey: () => "test" }),
	});
	assert.equal((await session.prompt("write", () => {})).stopReason, "length");
	assert.equal(existsSync(join(cwd, "bad.txt")), false);
	assert.equal(store.list()[0].history.length, 2);
});

test("retry resumes a completed or interrupted action without replaying it", async (t) => {
	const { cwd, tools, store } = fixture(t);
	const filename = join(cwd, "state.txt");
	const action = assistant("", { stopReason: "toolUse", content: [call("write", { path: "state.txt", content: "original" })] });
	let requested = 0;
	const first = new AgentSession(store, {
		tools, contextWindow: 100_000,
		stream: async () => ++requested === 1 ? action : assistant("", { stopReason: "error" }),
	});
	await first.prompt("write a file", () => {});
	assert.equal(readFileSync(filename, "utf8"), "original");
	writeFileSync(filename, "a later change");
	const options: ConstructorParameters<typeof AgentSession>[1] = {
		tools, contextWindow: 100_000,
		stream: async (context) => {
			const result = context.at(-1);
			assert.equal(result?.role, "toolResult");
			assert.equal(result?.toolCallId, "call_write");
			assert.match(messageText(result!), requested === 2 ? /Successfully wrote/ : /结果未知/);
			return assistant("continued");
		},
	};
	await new AgentSession(store, options).continue(() => {});
	assert.equal(readFileSync(filename, "utf8"), "a later change");

	const interrupted = store.create();
	store.append(interrupted, { role: "user", timestamp: Date.now(), content: [{ type: "text", text: "write again" }] });
	store.append(interrupted, action);
	requested++;
	const restarted = new AgentSession(store, options);
	restarted.resume(store.list().find((entry) => entry.path === interrupted.path)!);
	await restarted.continue(() => {});
	assert.equal(readFileSync(filename, "utf8"), "a later change");
	assert.deepEqual(store.list().find((entry) => entry.path === interrupted.path)!.history.map((entry) => entry.role),
		["user", "assistant", "toolResult", "assistant"]);
});

test("compaction summarizes tool activity and retains the recent call and result together", async (t) => {
	const { store, tools } = fixture(t);
	const seeded = store.create();
	for (const id of ["earlier", "recent"]) {
		store.append(seeded, { role: "user", timestamp: 1, content: [{ type: "text", text: id }] });
		store.append(seeded, assistant("", {
			stopReason: "toolUse", content: [call("read", { path: id + ".txt" }, id)],
		}));
		store.append(seeded, { role: "toolResult", timestamp: 1, toolCallId: id, toolName: "read", isError: false,
			content: [{ type: "text", text: id + " output" }] });
		store.append(seeded, assistant(id + " answer"));
	}
	let summaryCalled = false;
	const options: ConstructorParameters<typeof AgentSession>[1] = {
		tools, systemPrompt: "Use tools.", contextWindow: 100_000,
		stream: async (context, { tools: declared }) => {
			if (!summaryCalled) {
				summaryCalled = true;
				assert.equal(declared, undefined);
				assert.match(messageText(context[0]), /read\(\{"path":"earlier.txt"\}\)/);
				assert.match(messageText(context[0]), /earlier output/);
				return assistant("Earlier activity.");
			}
			assert.equal(context[0].role, "system");
			assert.match(messageText(context[1]), /Earlier activity/);
			assert.ok(context.some((entry) => entry.role === "assistant" &&
				entry.content.some((block) => block.type === "toolCall" && block.id === "recent")));
			assert.ok(context.some((entry) => entry.role === "toolResult" && entry.toolCallId === "recent"));
			assert.ok(!context.some((entry) => entry.role === "toolResult" && entry.toolCallId === "earlier"));
			return assistant("continuing");
		},
	};
	await new AgentSession(store, options).compact(() => {});
	assert.equal(messageText(await new AgentSession(store, options).prompt("next", () => {})), "continuing");
});

test("readline shows a tool call, completion and final text in order", (t) => {
	const { cwd } = fixture(t);
	writeFileSync(join(cwd, "example.txt"), "my local content");
	const preload = async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body));
		const last = body.messages.at(-1);
		if (!body.tools.some((tool: { function: { name: string } }) => tool.function.name === "read")) {
			return new Response(null, { status: 400 });
		}
		const choice = last.role === "user"
			? { delta: { tool_calls: [{ index: 0, id: "cli-read",
				function: { name: "read", arguments: '{"path":"example.txt"}' } }] }, finish_reason: "tool_calls" }
			: { delta: { content: "Seen " + last.content }, finish_reason: "stop" };
		return new Response("data: " + JSON.stringify({ choices: [choice] }) + "\n\ndata: [DONE]\n\n");
	};
	const importUrl = "data:text/javascript;base64," + Buffer.from("globalThis.fetch = " + preload.toString()).toString("base64");
	const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
	const child = spawnSync(process.execPath, ["--import", importUrl, main, "--yolo"], {
		cwd, input: "Read the example\n/exit\n", encoding: "utf8", timeout: 15_000,
		env: { ...process.env, TI_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "fake", TI_HOME: join(cwd, "auth"),
			TI_SESSION_HOME: join(cwd, "data"), TI_LEGACY_HOME: "" },
	});
	assert.ifError(child.error);
	assert.equal(child.status, 0, child.stderr);
	assert.match(child.stdout, /read example\.txt\r?\nread · 完成\r?\nTi> Seen my local content/);
});
