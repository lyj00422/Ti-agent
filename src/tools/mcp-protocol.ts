import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

type RpcId = number | string;
type RpcMessage = { jsonrpc: "2.0"; id?: RpcId; method: string; params?: object };
type RpcResponse = { id: RpcId; result?: unknown; error?: { code: number; message: string } };

interface Transport {
	send(message: RpcMessage, signal: AbortSignal): Promise<RpcResponse | undefined>;
	setProtocolVersion?(version: string): void;
	close(): Promise<void>;
}

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export class McpClient {
	private nextId = 0;
	private readonly lifetime = new AbortController();
	private readonly transport: Transport;
	private readonly timeoutMs: number;

	constructor(transport: Transport, timeoutMs: number) {
		this.transport = transport;
		this.timeoutMs = timeoutMs;
	}

	async initialize(signal?: AbortSignal): Promise<boolean> {
		const result = await this.request<{ protocolVersion: string; capabilities: { tools?: object } }>("initialize", {
			protocolVersion: PROTOCOL_VERSIONS[0],
			capabilities: {},
			clientInfo: { name: "Ti", version: "0.1.0" },
		}, signal);
		if (!PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
			throw new Error(`MCP 协议版本不受支持 ${result.protocolVersion}`);
		}
		this.transport.setProtocolVersion?.(result.protocolVersion);
		await this.notify("notifications/initialized", undefined, signal);
		return result.capabilities.tools !== undefined;
	}

	async request<Result>(method: string, params?: object, signal?: AbortSignal): Promise<Result> {
		const id = ++this.nextId;
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const requestSignal = AbortSignal.any([this.lifetime.signal, timeout, ...(signal ? [signal] : [])]);
		requestSignal.throwIfAborted();
		let response: RpcResponse | undefined;
		try {
			response = await this.transport.send({ jsonrpc: "2.0", id, method, params }, requestSignal);
		} catch (error) {
			if (!this.lifetime.signal.aborted && (timeout.aborted || signal?.aborted) && method !== "initialize") {
				void this.notify("notifications/cancelled", { requestId: id }).catch((error) => {
					if (!this.lifetime.signal.aborted) process.emitWarning(`MCP 取消通知发送失败 · ${String(error)}`);
				});
			}
			if (signal?.aborted) signal.throwIfAborted();
			if (timeout.aborted && !this.lifetime.signal.aborted) {
				throw new DOMException(`MCP 请求超时 ${method}`, "McpTimeoutError");
			}
			throw error;
		}
		if (response?.id !== id) throw new Error(`MCP 未返回对应的响应 ${method}`);
		if (response.error) throw new Error(`MCP ${response.error.code} · ${response.error.message}`);
		if (!("result" in response)) throw new Error(`MCP 响应缺少结果 ${method}`);
		return response.result as Result;
	}

	async close(): Promise<void> {
		this.lifetime.abort();
		await this.transport.close();
	}

	private async notify(method: string, params?: object, signal?: AbortSignal): Promise<void> {
		const signals = [this.lifetime.signal, AbortSignal.timeout(this.timeoutMs)];
		if (signal) signals.push(signal);
		await this.transport.send({ jsonrpc: "2.0", method, params }, AbortSignal.any(signals));
	}
}

export function stdioTransport(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Transport {
	const grouped = process.platform !== "win32";
	const child = spawn(command, args, {
		cwd, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, detached: grouped,
	});
	const pending = new Map<RpcId, ReturnType<typeof Promise.withResolvers<RpcResponse>>>();
	const finished = Promise.withResolvers<void>();
	let failure: Error | undefined;
	const fail = (error: Error) => {
		failure ??= error;
		for (const { reject } of pending.values()) reject(failure);
	};
	child.on("error", fail);
	child.stdin.on("error", fail);
	child.once("close", (code) => {
		fail(new Error(`MCP 子进程已退出（${code ?? "信号终止"}）`));
		finished.resolve();
	});
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	lines.on("error", fail);
	lines.on("line", (line) => {
		if (!line.trim()) return;
		let message: RpcResponse;
		try {
			message = JSON.parse(line) as RpcResponse;
		} catch (error) {
			fail(new Error("MCP stdio 返回了无效的 JSON。", { cause: error }));
			return;
		}
		pending.get(message.id)?.resolve(message);
	});
	return {
		async send(message, signal) {
			if (failure) throw failure;
			signal.throwIfAborted();
			const line = JSON.stringify(message) + "\n";
			const { id } = message;
			if (id === undefined) {
				child.stdin.write(line);
				return;
			}
			const response = Promise.withResolvers<RpcResponse>();
			pending.set(id, response);
			const abort = () => response.reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			try {
				child.stdin.write(line);
				return await response.promise;
			} finally {
				signal.removeEventListener("abort", abort);
				pending.delete(id);
			}
		},
		async close() {
			child.stdin.end();
			const stopped = await Promise.race([finished.promise.then(() => true), delay(500, false, { ref: false })]);
			if (!stopped) {
				if (grouped && child.pid) {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
					}
				} else {
					child.kill();
				}
				await finished.promise;
			}
		},
	};
}

export function httpTransport(url: string, headers: Headers, timeoutMs: number): Transport {
	headers.set("Accept", "application/json, text/event-stream");
	headers.set("Content-Type", "application/json");
	return {
		async send(message, signal) {
			const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(message), signal });
			const session = response.headers.get("Mcp-Session-Id");
			if (session) headers.set("Mcp-Session-Id", session);
			if (!response.ok || message.id === undefined) {
				await response.body?.cancel();
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return;
			}
			if (response.headers.get("Content-Type")?.startsWith("text/event-stream")) {
				return readEventResponse(response.body!, message.id);
			}
			return await response.json() as RpcResponse;
		},
		setProtocolVersion(version) {
			headers.set("Mcp-Protocol-Version", version);
		},
		async close() {
			if (!headers.has("Mcp-Session-Id")) return;
			const response = await fetch(url, { method: "DELETE", headers, signal: AbortSignal.timeout(timeoutMs) });
			await response.body?.cancel();
			if (!response.ok && response.status !== 405 && response.status !== 404) throw new Error(`HTTP ${response.status}`);
		},
	};
}

async function readEventResponse(body: NonNullable<Response["body"]>, id: RpcId): Promise<RpcResponse | undefined> {
	let buffer = "";
	let data: string[] = [];
	for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
		buffer += chunk;
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop()!;
		for (const line of lines) {
			if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
			if (line === "" && data.length) {
				const message = JSON.parse(data.join("\n")) as RpcResponse;
				if (message.id === id) return message;
				data = [];
			}
		}
	}
}
