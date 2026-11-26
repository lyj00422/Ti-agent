import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/agent/agent.ts";
import type { AssistantMessage, ChatMessage, ToolCall } from "../src/agent/messages.ts";
import type { ToolSnapshot } from "../src/tools/registry.ts";

const assistant = (stopReason: AssistantMessage["stopReason"], text = ""): AssistantMessage => ({
	role: "assistant", content: text ? [{ type: "text", text }] : [], timestamp: Date.now(), stopReason,
});

test("steering is committed between turns and async subscribers settle before the run", async () => {
	const agent = new Agent();
	const committed: ChatMessage[] = [];
	const seen: string[] = [];
	let requests = 0;
	const requestStarted = Promise.withResolvers<void>();
	const releaseRequest = Promise.withResolvers<void>();
	let subscriberSettled = false;
	agent.subscribe(async (event) => {
		await Promise.resolve();
		seen.push(event.type);
		if (event.type === "agent_end") subscriberSettled = true;
	});
	const running = agent.run({
		request: async () => {
			requests++;
			if (requests === 1) {
				requestStarted.resolve();
				await releaseRequest.promise;
				return { reply: assistant("stop") };
			}
			return { reply: assistant("stop", "done") };
		},
		commit: (message) => committed.push(message),
	});
	await requestStarted.promise;
	agent.steer("focus on the failing test");
	releaseRequest.resolve();
	await running;
	assert.equal(requests, 2);
	const steeringMessage = committed.find((message) => message.role === "user");
	assert.equal(steeringMessage?.role === "user" ? steeringMessage.content[0]?.text : "", "focus on the failing test");
	assert.equal(subscriberSettled, true);
	assert.deepEqual(seen.filter((event) => event === "turn_start"), ["turn_start", "turn_start"]);
});

test("parallel tool calls commit results in model order", async () => {
	const agent = new Agent();
	const committed: ChatMessage[] = [];
	const calls: ToolCall[] = [
		{ type: "toolCall", id: "slow", name: "slow", arguments: {} },
		{ type: "toolCall", id: "fast", name: "fast", arguments: {} },
	];
	const executions: string[] = [];
	const tools: ToolSnapshot = {
		declarations: [], prompt: [], executionMode: "parallel",
		async execute(call) {
			executions.push(call.id);
			if (call.id === "slow") await new Promise((resolve) => setTimeout(resolve, 15));
			return { content: [{ type: "text", text: call.id }] };
		},
	};
	let requests = 0;
	await agent.run({
		request: async () => ++requests === 1
			? { reply: { ...assistant("toolUse"), content: calls }, tools }
			: { reply: assistant("stop", "complete"), tools },
		commit: (message) => committed.push(message),
	});
	assert.deepEqual(executions, ["slow", "fast"]);
	assert.deepEqual(committed.filter((message) => message.role === "toolResult").map((message) => message.toolCallId), ["slow", "fast"]);
});

test("a sequential tool forces the whole batch to run in order", async () => {
	const agent = new Agent();
	const committed: ChatMessage[] = [];
	const started: string[] = [];
	const calls: ToolCall[] = [
		{ type: "toolCall", id: "first", name: "first", arguments: {} },
		{ type: "toolCall", id: "second", name: "second", arguments: {} },
	];
	const tools: ToolSnapshot = {
		declarations: [], prompt: [], executionMode: "sequential",
		async execute(call) {
			started.push(call.id);
			return { content: [{ type: "text", text: call.id }] };
		},
	};
	let requests = 0;
	await agent.run({
		request: async () => ++requests === 1
			? { reply: { ...assistant("toolUse"), content: calls }, tools }
			: { reply: assistant("stop", "complete"), tools },
		commit: (message) => committed.push(message),
	});
	assert.deepEqual(started, ["first", "second"]);
	assert.deepEqual(committed.filter((message) => message.role === "toolResult").map((message) => message.toolCallId), ["first", "second"]);
});

test("a run can continue beyond 32 model turns", async () => {
	const agent = new Agent();
	const committed: ChatMessage[] = [];
	let requests = 0;
	const result = await agent.run({
		request: async () => ({ reply: assistant("stop", String(++requests)) }),
		commit: (message) => committed.push(message),
		finishTurn: async () => requests < 40 ? "continue" : undefined,
	});
	assert.equal(requests, 40);
	assert.equal(result.stopReason, "stop");
	assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "40");
	assert.equal(committed.at(-1), result);
});

test("a fully terminating tool batch ends the agent loop", async () => {
	const agent = new Agent();
	const committed: ChatMessage[] = [];
	let requests = 0;
	const tools: ToolSnapshot = {
		declarations: [], prompt: [], executionMode: "parallel",
		async execute() { return { content: [{ type: "text", text: "denied" }], isError: true, terminate: true }; },
	};
	const result = await agent.run({
		request: async () => {
			requests++;
			return { reply: { ...assistant("toolUse"), content: [{ type: "toolCall", id: "blocked", name: "blocked", arguments: {} }] }, tools };
		},
		commit: (message) => committed.push(message),
	});
	assert.equal(requests, 1);
	assert.equal(result.stopReason, "toolUse");
	assert.equal(committed.find((message) => message.role === "toolResult")?.role === "toolResult"
		? committed.find((message) => message.role === "toolResult")?.terminate : false, true);
});
