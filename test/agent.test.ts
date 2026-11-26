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

test("a run records an error when it reaches its turn limit", async () => {
	const agent = new Agent();
	const committed: ChatMessage[] = [];
	let requests = 0;
	const result = await agent.run({
		request: async () => ({ reply: assistant("stop", String(++requests)) }),
		commit: (message) => committed.push(message),
		finishTurn: async () => "continue",
	});
	assert.equal(requests, 32);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /32/);
	assert.equal(committed.at(-1), result);
});
