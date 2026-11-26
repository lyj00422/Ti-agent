import { toolCalls } from "./messages.ts";
import type { AssistantMessage, ChatMessage, ToolCall, ToolResultMessage } from "./messages.ts";
import type { ToolExecutionResult, ToolExecutorSnapshot } from "./contracts.ts";

export type AgentEvent =
	| { type: "agent_start" | "agent_end" | "turn_start" }
	| { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: ChatMessage }
	| { type: "message_update"; event: { type: "text_delta"; text: string } | { type: "usage"; usage: NonNullable<AssistantMessage["usage"]> } }
	| { type: "message_end"; message: ChatMessage }
	| { type: "tool_execution_start"; call: ToolCall }
	| { type: "tool_execution_update"; call: ToolCall; partialResult: ToolExecutionResult }
	| { type: "tool_execution_end"; call: ToolCall; result: ToolResultMessage };

export interface AgentRunOptions {
	initialMessage?: ChatMessage;
	request: (signal: AbortSignal) => Promise<{ reply: AssistantMessage; tools?: ToolExecutorSnapshot }>;
	commit: (message: ChatMessage) => void;
	signal?: AbortSignal;
	finishTurn?: (message: AssistantMessage, signal: AbortSignal) => Promise<"continue" | "end" | undefined>;
}

/** Runs model turns, schedules tool calls, and coordinates queued steering and follow-up input. */
export class Agent {
	private active?: { controller: AbortController; finished: Promise<AssistantMessage> };
	private readonly steering: string[] = [];
	private readonly followUps: string[] = [];
	private readonly listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
	private pendingEvents: Promise<void> = Promise.resolve();

	get isRunning(): boolean {
		return Boolean(this.active);
	}

	subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async publishUpdate(event: Extract<AgentEvent, { type: "message_update" }>): Promise<void> {
		await this.publish(event);
	}

	steer(text: string): "queued" {
		this.steering.push(text);
		return "queued";
	}

	followUp(text: string): "queued" {
		this.followUps.push(text);
		return "queued";
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = this.steering.splice(0);
		const followUp = this.followUps.splice(0);
		return { steering, followUp };
	}

	get pendingMessageCount(): number {
		return this.steering.length + this.followUps.length;
	}

	abort(): void {
		this.active?.controller.abort();
	}

	async waitForIdle(): Promise<void> {
		await this.active?.finished;
	}

	async run(options: AgentRunOptions): Promise<AssistantMessage> {
		if (this.active) throw new Error("Agent 正在运行。");
		const controller = new AbortController();
		const abort = () => controller.abort(options.signal?.reason);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		const finished = this.runLoop(options, controller.signal).finally(() => {
			options.signal?.removeEventListener("abort", abort);
			this.active = undefined;
		});
		this.active = { controller, finished };
		return finished;
	}

	private async runLoop(options: AgentRunOptions, signal: AbortSignal): Promise<AssistantMessage> {
		await this.emit({ type: "agent_start" });
		let last: AssistantMessage | undefined;
		try {
			if (options.initialMessage) await this.publishMessage(options.initialMessage, options.commit);
			while (!signal.aborted) {
				await this.emit({ type: "turn_start" });
				const { reply, tools } = await options.request(signal);
				await this.pendingEvents;
				last = reply;
				await this.publishMessage(reply, options.commit);
				const results = reply.stopReason === "toolUse" ? await this.executeTools(reply, tools, signal, options.commit) : [];
				await this.emit({ type: "turn_end", message: reply, toolResults: results });
				if (signal.aborted || reply.stopReason === "error" || reply.stopReason === "aborted") break;
				const decision = await options.finishTurn?.(reply, signal);
				if (decision === "end") break;
				if (results.length > 0 && results.every((result) => result.terminate)) break;
				const queued = this.steering.shift()
					?? (reply.stopReason === "toolUse" ? undefined : this.followUps.shift());
				if (queued !== undefined) {
					await this.publishMessage({ role: "user", content: [{ type: "text", text: queued }], timestamp: Date.now() }, options.commit);
					continue;
				}
				if (decision !== "continue" && reply.stopReason !== "toolUse") break;
			}
			if (!last || (signal.aborted && last.stopReason !== "aborted")) {
				last = { role: "assistant", content: [], timestamp: Date.now(), stopReason: signal.aborted ? "aborted" : "error" };
				await this.publishMessage(last, options.commit);
			}
			return last;
		} finally {
			await this.pendingEvents;
			await this.emit({ type: "agent_end" });
		}
	}

	private async executeTools(
		message: AssistantMessage,
		tools: ToolExecutorSnapshot | undefined,
		signal: AbortSignal,
		commit: (message: ChatMessage) => void,
	): Promise<ToolResultMessage[]> {
		const calls = toolCalls(message);
		const execute = async (call: ToolCall): Promise<ToolResultMessage> => {
			const base: ToolResultMessage = { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [], isError: false, timestamp: Date.now() };
			let result: ToolResultMessage;
			try {
				if (signal.aborted) throw new Error("操作已停止，此调用未执行。");
				if (!tools) throw new Error("此请求没有启用工具。");
				const output = await tools.execute(call, signal, (partialResult) => {
					void this.publish({ type: "tool_execution_update", call, partialResult });
				});
					result = { ...base, ...output, isError: output.isError === true };
			} catch (error) {
				result = { ...base, isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
			}
			await this.pendingEvents;
			await this.emit({ type: "tool_execution_end", call, result });
			return result;
		};
		const results: ToolResultMessage[] = [];
		if (tools?.executionMode === "sequential") {
			for (const call of calls) {
				await this.emit({ type: "tool_execution_start", call });
				results.push(await execute(call));
			}
		} else {
			for (const call of calls) await this.emit({ type: "tool_execution_start", call });
			results.push(...await Promise.all(calls.map(execute)));
		}
		for (const result of results) await this.publishMessage(result, commit);
		return results;
	}

	private async publishMessage(message: ChatMessage, commit: (message: ChatMessage) => void): Promise<void> {
		await this.emit({ type: "message_start", message });
		commit(message);
		await this.emit({ type: "message_end", message });
	}

	private async emit(event: AgentEvent): Promise<void> {
		for (const listener of this.listeners) await listener(event);
	}

	private async publish(event: AgentEvent): Promise<void> {
		this.pendingEvents = this.pendingEvents.then(() => this.emit(event));
		await this.pendingEvents;
	}
}
