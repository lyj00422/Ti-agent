import { randomUUID } from "node:crypto";

export interface ToolApprovalRequest {
	id: string;
	toolName: string;
	input: Record<string, unknown>;
	parentToolCallId?: string;
}

export type ToolApprovalHandler = (request: ToolApprovalRequest, signal: AbortSignal) => Promise<boolean>;

export class ToolApprovalBroker {
	private readonly pending = new Map<string, { request: ToolApprovalRequest; resolve: (approved: boolean) => void; removeAbort: () => void }>();
	private readonly listeners = new Set<(request: ToolApprovalRequest) => void>();
	private readonly queue: string[] = [];
	private active?: string;
	private disposed = false;

	request: ToolApprovalHandler = (request, signal) => {
		signal.throwIfAborted();
		if (this.disposed) return Promise.resolve(false);
		const id = randomUUID();
		const approval = { ...request, id };
		return new Promise((resolve) => {
			const abort = () => this.remove(id);
			this.pending.set(id, { request: approval, resolve, removeAbort: () => signal.removeEventListener("abort", abort) });
			signal.addEventListener("abort", abort, { once: true });
			this.queue.push(id);
			this.dispatch();
		});
	};

	subscribe(listener: (request: ToolApprovalRequest) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	respond(id: string, approved: boolean): boolean {
		const pending = this.pending.get(id);
		if (!pending) return false;
		this.pending.delete(id);
		pending.removeAbort();
		if (this.active === id) this.active = undefined;
		pending.resolve(approved);
		this.dispatch();
		return true;
	}

	dispose(): void {
		this.disposed = true;
		this.queue.length = 0;
		this.active = undefined;
		for (const pending of this.pending.values()) {
			pending.removeAbort();
			pending.resolve(false);
		}
		this.pending.clear();
		this.listeners.clear();
	}

	private remove(id: string): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		pending.removeAbort();
		const index = this.queue.indexOf(id);
		if (index >= 0) this.queue.splice(index, 1);
		if (this.active === id) this.active = undefined;
		pending.resolve(false);
		this.dispatch();
	}

	private dispatch(): void {
		if (this.disposed || this.active) return;
		const id = this.queue.shift();
		if (!id) return;
		const pending = this.pending.get(id);
		if (!pending) return this.dispatch();
		if (this.listeners.size === 0) return void this.respond(id, false);
		this.active = id;
		for (const listener of this.listeners) listener(pending.request);
	}
}
