import { StringDecoder } from "node:string_decoder";
import { stdin, stderr, stdout } from "node:process";
import { errorMessage } from "../agent/messages.ts";
import type { AgentEvent } from "../agent/agent.ts";
import type { AgentSession } from "../session/agent-session.ts";
import type { ModelChoice } from "../providers/model-runtime.ts";
import type { ToolApprovalBroker } from "../tools/permissions.ts";

type RpcId = string | number;
type RpcCommand = Record<string, unknown> & { id?: RpcId; type: string };

export interface RpcModeOptions {
	session: AgentSession;
	approvals: ToolApprovalBroker;
	getModel: () => string;
	models: () => readonly ModelChoice[];
	selectModel: (reference: string) => string;
	getThinking: () => string;
	thinkingLevels: () => readonly string[];
	setThinking: (level: string) => string;
}

export async function runRpcMode(options: RpcModeOptions): Promise<void> {
	const decoder = new StringDecoder("utf8");
	let buffered = "";
	let closing = false;
	let outputQueue = Promise.resolve();
	const pendingCommands = new Set<Promise<void>>();
	const settled = Promise.withResolvers<void>();

	const send = (record: unknown) => {
		outputQueue = outputQueue.then(async () => {
			if (!stdout.write(JSON.stringify(record) + "\n")) {
				await new Promise<void>((resolve) => stdout.once("drain", resolve));
			}
		});
		return outputQueue;
	};
	const event = (value: AgentEvent) => send(value);
	const stopApprovalListener = options.approvals.subscribe((request) => {
		void send({ type: "permission_request", requestId: request.id, toolName: request.toolName, input: request.input, parentToolCallId: request.parentToolCallId });
	});

	const startRun = (id: RpcId | undefined, kind: "prompt" | "retry", action: () => Promise<unknown>) => {
		let operation: Promise<unknown>;
		try {
			operation = action();
		} catch (error) {
			return send(failure(id, kind, error));
		}
		void send(success(id, kind, { disposition: "started" }));
		void operation.then(
			() => send({ type: "agent_settled" }),
			(error: unknown) => send({ type: "agent_settled", error: errorMessage(error) }),
		);
		return Promise.resolve();
	};

	const handle = async (command: RpcCommand) => {
		if (closing) return;
		const id = command.id;
		try {
			switch (command.type) {
				case "prompt": {
					if (typeof command.message !== "string") throw new Error("prompt.message 必须是字符串。");
					if (options.session.isRunning) {
						if (command.streamingBehavior === "steer") options.session.runtime.steer(command.message);
						else if (command.streamingBehavior === "followUp") options.session.runtime.followUp(command.message);
						else throw new Error("Agent 正在运行，请指定 streamingBehavior 为 steer 或 followUp。");
						await send(success(id, "prompt", { disposition: command.streamingBehavior }));
						return;
					}
					await startRun(id, "prompt", () => options.session.prompt(command.message as string, event));
					return;
				}
				case "steer":
					if (typeof command.message !== "string") throw new Error("steer.message 必须是字符串。");
					await send(success(id, "steer", { disposition: options.session.runtime.steer(command.message) }));
					return;
				case "follow_up":
					if (typeof command.message !== "string") throw new Error("follow_up.message 必须是字符串。");
					await send(success(id, "follow_up", { disposition: options.session.runtime.followUp(command.message) }));
					return;
				case "abort":
					options.session.abort();
					await send(success(id, "abort"));
					return;
				case "clear_queue":
					await send(success(id, "clear_queue", options.session.runtime.clearQueue()));
					return;
				case "get_state":
					await send(success(id, "get_state", {
						model: options.getModel(),
						thinkingLevel: options.getThinking(),
						isRunning: options.session.isRunning,
						messageCount: options.session.history.length,
						pendingMessageCount: options.session.runtime.pendingMessageCount,
					}));
					return;
				case "get_messages":
					await send(success(id, "get_messages", { messages: options.session.history }));
					return;
				case "get_available_models":
					await send(success(id, "get_available_models", { models: options.models() }));
					return;
				case "set_model":
					if (typeof command.provider !== "string" || typeof command.modelId !== "string") throw new Error("set_model 需要 provider 和 modelId。");
					await send(success(id, "set_model", { model: options.selectModel(`${command.provider}/${command.modelId}`) }));
					return;
				case "get_available_thinking_levels":
					await send(success(id, "get_available_thinking_levels", { levels: options.thinkingLevels() }));
					return;
				case "set_thinking_level":
					if (typeof command.level !== "string") throw new Error("set_thinking_level.level 必须是字符串。");
					await send(success(id, "set_thinking_level", { level: options.setThinking(command.level) }));
					return;
				case "compact":
					if (options.session.isRunning) throw new Error("Agent 正在运行，不能压缩会话。");
					void options.session.compact(event).then(
						() => send(success(id, "compact")),
						(error: unknown) => send(failure(id, "compact", error)),
					);
					return;
				case "retry":
					await startRun(id, "retry", () => options.session.continue(event));
					return;
				case "permission_response":
					if (typeof command.requestId !== "string" || typeof command.approved !== "boolean") throw new Error("permission_response 需要 requestId 和 approved。");
					if (!options.approvals.respond(command.requestId, command.approved)) throw new Error("权限请求已结束或不存在。");
					await send(success(id, "permission_response"));
					return;
				case "shutdown":
					closing = true;
					options.approvals.dispose();
					options.session.abort();
					try {
						await options.session.waitForIdle();
					} catch (error) {
						if (!(error instanceof Error && error.name === "AbortError")) throw error;
					}
					await send(success(id, "shutdown"));
					settled.resolve();
					return;
				default:
					throw new Error("不支持的 RPC 命令 " + command.type);
			}
		} catch (error) {
			await send(failure(id, command.type, error));
		}
	};
	const schedule = (command: RpcCommand) => {
		const operation = handle(command);
		pendingCommands.add(operation);
		void operation.finally(() => pendingCommands.delete(operation));
	};

	const onData = (chunk: Buffer) => {
		buffered += decoder.write(chunk);
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) break;
			const line = buffered.slice(0, newline).replace(/\r$/, "");
			buffered = buffered.slice(newline + 1);
			if (!line.trim()) continue;
			try {
				const command = JSON.parse(line) as RpcCommand;
				if (!command || typeof command !== "object" || typeof command.type !== "string") throw new Error("RPC 记录需要字符串 type。");
				if (command.id !== undefined && typeof command.id !== "string" && typeof command.id !== "number") throw new Error("RPC id 必须是字符串或数字。");
				schedule(command);
			} catch (error) {
				void send({ type: "response", command: "parse", success: false, error: errorMessage(error) });
			}
		}
	};
	const onEnd = () => {
		closing = true;
		options.approvals.dispose();
		const trailing = buffered + decoder.end();
		if (trailing.trim()) {
			try {
				const command = JSON.parse(trailing) as RpcCommand;
				schedule(command);
			} catch (error) {
				void send({ type: "response", command: "parse", success: false, error: errorMessage(error) });
			}
		}
		void Promise.all([...pendingCommands])
			.then(() => options.session.waitForIdle())
			.finally(() => settled.resolve());
	};
	const onSignal = () => {
		closing = true;
		options.approvals.dispose();
		options.session.abort();
		void options.session.waitForIdle().finally(() => settled.resolve());
	};

	stdin.on("data", onData);
	stdin.once("end", onEnd);
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	await settled.promise;
	closing = true;
	stdin.off("data", onData);
	stdin.off("end", onEnd);
	process.off("SIGINT", onSignal);
	process.off("SIGTERM", onSignal);
	stopApprovalListener();
	await outputQueue;
	if (closing) stderr.write("Ti RPC 已关闭。\n");
}

function success(id: RpcId | undefined, command: string, data?: unknown) {
	return { ...(id === undefined ? {} : { id }), type: "response", command, success: true, ...(data === undefined ? {} : { data }) };
}

function failure(id: RpcId | undefined, command: string, error: unknown) {
	return { ...(id === undefined ? {} : { id }), type: "response", command, success: false, error: errorMessage(error) };
}
