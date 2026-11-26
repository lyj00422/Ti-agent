import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { stripVTControlCharacters } from "node:util";
import { Type } from "typebox";
import { messageText } from "../src/agent/messages.ts";
import type { AssistantMessage } from "../src/agent/messages.ts";
import type { ModelStream } from "../src/providers/types.ts";
import { AgentSession } from "../src/session/agent-session.ts";
import { SessionStore } from "../src/session/store.ts";
import { startTerminalChat } from "../src/terminal/chat.ts";
import { createCoreTools } from "../src/tools/index.ts";

const [, , home, cwd] = process.argv;
mkdirSync(cwd, { recursive: true });
const store = new SessionStore(home, [], cwd);
const previous = store.create();
const assistant = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage =>
	({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now(), stopReason });

for (let index = 0; index < 12; index++) {
	store.append(previous, { role: "user", content: [{ type: "text", text: "message " + index }], timestamp: index });
	store.append(previous, assistant("answer " + index));
}

const stream: ModelStream = async (context, { signal, onEvent }) => {
	assert.equal(signal.aborted, false);
	if (messageText(context.at(-1)!) === "list") {
		onEvent({ type: "text_delta", text: "Inspecting" });
		return { ...assistant("Inspecting", "toolUse"), content: [
			{ type: "text", text: "Inspecting" }, { type: "toolCall", id: "list-tty", name: "ls", arguments: {} },
		] };
	}
	if (messageText(context.at(-1)!) === "progress") {
		return { ...assistant("", "toolUse"), content: [
			{ type: "toolCall", id: "progress-tty", name: "progress", arguments: {} },
		] };
	}
	if (context.at(-1)?.role === "toolResult") {
		onEvent({ type: "text_delta", text: "Listing finished" });
		return assistant("Listing finished");
	}
	if (messageText(context.at(-1)!) === "wait") {
		onEvent({ type: "text_delta", text: "visible partial" });
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		return assistant("visible partial", "aborted");
	}
	return assistant("next answer");
};
const tools = createCoreTools(cwd);
tools.register({
	name: "progress", label: "Progress", description: "Report a long progress line",
	parameters: Type.Object({}),
	async execute(_id, _args, _signal, onUpdate) {
		onUpdate?.({ content: [{ type: "text", text: "进".repeat(105) + " 界面仍在更新" }] });
		return { content: [{ type: "text", text: "Finished" }] };
	},
});
const session = new AgentSession(store, { stream, contextWindow: 1_000_000, tools });
let screen = "";
Object.defineProperties(stdin, { isTTY: { value: true }, setRawMode: { value: () => stdin } });
Object.defineProperties(stdout, { isTTY: { value: true }, rows: { value: 12 }, columns: { value: 90 } });
stdin.resume = () => stdin;
stdout.write = (chunk) => { screen += String(chunk); return true; };
const key = (name: string, text?: string, ctrl = false) => stdin.emit("keypress", text, { name, ctrl });
const send = (text: string) => {
	for (const character of text) key(character, character);
	key("return");
};
let savedKey = "";
let selectedModel = "mock/mock";
let thinkingLevel = "medium";
let savedThinking = "";
const cli = startTerminalChat({
	session,
	getModel: () => selectedModel,
	models: () => [
		{ provider: "mock", id: "mock", name: "mock", label: "mock/mock" },
		{ provider: "proxy", id: "other", name: "other", label: "proxy/other" },
	],
	selectModel: (reference) => { selectedModel = reference; return selectedModel; },
	providers: () => ["mock", "proxy"],
	login: (provider, value) => { assert.equal(provider, "proxy"); savedKey = value; },
	getThinking: () => thinkingLevel,
	thinkingLevels: () => ["off", "minimal", "low", "medium", "high", "xhigh"],
	setThinking: (level, persist) => {
		if (persist) savedThinking = level;
		return thinkingLevel = level;
	},
});
try {
	for (let step = 0; step < 30; step++) key("up");
	assert.match(screen, /message 0/);
	key("down");
	stdout.emit("resize");
	send("wait");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.match(screen, /visible partial/);
	key("escape");
	await session.waitForIdle();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.match(screen, /已停止/);
	send("next");
	await session.waitForIdle();
	assert.equal(messageText(session.history.at(-1)!), "next answer");
	assert.equal(messageText(store.list()[0].history.at(-3)!), "visible partial");
	send("/login");
	key("down");
	key("return");
	send("hidden-test-key");
	assert.equal(savedKey, "hidden-test-key");
	assert.doesNotMatch(screen, /hidden-test-key/);
	send("/model");
	key("down");
	key("return");
	assert.equal(selectedModel, "proxy/other");
	stdin.emit("keypress", undefined, { name: "tab", shift: true, sequence: "\x1b[Z" });
	assert.equal(thinkingLevel, "high");
	assert.match(screen, /Thinking level: high/);
	send("/thinking");
	key("down");
	key("s", undefined, true);
	assert.equal(thinkingLevel, "xhigh");
	assert.equal(savedThinking, "xhigh");
	send("/new");
	assert.equal(session.history.length, 0);
	send("/resume");
	key("return");
	assert.equal(session.history.length, 28);
	send("list");
	await session.waitForIdle();
	assert.match(screen, /ls · 完成/);
	assert.match(screen, /Listing finished/);
	assert.equal(session.history.at(-2)?.role, "toolResult");
	send("progress");
	await session.waitForIdle();
	const result = session.history.at(-2);
	assert.ok(result?.role === "toolResult");
	assert.equal(result.isError, false, messageText(result));
	const border = stripVTControlCharacters(screen).match(/── …进+ 界面仍在更新 ─+/)?.[0];
	assert.ok(border, "The progress border should show the truncated status");
	const cells = Array.from(border).reduce((sum, point) => sum + (/\p{Script=Han}/u.test(point) ? 2 : 1), 0);
	assert.equal(cells, stdout.columns);
} finally {
	key("c", undefined, true);
	await cli;
}
