import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { messageText } from "../agent/messages.ts";
import type { AssistantMessage, ChatMessage, ImageContent, TextContent, ToolCall, Usage } from "../agent/messages.ts";

interface SessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
}

interface Entry {
	type: string;
	id: string;
	parentId: string | null;
	name?: string;
	summary?: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	usage?: StoredUsage;
	message?: {
		role: string;
		content: string | StoredBlock[];
		timestamp: number;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		details?: unknown;
		structuredContent?: unknown;
		stopReason?: AssistantMessage["stopReason"];
		usage?: StoredUsage;
		requestOverhead?: number;
		error?: AssistantMessage["error"];
		errorMessage?: string;
	};
}

type StoredUsage = Usage & { totalTokens?: number; cacheWrite?: number };
type StoredMessage = ChatMessage & { id: string };
type StoredBlock = {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	argumentError?: string;
	data?: string;
	mimeType?: string;
};

export interface Compaction {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	usage?: Usage;
}

export interface Session {
	path: string;
	history: StoredMessage[];
	compactions: Array<Compaction & { historyLength: number }>;
	failedCompactionUsage: Usage[];
	title: string;
	modified: Date;
	leafId: string | null;
	initialContents?: string;
}

export class SessionStore {
	private directory: string;
	private legacyDirectories: string[];
	private cwd: string;

	constructor(home: string, legacyHomes: readonly string[], cwd: string) {
		const project = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		this.directory = join(home, "sessions", project);
		this.legacyDirectories = legacyHomes.map((legacyHome) => join(legacyHome, "sessions", project));
		this.cwd = cwd;
	}

	create(): Session {
		const id = randomUUID();
		const now = new Date();
		const timestamp = now.toISOString();
		const file = `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`;
		const header: SessionHeader = { type: "session", version: 3, id, timestamp, cwd: this.cwd };
		return {
			path: join(this.directory, file),
			history: [],
			compactions: [],
			failedCompactionUsage: [],
			title: id,
			modified: now,
			leafId: null,
			initialContents: JSON.stringify(header) + "\n",
		};
	}

	list(): Session[] {
		const files = new Map<string, string>();
		for (const directory of [...this.legacyDirectories, this.directory]) {
			let entries;
			try {
				entries = readdirSync(directory, { withFileTypes: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			for (const entry of entries) {
				if (entry.isFile() && entry.name.endsWith(".jsonl")) files.set(entry.name, join(directory, entry.name));
			}
		}
		return [...files.values()].map((file) => this.read(file))
			.filter((session) => session.history.length > 0)
			.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	}

	append(session: Session, message: ChatMessage): void {
		const id = randomUUID();
		this.appendEntry(session, { type: "message", id, parentId: session.leafId, message });
		if (session.history.length === 0 && message.role === "user") session.title = messageText(message);
		session.history.push({ ...message, id });
	}

	appendCompaction(session: Session, compaction: Compaction): void {
		this.appendEntry(session, { ...compaction, type: "compaction", id: randomUUID(), parentId: session.leafId });
		session.compactions.push({ ...compaction, historyLength: session.history.length });
	}

	appendCompactionUsage(session: Session, usage: Usage): void {
		this.appendEntry(session, { type: "compaction_usage", id: randomUUID(), parentId: session.leafId, usage });
		session.failedCompactionUsage.push(usage);
	}

	private appendEntry(session: Session, entry: Entry): void {
		const timestamp = new Date().toISOString();
		const line = JSON.stringify({ ...entry, timestamp }) + "\n";
		if (session.initialContents !== undefined) {
			mkdirSync(this.directory, { recursive: true });
			writeFileSync(session.path, session.initialContents + line, { flag: "wx", flush: true });
			session.initialContents = undefined;
		} else {
			const fd = openSync(session.path, constants.O_WRONLY | constants.O_APPEND);
			try {
				writeFileSync(fd, line);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		}
		session.leafId = entry.id;
		session.modified = new Date(timestamp);
	}

	private read(file: string): Session {
		const contents = readFileSync(file, "utf8").trim();
		const lines = contents.split(/\r?\n/);
		const header: SessionHeader = JSON.parse(lines[0]);
		if (header?.type !== "session" || typeof header.id !== "string") {
			throw new Error(`无法读取会话 ${basename(file)}`);
		}

		const entries = new Map<string, Entry>();
		let latest: Entry | undefined;
		let title: string | undefined;
		for (const line of lines.slice(1)) {
			if (!line.trim()) continue;
			const entry: Entry = JSON.parse(line);
			if (!entry?.id) throw new Error(`无法读取会话条目 ${basename(file)}`);
			if (entry.type === "session_info" && typeof entry.name === "string") title = entry.name;
			entries.set(entry.id, entry);
			latest = entry;
		}

		const chain: Entry[] = [];
		const visited = new Set<string>();
		for (let entry = latest; entry; entry = entry.parentId ? entries.get(entry.parentId) : undefined) {
			if (visited.has(entry.id)) throw new Error(`会话记录存在循环引用 ${basename(file)}`);
			visited.add(entry.id);
			chain.push(entry);
		}
		const history: Session["history"] = [];
		const compactions: Session["compactions"] = [];
		const failedCompactionUsage: Usage[] = [];
		const messageIds = new Set<string>();
		for (const entry of chain.reverse()) {
			if (entry.type === "compaction_usage" && entry.usage) failedCompactionUsage.push(entry.usage);
			if (entry.type === "compaction" && typeof entry.summary === "string" && entry.firstKeptEntryId
				&& messageIds.has(entry.firstKeptEntryId) && typeof entry.tokensBefore === "number") {
				compactions.push({
					summary: entry.summary, firstKeptEntryId: entry.firstKeptEntryId, tokensBefore: entry.tokensBefore,
					usage: readUsage(entry.usage), historyLength: history.length,
				});
			}
			const message = entry.type === "message" ? entry.message : undefined;
			if (message?.role !== "user" && message?.role !== "assistant" && message?.role !== "toolResult") continue;
			const blocks: StoredBlock[] = typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content;
			const { role, timestamp, stopReason, error, errorMessage } = message;
			const base = { id: entry.id, timestamp };
			if (role === "user") {
				history.push({ ...base, role, content: blocks.filter(isText) });
			} else if (role === "assistant") {
				history.push({ ...base, role, content: blocks.filter((block): block is TextContent | ToolCall => isText(block) || isCall(block)),
					stopReason: stopReason ?? "stop", usage: readUsage(message.usage), requestOverhead: message.requestOverhead, error, errorMessage });
			} else if (typeof message.toolCallId === "string" && typeof message.toolName === "string") {
				history.push({ ...base, role, toolCallId: message.toolCallId, toolName: message.toolName,
					isError: message.isError === true,
					...(message.details === undefined ? {} : { details: message.details }),
					...(message.structuredContent === undefined ? {} : { structuredContent: message.structuredContent }),
					content: blocks.filter((block): block is TextContent | ImageContent => isText(block) ||
						(block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string")) });
			} else continue;
			messageIds.add(entry.id);
		}
		const firstUser = history.find((message) => message.role === "user");
		return {
			path: join(this.directory, basename(file)),
			history,
			compactions,
			failedCompactionUsage,
			title: title || (firstUser && messageText(firstUser)) || header.id,
			modified: statSync(file).mtime,
			leafId: latest?.id ?? null,
			initialContents: dirname(file) === this.directory ? undefined : contents + "\n",
		};
	}
}

function isText(block: StoredBlock): block is TextContent {
	return block.type === "text" && typeof block.text === "string";
}

function isCall(block: StoredBlock): block is ToolCall {
	return block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string" &&
		!!block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments);
}

function readUsage(usage: StoredUsage | undefined): Usage | undefined {
	if (!usage) return;
	// Legacy usage with totalTokens excludes cached input from input. Ti stores the full prompt count.
	return {
		input: usage.totalTokens === undefined ? usage.input : usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
		output: usage.output,
		cacheRead: usage.cacheRead,
	};
}
