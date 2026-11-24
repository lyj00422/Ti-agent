import { stdin, stdout } from "node:process";
import { createInterface, emitKeypressEvents } from "node:readline";
import { Writable } from "node:stream";
import { stripVTControlCharacters, styleText } from "node:util";
import type { Session, SessionStore } from "./sessions.ts";

interface TerminalChatOptions {
	model: string;
	sessions: SessionStore;
	send: (session: Session, text: string, onDelta: (text: string) => void, signal: AbortSignal) => Promise<void>;
	login: (key: string) => void;
}

export async function startTerminalChat(options: TerminalChatOptions): Promise<void> {
	if (stdin.isTTY && stdout.isTTY) {
		await startPiStyleTerminalChat(options);
		return;
	}
	await startReadlineChat(options);
}

async function startReadlineChat(options: TerminalChatOptions): Promise<void> {
	let session = options.sessions.list()[0] ?? options.sessions.create();
	let hidden = false;
	const terminal = Boolean(stdin.isTTY && stdout.isTTY);
	const output = new Writable({
		write(chunk, _encoding, callback) {
			if (hidden) callback();
			else stdout.write(chunk, callback);
		},
	});
	Object.defineProperty(output, "columns", { get: () => stdout.columns });

	const input = createInterface({ input: stdin, output, terminal, historySize: 0 });
	const exiting = new AbortController();
	const close = () => {
		exiting.abort();
		input.close();
	};
	input.on("SIGINT", close);
	process.on("SIGINT", close);

	let picker: Session[] | undefined;
	let multiline: string[] = [];
	let loginPending = false;
	// Readline can emit more than one line in the same input chunk.
	input.on("line", (line) => {
		if (!picker && !multiline.length && line.trim() === "/login") hidden = true;
	});

	const write = (text: string) => stdout.write(text);
	const errorLine = (message: string) => write(styleText("red", display(message)) + "\n");
	const showHistory = () => {
		for (const message of session.history) {
			if (message.text) write(`${message.role === "user" ? "你" : "Ti"}> ${display(message.text)}\n`);
			if (message.stopReason === "error" && message.errorMessage) {
				errorLine("请求失败  " + message.errorMessage);
			}
		}
	};
	const prompt = () => {
		if (terminal && !hidden && !exiting.signal.aborted) {
			input.setPrompt(picker ? "编号> " : multiline.length ? "… " : "你> ");
			input.prompt();
		}
	};

	try {
		write(`Ti · ${options.model} · /new 新会话 · /resume 切换 · /login 登录 · /exit 退出\n`);
		showHistory();
		prompt();
		for await (const line of input) {
			if (exiting.signal.aborted) break;
			const command = line.trim();
			if (!loginPending && command === "/exit") break;
			try {
				if (loginPending) {
					loginPending = false;
					hidden = false;
					write("\n");
					if (command) {
						options.login(line);
						write("DeepSeek API Key 已保存。\n");
					}
				} else if (picker) {
					if (command) {
						const selected = /^\d+$/.test(command) ? picker[Number(command) - 1] : undefined;
						if (!selected) throw new Error("请输入列表中的编号，或直接回车取消。");
						session = selected;
						write("已恢复会话\n");
						showHistory();
					}
					picker = undefined;
				} else if (!multiline.length && command === "/login") {
					loginPending = true;
					hidden = true;
					write("DeepSeek API Key（输入隐藏，直接回车取消）> ");
				} else if (!multiline.length && command === "/new") {
					session = options.sessions.create();
					write("已创建新会话\n");
				} else if (!multiline.length && command === "/resume") {
					const sessions = options.sessions.list();
					if (sessions.length) {
						picker = sessions;
						for (const [index, item] of sessions.entries()) {
							const title = display(item.title).replace(/\s+/g, " ").slice(0, 72);
							write(`${index + 1}. ${title}  ·  ${item.modified.toLocaleString()}  ·  ${item.history.length} 条消息\n`);
						}
						write("选择要恢复的会话，直接回车取消\n");
					} else {
						write("没有可恢复的会话。\n");
					}
				} else if (line.endsWith("\\")) {
					multiline.push(line.slice(0, -1));
				} else {
					const text = [...multiline, line].join("\n").trim();
					multiline = [];
					if (text) {
						write("Ti> ");
						try {
							await options.send(session, text, (delta) => write(display(delta)), exiting.signal);
						} finally {
							write("\n");
						}
					}
				}
			} catch (error) {
				if (!exiting.signal.aborted) errorLine("请求失败  " + (error instanceof Error ? error.message : String(error)));
			}
			prompt();
		}
	} finally {
		close();
		process.off("SIGINT", close);
	}
}

async function startPiStyleTerminalChat(options: TerminalChatOptions): Promise<void> {
	return new Promise((resolve) => {
		let session = options.sessions.list()[0] ?? options.sessions.create();
		let mode: "chat" | "login" | "resume" = "chat";
		let picker: Session[] = [];
		let selectedSession = 0;
		let draft = "";
		let cursor = 0;
		let streamText = "";
		let busy = false;
		let notice = "";
		let noticeIsError = false;
		let spinnerFrame = 0;
		let scrollOffset = 0;
		let closed = false;
		const abort = new AbortController();
		const spinner = ["·", "··", "···", "··"];
		let previousScreen: string[] | undefined;

		const render = () => {
			if (closed) return;
			const width = Math.max(24, stdout.columns || 80);
			const height = Math.max(10, stdout.rows || 24);
			const lines: string[] = [];
			lines.push(` ${piStyle(["red", "bold"], "T")}${piStyle(["yellow", "bold"], "i")}  ${piStyle("dim", "DeepSeek conversation")}`);
			lines.push(piStyle("magenta", "─".repeat(width)));

			const transcript: string[] = [];
			for (const message of session.history) {
				if (transcript.length > 0) transcript.push("");
				if (message.role === "user") {
					for (const line of wrapTerminalText(message.text, width - 4)) {
						transcript.push(piStyle(["bgBlue", "whiteBright"], padTerminalText(`  ${line}  `, width)));
					}
				} else if (message.text) {
					transcript.push(...renderAssistantText(message.text, width - 2));
				}
				if (message.stopReason === "error" && message.errorMessage) {
					transcript.push(piStyle("red", `  Error: ${safeTerminalText(message.errorMessage)}`));
				}
			}
			if (streamText) transcript.push(...renderAssistantText(streamText, width - 2));
			if (mode === "resume") {
				transcript.push("");
				transcript.push(piStyle("yellow", "Resume session"));
				for (const [index, item] of picker.entries()) {
					const title = safeTerminalText(item.title).replace(/\s+/g, " ").slice(0, Math.max(8, width - 34));
					const prefix = index === selectedSession ? piStyle("magenta", "› ") : "  ";
					const detail = piStyle("dim", `${item.modified.toLocaleString()} · ${item.history.length} messages`);
					transcript.push(`${prefix}${index === selectedSession ? piStyle("magenta", title) : title}  ${detail}`);
				}
			}
			if (notice) transcript.push(piStyle(noticeIsError ? "red" : "dim", `  ${safeTerminalText(notice)}`));

			const prompt = mode === "login" ? "Key> " : "› ";
			const draftLayout = layoutTerminalDraft(draft, cursor, Math.max(1, width - 4), mode === "login");
			const hiddenInputRows = Math.max(0, draftLayout.lines.length - Math.max(1, height - 7));
			const inputRows = draftLayout.lines.map((line, index) => {
				const prefix = index === 0 ? prompt : "  ";
				return prefix + line;
			}).slice(hiddenInputRows);
			const editorBorder = busy
				? `${piStyle("magenta", "── ")}${piStyle("dim", `${spinner[spinnerFrame]} Working`)}${piStyle("magenta", ` ${"─".repeat(Math.max(1, width - 14))}`)}`
				: piStyle("magenta", "─".repeat(width));

			const footerLeft = piStyle("dim", shortenTerminalText(process.cwd(), Math.max(8, Math.floor(width * 0.55))));
			const footerRight = piStyle("magenta", options.model);
			const footer = `${footerLeft}${" ".repeat(Math.max(1, width - terminalWidth(footerLeft) - terminalWidth(footerRight)))}${footerRight}`;
			const hints = mode === "login"
				? "Enter save · Esc cancel"
				: mode === "resume"
					? "↑↓ select · Enter resume · Esc cancel"
					: "/login key · /new session · /resume switch · /exit quit · Ctrl+J newline";

			const transcriptRows = Math.max(1, height - inputRows.length - 5);
			const transcriptEnd = Math.max(0, transcript.length - scrollOffset);
			const visibleTranscript = transcript.slice(Math.max(0, transcriptEnd - transcriptRows), transcriptEnd);
			lines.push(...Array.from({ length: transcriptRows - visibleTranscript.length }, () => ""));
			lines.push(...visibleTranscript);
			lines.push(editorBorder);
			lines.push(...inputRows);
			lines.push(footer);
			lines.push(piStyle("dim", shortenTerminalText(hints, width)));
			const screen = lines.slice(0, height);
			while (screen.length < height) screen.push("");
			const cursorRow = Math.min(height, 4 + transcriptRows + Math.max(0, draftLayout.cursorRow - hiddenInputRows));
			const cursorColumn = Math.min(width, prompt.length + draftLayout.cursorColumn + 1);
			let frame = "";
			if (!previousScreen || previousScreen.length !== screen.length) {
				frame = `\x1b[H\x1b[2J${screen.join("\r\n")}`;
			} else {
				for (let row = 0; row < screen.length; row++) {
					if (screen[row] !== previousScreen[row]) frame += `\x1b[${row + 1};1H${screen[row]}\x1b[K`;
				}
			}
			previousScreen = screen;
			stdout.write(`${frame}\x1b[${cursorRow};${cursorColumn}H\x1b[?25h`);
		};

		const setMode = (next: typeof mode) => {
			mode = next;
			draft = "";
			cursor = 0;
			notice = "";
			render();
		};

		const close = () => {
			if (closed) return;
			closed = true;
			abort.abort();
			clearInterval(spinnerTimer);
			stdin.off("keypress", onKeypress);
			stdin.off("end", close);
			stdout.off("resize", render);
			process.off("SIGTERM", close);
			if (stdin.isTTY) stdin.setRawMode(false);
			stdin.pause();
			stdout.write("\x1b[?25h\x1b[?1049l");
			resolve();
		};

		const submit = () => {
			const text = draft.trim();
			if (mode === "login") {
				if (!text) {
					setMode("chat");
					return;
				}
				try {
					options.login(draft);
					setMode("chat");
					notice = "DeepSeek API Key saved";
					noticeIsError = false;
					render();
				} catch (error) {
					mode = "chat";
					draft = "";
					cursor = 0;
					notice = error instanceof Error ? error.message : String(error);
					noticeIsError = true;
					render();
				}
				return;
			}
			if (mode === "resume") {
				if (picker[selectedSession]) {
					session = picker[selectedSession];
				}
				setMode("chat");
				notice = "Session resumed";
				noticeIsError = false;
				render();
				return;
			}
			if (!text) {
				render();
				return;
			}
			if (text === "/exit") {
				close();
				return;
			}
			if (text === "/new") {
				session = options.sessions.create();
				notice = "New session";
				noticeIsError = false;
				draft = "";
				cursor = 0;
				render();
				return;
			}
			if (text === "/resume") {
				picker = options.sessions.list();
				if (picker.length === 0) {
					notice = "No sessions to resume";
					noticeIsError = false;
					render();
					return;
				}
				selectedSession = 0;
				setMode("resume");
				return;
			}
			if (text === "/login") {
				setMode("login");
				return;
			}
			if (busy) return;

			draft = "";
			cursor = 0;
			streamText = "";
			busy = true;
			scrollOffset = 0;
			notice = "";
			const request = options.send(session, text, (delta) => {
				streamText += delta;
				render();
			}, abort.signal);
			render();
			void request.then(() => {
				busy = false;
				streamText = "";
				render();
			}).catch((error: unknown) => {
				busy = false;
				streamText = "";
				const assistant = session.history.at(-1);
				notice = assistant?.role === "assistant" && assistant.stopReason === "error"
					? ""
					: error instanceof Error ? error.message : String(error);
				noticeIsError = Boolean(notice);
				render();
			});
		};

		const onKeypress = (char: string | undefined, key: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean }) => {
			if (closed) return;
			if (key.ctrl && key.name === "c") {
				close();
				return;
			}
			if (busy && mode === "chat") return;
			if (mode === "resume" && !busy) {
				if (key.name === "escape") {
					setMode("chat");
					return;
				}
				if (key.name === "up") selectedSession = (selectedSession + picker.length - 1) % picker.length;
				else if (key.name === "down") selectedSession = (selectedSession + 1) % picker.length;
				else if (key.name === "return" || key.name === "enter") {
					submit();
					return;
				} else if (char && /^\d$/.test(char)) {
					const index = Number(char) - 1;
					if (picker[index]) selectedSession = index;
				}
				render();
				return;
			}
			if (mode === "login" && key.name === "escape") {
				setMode("chat");
				return;
			}
			if (mode === "chat" && (key.sequence === "\n" || key.name === "enter" || (key.ctrl && key.name === "j"))) {
				draft = draft.slice(0, cursor) + "\n" + draft.slice(cursor);
				cursor++;
				render();
				return;
			}
			if (key.name === "return" || key.name === "enter") {
				submit();
				return;
			}
			if (busy) return;
			if (key.name === "left") cursor = previousCharacterOffset(draft, cursor);
			else if (key.name === "right") cursor = nextCharacterOffset(draft, cursor);
			else if ((key.name === "up" || key.name === "down") && draft.length === 0) {
				scrollOffset = Math.max(0, Math.min(transcript.length, scrollOffset + (key.name === "up" ? 3 : -3)));
				render();
				return;
			} else if (key.name === "up") cursor = moveTerminalCursorVertically(draft, cursor, -1);
			else if (key.name === "down") cursor = moveTerminalCursorVertically(draft, cursor, 1);
			else if (key.name === "home") cursor = draft.lastIndexOf("\n", cursor - 1) + 1;
			else if (key.name === "end") {
				const newline = draft.indexOf("\n", cursor);
				cursor = newline === -1 ? draft.length : newline;
			} else if (key.name === "backspace" && cursor > 0) {
				const previous = previousCharacterOffset(draft, cursor);
				draft = draft.slice(0, previous) + draft.slice(cursor);
				cursor = previous;
			} else if (key.name === "delete" && cursor < draft.length) {
				draft = draft.slice(0, cursor) + draft.slice(nextCharacterOffset(draft, cursor));
			} else if (char && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(char)) {
				draft = draft.slice(0, cursor) + char + draft.slice(cursor);
				cursor += char.length;
			} else {
				return;
			}
			render();
		};

		const spinnerTimer = setInterval(() => {
			if (busy) {
				spinnerFrame = (spinnerFrame + 1) % spinner.length;
				render();
			}
		}, 500);
		emitKeypressEvents(stdin);
		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("keypress", onKeypress);
		stdin.once("end", close);
		stdout.on("resize", render);
		process.once("SIGTERM", close);
		stdout.write("\x1b[?1049h\x1b[?25l");
		render();
	});
}

function renderAssistantText(text: string, width: number): string[] {
	const output: string[] = [];
	let inCodeBlock = false;
	for (const source of text.split("\n")) {
		if (source.trimStart().startsWith("```")) {
			inCodeBlock = !inCodeBlock;
			output.push(piStyle("dim", `  ${"─".repeat(Math.max(1, width - 4))}`));
			continue;
		}
		if (inCodeBlock) {
			output.push(...wrapTerminalText(source, width - 4).map((line) => `  ${piStyle("green", line)}`));
			continue;
		}
		const heading = source.match(/^\s{0,3}(#{1,3})\s+(.*)$/);
		const quote = source.match(/^\s{0,3}>\s?(.*)$/);
		const bullet = source.match(/^\s{0,3}([-*+] |\d+\. )(.*)$/);
		if (heading) {
			output.push(...wrapTerminalText(heading[2], width - 2).map((line) => `  ${piStyle(["yellow", "bold"], line)}`));
		} else if (quote) {
			output.push(...wrapTerminalText(quote[1], width - 4).map((line) => `  ${piStyle("dim", `│ ${line}`)}`));
		} else if (bullet) {
			const marker = bullet[1];
			const parts = wrapTerminalText(bullet[2], width - 4);
			output.push(`  ${piStyle("magenta", marker)}${styleInlineMarkdown(parts[0] ?? "")}`);
			for (const line of parts.slice(1)) output.push(`  ${styleInlineMarkdown(line)}`);
		} else if (source.trim()) {
			output.push(...wrapTerminalText(source.trim(), width - 2).map((line) => `  ${styleInlineMarkdown(line)}`));
		} else {
			output.push("");
		}
	}
	return output;
}

function styleInlineMarkdown(text: string): string {
	return text
		.replace(/`([^`]+)`/g, (_match, code: string) => piStyle("magenta", code))
		.replace(/\*\*([^*]+)\*\*/g, (_match, bold: string) => piStyle("bold", bold));
}

function piStyle(styles: string | string[], text: string): string {
	if (process.env.NO_COLOR !== undefined || process.env.NODE_DISABLE_COLORS !== undefined) return text;
	const colors: Record<string, string> = {
		red: "38;2;228;138;122",
		yellow: "38;2;234;182;93",
		magenta: "38;2;189;112;201",
		green: "38;2;105;205;157",
		dim: "38;2;130;132;143",
		whiteBright: "38;2;228;229;235",
		bgBlue: "48;2;37;42;86",
		bold: "1",
	};
	const sequence = (Array.isArray(styles) ? styles : [styles]).map((style) => colors[style]).filter(Boolean).join(";");
	return sequence ? `\x1b[${sequence}m${text}\x1b[0m` : text;
}

function layoutTerminalDraft(
	text: string,
	cursor: number,
	width: number,
	hidden: boolean,
): { lines: string[]; cursorRow: number; cursorColumn: number } {
	const lines = [""];
	let row = 0;
	let column = 0;
	let cursorRow = 0;
	let cursorColumn = 0;
	let offset = 0;
	let positioned = false;
	while (offset < text.length) {
		if (offset === cursor) {
			cursorRow = row;
			cursorColumn = column;
			positioned = true;
		}
		const point = String.fromCodePoint(text.codePointAt(offset)!);
		if (point === "\n") {
			lines.push("");
			row++;
			column = 0;
			offset++;
			continue;
		}
		const cellWidth = terminalCharacterWidth(point);
		if (column > 0 && column + cellWidth > width) {
			lines.push("");
			row++;
			column = 0;
		}
		lines[row] += hidden ? "*" : point;
		column += hidden ? 1 : cellWidth;
		offset += point.length;
	}
	if (!positioned) {
		cursorRow = row;
		cursorColumn = column;
	}
	return { lines, cursorRow, cursorColumn };
}

function wrapTerminalText(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const source of safeTerminalText(text).split("\n")) {
		let line = "";
		let cells = 0;
		for (const point of source) {
			const pointWidth = terminalCharacterWidth(point);
			if (cells > 0 && cells + pointWidth > width) {
				lines.push(line);
				line = "";
				cells = 0;
			}
			line += point;
			cells += pointWidth;
		}
		lines.push(line);
	}
	return lines;
}

function terminalCharacterWidth(point: string): number {
	const code = point.codePointAt(0)!;
	if (code === 0 || code < 32 || (code >= 0x300 && code <= 0x36f)) return 0;
	return code >= 0x1100 && (
		code <= 0x115f || code === 0x2329 || code === 0x232a ||
		(code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) || (code >= 0x1f300 && code <= 0x1faff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	) ? 2 : 1;
}

function padTerminalText(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - terminalWidth(text)));
}

function terminalWidth(text: string): number {
	return Array.from(stripVTControlCharacters(text)).reduce((width, point) => width + terminalCharacterWidth(point), 0);
}

function shortenTerminalText(text: string, width: number): string {
	const safe = safeTerminalText(text);
	if (terminalWidth(safe) <= width) return safe;
	return `…${Array.from(safe).slice(-(width - 1)).join("")}`;
}

function previousCharacterOffset(text: string, offset: number): number {
	const previous = text.charCodeAt(offset - 1);
	return previous >= 0xdc00 && previous <= 0xdfff ? offset - 2 : offset - 1;
}

function nextCharacterOffset(text: string, offset: number): number {
	const current = text.charCodeAt(offset);
	return current >= 0xd800 && current <= 0xdbff ? offset + 2 : offset + 1;
}

function moveTerminalCursorVertically(text: string, cursor: number, direction: -1 | 1): number {
	const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
	const column = cursor - lineStart;
	if (direction < 0) {
		if (lineStart === 0) return cursor;
		const previousEnd = lineStart - 1;
		const previousStart = text.lastIndexOf("\n", previousEnd - 1) + 1;
		return Math.min(previousStart + column, previousEnd);
	}
	const lineEnd = text.indexOf("\n", cursor);
	if (lineEnd === -1) return cursor;
	const nextStart = lineEnd + 1;
	const nextEnd = text.indexOf("\n", nextStart);
	return Math.min(nextStart + column, nextEnd === -1 ? text.length : nextEnd);
}

function safeTerminalText(text: string): string {
	return stripVTControlCharacters(text).replace(/\r\n/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function display(text: string): string {
	return safeTerminalText(text);
}
