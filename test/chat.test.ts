import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { messageText } from "../src/agent/messages.ts";
import type { AssistantMessage, ModelMessage } from "../src/agent/messages.ts";
import type { ModelStream } from "../src/providers/types.ts";
import { AgentSession } from "../src/session/agent-session.ts";
import { BUILTIN_MODELS } from "../src/providers/catalog.ts";
import { streamOpenAiCompletions } from "../src/providers/openai-completions.ts";
import { SessionStore } from "../src/session/store.ts";

function homes(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "ti-chat-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { current: join(root, "ti"), old: join(root, "legacy"), cwd: join(root, "project") };
}

function assistant(text: string, options: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", content: text ? [{ type: "text", text }] : [], timestamp: Date.now(), stopReason: "stop", ...options };
}

const ignore = () => {};
const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
const deepseek = BUILTIN_MODELS.find((model) => model.provider === "deepseek")!;

test("DeepSeek handles split text and a usage-only event before DONE", async (t) => {
	const response = [
		'data: {"choices":[{"delta":{"content":"你',
		'好"}}]}\r\n\r\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":4,"prompt_cache_hit_tokens":0}}\r\n\r\n',
		"data: [DONE]\r\n\r\n",
	];
	t.mock.method(globalThis, "fetch", async (_url: string, request: RequestInit) => {
		const body = JSON.parse(String(request.body));
		assert.deepEqual(body.stream_options, { include_usage: true });
		assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
		assert.equal(body.max_tokens, 50);
		return new Response(new ReadableStream({
			start(controller) {
				for (const part of response) controller.enqueue(new TextEncoder().encode(part));
				controller.close();
			},
		}));
	});
	const events: unknown[] = [];
	const reply = await streamOpenAiCompletions(deepseek, messages, {
		resolveApiKey: () => "test",
		signal: new AbortController().signal, maxOutputTokens: 50, onEvent: (event) => events.push(event),
	});
	assert.equal(messageText(reply), "你好");
	assert.deepEqual(reply.usage, { input: 100, output: 4, cacheRead: 0 });
	assert.deepEqual(events, [{ type: "text_delta", text: "你好" }, { type: "usage", usage: reply.usage }]);
});

test("DeepSeek distinguishes auth, rate limits, context overflow, truncation, and a broken stream", async (t) => {
	let response = new Response();
	t.mock.method(globalThis, "fetch", async () => response);
	const request = () => streamOpenAiCompletions(deepseek, messages, { resolveApiKey: () => "test", signal: new AbortController().signal, onEvent: ignore });
	response = new Response('{"error":{"message":"invalid key"}}', { status: 401 });
	assert.equal((await request()).error?.kind, "auth");
	response = new Response(null, { status: 429 });
	assert.equal((await request()).error?.kind, "rateLimit");
	response = new Response('{"error":{"message":"Maximum context length exceeded","code":"context_length_exceeded"}}', { status: 400 });
	assert.equal((await request()).error?.kind, "contextOverflow");
	const part = 'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n';
	response = new Response(part + 'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\ndata: [DONE]\n\n');
	const truncated = await request();
	assert.equal(truncated.stopReason, "length");
	assert.equal(truncated.usage?.cacheRead, undefined);
	response = new Response(part);
	const broken = await request();
	assert.equal(broken.error?.kind, "network");
	assert.equal(messageText(broken), "partial");
	response = new Response('data: {"choices":[{"delta":{"tool_calls":[{}]}}]}\n\ndata: [DONE]\n\n');
	assert.equal((await request()).error?.kind, "protocol");
});

test("aborting DeepSeek cancels the active stream and retains its partial text", async (t) => {
	const abort = new AbortController();
	t.mock.method(globalThis, "fetch", async (_url: string, request: RequestInit) => {
		assert.equal(request.signal, abort.signal);
		return new Response(new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
				abort.signal.addEventListener("abort", () => controller.error(abort.signal.reason), { once: true });
			},
		}));
	});
	const reply = await streamOpenAiCompletions(deepseek, messages, {
		resolveApiKey: () => "test",
		signal: abort.signal, onEvent: (event) => {
			if (event.type === "text_delta") abort.abort();
		},
	});
	assert.equal(reply.stopReason, "aborted");
	assert.equal(messageText(reply), "partial");
});

test("retry after restart reuses the original persisted user message", async (t) => {
	const { current, old, cwd } = homes(t);
	const store = new SessionStore(current, [old], cwd);
	let attempt = 0;
	const stream: ModelStream = async (context) => {
		assert.deepEqual(context.map(messageText), ["one question"]);
		assert.equal(store.list()[0].history.filter((message) => message.role === "user").length, 1);
		return ++attempt === 1 ? assistant("unfinished", { stopReason: "error", errorMessage: "disconnected" }) : assistant("answer");
	};
	const first = new AgentSession(store, { stream, contextWindow: 1_000_000 });
	assert.equal((await first.prompt("one question", ignore)).stopReason, "error");
	const restored = new AgentSession(store, { stream, contextWindow: 1_000_000 });
	assert.equal(messageText(await restored.continue(ignore)), "answer");
	assert.deepEqual(restored.history.map((message) => message.role), ["user", "assistant", "assistant"]);
	await assert.rejects(restored.continue(ignore), /没有可重试/);
	assert.equal(attempt, 2);
});

test("automatic compaction uses actual usage, persists its boundary, and can be repeated manually", async (t) => {
	const { current, cwd } = homes(t);
	const store = new SessionStore(current, [], cwd);
	const requests: string[][] = [];
	const earlier = "Old details. ".repeat(38);
	const recent = "Current question. ".repeat(5);
	let summaries = 0;
	const stream: ModelStream = async (context) => {
		const text = context.map(messageText);
		requests.push(text);
		if (text[0].startsWith("Summarize this")) {
			summaries++;
			if (summaries === 1) {
				assert.ok(text[0].includes(earlier));
				assert.ok(!text[0].includes(recent));
				return assistant("A summary.", { usage: { input: 130, output: 8 } });
			}
			assert.ok(text[0].includes("A summary."));
			if (summaries === 2) return assistant("incomplete", { stopReason: "length", usage: { input: 25, output: 5 } });
			return assistant("A shorter summary.");
		}
		return requests.length === 1
			? assistant("Old reply.", { usage: { input: 360, output: 15, cacheRead: 100 } })
			: assistant("Answer.", { usage: { input: 70, output: 5, cacheRead: 0 } });
	};
	const options = { stream, contextWindow: 460, reserveTokens: 90, keepRecentTokens: 35 };
	const first = new AgentSession(store, options);
	await first.prompt(earlier, ignore);
	assert.equal(first.usage().contextTokens, 375);
	const events: string[] = [];
	await first.prompt(recent, (event) => events.push(event.type));
	assert.deepEqual(events, ["agent_start", "message_start", "message_end", "turn_start", "compacting", "compacted", "message_start", "message_end", "turn_end", "agent_end"]);
	assert.deepEqual(requests[2], ["Earlier conversation summary (context only):\nA summary.", recent]);
	assert.equal(first.usage().total?.input, 560);
	assert.equal(first.usage().total?.cacheRead, 100);
	const restored = new AgentSession(store, options);
	assert.equal(restored.usage().contextTokens, 75);
	assert.equal(restored.history.length, 4);
	await restored.prompt("Follow-up", ignore);
	assert.deepEqual(requests[3], [...requests[2], "Answer.", "Follow-up"]);

	const prior = store.list()[0].compactions[0];
	await assert.rejects(restored.compact(ignore), /未收到完整/);
	assert.deepEqual(store.list()[0].compactions, [prior]);
	assert.equal(new AgentSession(store, options).usage().total?.input, 655);
	await restored.compact(ignore);
	const saved = store.list()[0];
	assert.equal(saved.compactions.length, 2);
	assert.equal(saved.compactions[1].firstKeptEntryId, saved.history[4].id);
	assert.equal(saved.history.length, 6);
});

test("retry can compact on provider-confirmed overflow under the local estimate", async (t) => {
	const { current, cwd } = homes(t);
	const store = new SessionStore(current, [], cwd);
	let attempts = 0;
	const stream: ModelStream = async (context) => {
		switch (++attempts) {
			case 1: return assistant("old answer");
			case 2: return assistant("", { stopReason: "error", error: { kind: "contextOverflow", message: "maximum context length" } });
			case 3:
				assert.match(messageText(context[0]), /^Summarize this/);
				return assistant("A summary.");
			default:
				assert.deepEqual(context.map(messageText), ["Earlier conversation summary (context only):\nA summary.", "new question"]);
				return assistant("new answer");
		}
	};
	const session = new AgentSession(store, { stream, contextWindow: 1_000_000 });
	await session.prompt("Old material. ".repeat(40), ignore);
	await session.prompt("new question", ignore);
	assert.equal(messageText(await session.continue(ignore)), "new answer");
	assert.equal(session.history.filter((message) => message.role === "user").length, 2);
});

test("legacy text content is restored and append migrates to the current directory", async (t) => {
	const { current, old, cwd } = homes(t);
	const legacy = new SessionStore(old, [], cwd).create();
	mkdirSync(dirname(legacy.path), { recursive: true });
	const legacyContents = legacy.initialContents + JSON.stringify({
		type: "message", id: "old-user", parentId: null, message: { role: "user", content: "saved prompt", timestamp: 1 },
	}) + "\n";
	writeFileSync(legacy.path, legacyContents);
	const store = new SessionStore(current, [old], cwd);
	const stream: ModelStream = async (context) => {
		assert.deepEqual(context.map(messageText), ["saved prompt"]);
		return assistant("continued");
	};
	const session = new AgentSession(store, { stream, contextWindow: 1_000_000 });
	await session.continue(ignore);
	assert.equal(readFileSync(legacy.path, "utf8"), legacyContents);
	assert.deepEqual(store.list()[0].history.map(messageText), ["saved prompt", "continued"]);
});

test("the CLI uses the saved key and resumes the session on restart", (t) => {
	const { current, old, cwd } = homes(t);
	mkdirSync(cwd, { recursive: true });
	const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
	const fetchMock = async (_url: string, request: RequestInit) => {
		const body = JSON.parse(String(request.body));
		const key = new Headers(request.headers).get("authorization");
		if (key !== "Bearer fake-cli-key") return new Response(null, { status: 401 });
		if (body.messages[0]?.role !== "system" || !body.tools?.some((tool: { function: { name: string } }) => tool.function.name === "read")) {
			return new Response(null, { status: 400 });
		}
		const text = body.messages.slice(1).map((message: { content: string }) => message.content).join(" / ");
		return new Response("data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) +
			'\n\ndata: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4,"prompt_cache_hit_tokens":2}}\n\ndata: [DONE]\n\n');
	};
	const preload = "data:text/javascript;base64," + Buffer.from("globalThis.fetch = " + fetchMock.toString()).toString("base64");
	const run = (input: string, home = current, legacyHome = "") => {
		const result = spawnSync(process.execPath, ["--import", preload, main], {
			cwd, input, encoding: "utf8", timeout: 10_000,
			env: { ...process.env, DEEPSEEK_API_KEY: "", TI_PROVIDER: "deepseek", TI_HOME: home, TI_SESSION_HOME: home, TI_LEGACY_HOME: legacyHome },
		});
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
		assert.doesNotMatch(result.stdout, /请求失败|fake-cli-key/);
		return result.stdout;
	};
	const first = run("/login deepseek\nfake-cli-key\n/model deepseek/deepseek-flash\nfirst\n/usage\n/exit\n");
	assert.match(first, /当前模型：deepseek\/deepseek-flash/);
	assert.match(first, /Ti> first/);
	assert.match(first, /输入 9 · 输出 4 · 缓存命中 2/);
	const second = run("second\n/new\nthird\n/exit\n");
	assert.match(second, /^Ti · deepseek\/deepseek-flash/);
	assert.match(second, /Ti> first \/ first \/ second/);
	assert.match(second, /Ti> third/);
	const store = new SessionStore(current, [], cwd);
	assert.deepEqual(store.list().map((session) => session.history.length).sort(), [2, 4]);

	const legacyStore = new SessionStore(old, [], cwd);
	const legacy = legacyStore.create();
	legacyStore.append(legacy, { role: "user", content: [{ type: "text", text: "legacy question" }], timestamp: 1 });
	writeFileSync(join(old, "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "fake-cli-key" } }));
	const imported = join(dirname(current), "imported");
	assert.match(run("/retry\n/exit\n", imported, old), /Ti> legacy question/);
	assert.equal(legacyStore.list()[0].history.length, 1);
	assert.equal(new SessionStore(imported, [], cwd).list()[0].history.length, 2);
});

test("TTY scrolls history and Escape aborts only the active generation", (t) => {
	const { current, cwd } = homes(t);
	const script = fileURLToPath(new URL("./tty-smoke.ts", import.meta.url));
	const result = spawnSync(process.execPath, [script, current, cwd], { encoding: "utf8", timeout: 10_000 });
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
});
