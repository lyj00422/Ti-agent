import { randomUUID } from "node:crypto";
import { appendFileSync, constants, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ChatMessage } from "./agent.ts";

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
	message?: {
		role: string;
		content: string | Array<{ type: string; text?: string }>;
		timestamp: number;
		stopReason?: ChatMessage["stopReason"];
		errorMessage?: string;
	};
}

export interface Session {
	path: string;
	history: ChatMessage[];
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
		const entry = {
			type: "message",
			id,
			parentId: session.leafId,
			timestamp: new Date().toISOString(),
			message: {
				role: message.role,
				content: message.text ? [{ type: "text", text: message.text }] : [],
				timestamp: message.timestamp,
				stopReason: message.stopReason,
				errorMessage: message.errorMessage,
			},
		};
		const line = JSON.stringify(entry) + "\n";
		if (session.initialContents !== undefined) {
			mkdirSync(this.directory, { recursive: true });
			writeFileSync(session.path, session.initialContents + line, { flag: "wx" });
			session.initialContents = undefined;
		} else {
			appendFileSync(session.path, line, { flag: constants.O_WRONLY | constants.O_APPEND });
		}
		if (session.history.length === 0 && message.role === "user") session.title = message.text;
		session.history.push(message);
		session.leafId = id;
		session.modified = new Date(entry.timestamp);
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

		const history: ChatMessage[] = [];
		const visited = new Set<string>();
		for (let entry = latest; entry; entry = entry.parentId ? entries.get(entry.parentId) : undefined) {
			if (visited.has(entry.id)) throw new Error(`会话记录存在循环引用 ${basename(file)}`);
			visited.add(entry.id);
			const message = entry.type === "message" ? entry.message : undefined;
			if (message?.role !== "user" && message?.role !== "assistant") continue;
			const text = typeof message.content === "string" ? message.content
				: message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
			const { role, timestamp, stopReason, errorMessage } = message;
			history.push({ role, text, timestamp, stopReason, errorMessage });
		}
		history.reverse();
		return {
			path: join(this.directory, basename(file)),
			history,
			title: title || history.find((message) => message.role === "user")?.text || header.id,
			modified: statSync(file).mtime,
			leafId: latest?.id ?? null,
			initialContents: dirname(file) === this.directory ? undefined : contents + "\n",
		};
	}
}
