import assert from "node:assert/strict";
import { stdin, stdout } from "node:process";
import { messageText } from "../src/agent.ts";
import type { AssistantMessage, StreamReply } from "../src/agent.ts";
import { ChatSession } from "../src/chat-session.ts";
import { SessionStore } from "../src/sessions.ts";
import { startTerminalChat } from "../src/terminal-chat.ts";

const [, , home, cwd] = process.argv;
const store = new SessionStore(home, [], cwd);
const previous = store.create();
const assistant = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage =>
	({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now(), stopReason });

for (let index = 0; index < 12; index++) {
	store.append(previous, { role: "user", content: [{ type: "text", text: "message " + index }], timestamp: index });
	store.append(previous, assistant("answer " + index));
}

const stream: StreamReply = async (context, { signal, onEvent }) => {
	assert.equal(signal.aborted, false);
	if (messageText(context.at(-1)!) === "wait") {
		onEvent({ type: "text_delta", text: "visible partial" });
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		return assistant("visible partial", "aborted");
	}
	return assistant("next answer");
};
const session = new ChatSession(store, { stream, contextWindow: 1_000_000 });
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
const cli = startTerminalChat({ model: "mock", session, login: (value) => { savedKey = value; } });
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
	send("hidden-test-key");
	assert.equal(savedKey, "hidden-test-key");
	assert.doesNotMatch(screen, /hidden-test-key/);
	send("/new");
	assert.equal(session.history.length, 0);
	send("/resume");
	key("return");
	assert.equal(session.history.length, 28);
} finally {
	key("c", undefined, true);
	await cli;
}
