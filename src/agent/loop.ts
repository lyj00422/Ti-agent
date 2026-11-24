import { errorMessage, toolCalls } from "./messages.ts";
import type { AssistantMessage, ChatMessage, GenerationEvent, ToolCall, ToolResultMessage } from "./messages.ts";
import type { ToolRegistry } from "../tools/registry.ts";

export type AgentEvent = GenerationEvent
	| { type: "message_end"; message: ChatMessage }
	| { type: "tool_execution_start"; call: ToolCall };

const MAX_TOOL_BATCHES = 32;

export async function runAgentLoop(
	request: () => Promise<AssistantMessage>,
	registry: ToolRegistry | undefined,
	commit: (message: ChatMessage) => void,
	signal: AbortSignal,
	onEvent: (event: AgentEvent) => void,
): Promise<AssistantMessage> {
	const save = (message: ChatMessage) => {
		commit(message);
		onEvent({ type: "message_end", message });
	};
	for (let batch = 0; batch < MAX_TOOL_BATCHES && !signal.aborted; batch++) {
		const reply = await request();
		save(reply);
		if (reply.stopReason !== "toolUse") return reply;

		for (const call of toolCalls(reply)) {
			onEvent({ type: "tool_execution_start", call });
			let result: ToolResultMessage = {
				role: "toolResult", toolCallId: call.id, toolName: call.name,
				content: [], isError: false, timestamp: Date.now(),
			};
			const skipped = signal.aborted;
			try {
				if (skipped) throw new Error("操作已停止，此调用未执行。");
				if (!registry) throw new Error("此请求没有启用工具。");
				const output = await registry.execute(call, signal);
				result = { ...result, content: output.content, isError: output.isError === true };
			} catch (error) {
				const text = !skipped && signal.aborted
					? "操作已中止，结果可能不完整。请先核查现场。 " + errorMessage(error)
					: errorMessage(error);
				result = { ...result, isError: true, content: [{ type: "text", text }] };
			}
			save(result);
		}
	}

	const reply: AssistantMessage = {
		role: "assistant", content: [], timestamp: Date.now(),
		stopReason: signal.aborted ? "aborted" : "error",
		errorMessage: signal.aborted ? undefined : "达到本轮 32 批工具调用上限。",
	};
	save(reply);
	return reply;
}
