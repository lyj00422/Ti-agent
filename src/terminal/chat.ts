import { stdin, stdout } from "node:process";
import { createInterface, emitKeypressEvents } from "node:readline";
import { stripVTControlCharacters, styleText } from "node:util";
import { errorMessage, messageText, toolCalls } from "../agent/messages.ts";
import type { AssistantMessage, ToolCall, ToolResultMessage, Usage } from "../agent/messages.ts";
import type { AgentSessionEvent, AgentSession } from "../session/agent-session.ts";
import type { Session } from "../session/store.ts";
import type { ModelChoice } from "../providers/model-runtime.ts";

interface TerminalChatOptions {
	session: AgentSession;
	getModel: () => string;
	models: () => readonly ModelChoice[];
	selectModel: (reference: string) => string;
	providers: () => readonly string[];
	login: (provider: string, key: string) => void;
	getThinking: () => string;
	thinkingLevels: () => readonly string[];
	setThinking: (level: string, persist?: boolean) => string;
}

export async function startTerminalChat(options: TerminalChatOptions): Promise<void> {
	if (stdin.isTTY && stdout.isTTY) {
		await startFullscreenChat(options);
		return;
	}
	await startReadlineChat(options);
}

async function startReadlineChat(options: TerminalChatOptions): Promise<void> {
	const { session } = options;
	const input = createInterface({ input: stdin, terminal: false });
	let exiting = false;
	const close = () => {
		exiting = true;
		session.abort();
		input.close();
	};
	input.on("SIGINT", close);
	process.on("SIGINT", close);
	process.on("SIGTERM", close);

	let picker: Session[] | undefined;
	let modelPicker: readonly ModelChoice[] | undefined;
	let multiline: string[] = [];
	let loginProvider: string | undefined;
	let providerPicker: readonly string[] | undefined;

	const write = (text: string) => stdout.write(text);
	const promptForKey = (provider: string) => {
		if (!options.providers().includes(provider)) throw new Error(`未知供应商 ${provider}。`);
		loginProvider = provider;
		write(`${display(provider)} API Key（输入隐藏，直接回车取消）> `);
	};
	const errorLine = (message: string) => write(styleText("red", display(message)) + "\n");
	const showHistory = () => {
		for (const message of session.history) {
			if (message.role === "toolResult") {
				write(display(toolResultStatus(message)) + "\n");
				continue;
			}
			const text = messageText(message);
			if (text) write(`${message.role === "user" ? "你" : "Ti"}> ${display(text)}\n`);
			if (message.role === "assistant") {
				for (const call of toolCalls(message)) write(display(toolCallLabel(call)) + "\n");
				showStatus(message);
			}
		}
	};
	const showStatus = (message: AssistantMessage) => {
		const status = replyStatus(message);
		if (status) errorLine(status);
	};
	const onEvent = (event: AgentSessionEvent) => {
		if (event.type === "compacting") write("正在压缩早期对话…\n");
		if (event.type === "compacted") write("上下文已压缩。\n");
	};
	const respond = async (text: string, retry: boolean) => {
		let started = false;
		const endText = () => {
			if (started) write("\n");
			started = false;
		};
		const update = (event: AgentSessionEvent) => {
			if (event.type === "message_update") {
				if (event.event.type === "text_delta") {
					if (!started) write("Ti> ");
					started = true;
					write(display(event.event.text));
				}
				return;
			}
			if (event.type === "message_end") {
				endText();
				if (event.message.role === "toolResult") write(display(toolResultStatus(event.message)) + "\n");
				return;
			}
			if (event.type === "tool_execution_start") {
				write(display(toolCallLabel(event.call)) + "\n");
				return;
			}
			if (event.type === "tool_execution_update") {
				const progress = toolProgress(event.partialResult);
				if (progress) write(`${event.call.name} · ${progress}\n`);
				return;
			}
			onEvent(event);
		};
		const reply = await (retry ? session.continue(update) : session.prompt(text, update)).finally(endText);
		showStatus(reply);
	};

	try {
		write(`Ti · ${options.getModel()} · /new · /resume · /login · /model · /thinking · /retry · /usage · /compact · /exit\n`);
		showHistory();
		for await (const line of input) {
			if (exiting) break;
			const command = line.trim();
			if (!loginProvider && command === "/exit") break;
			try {
				if (loginProvider) {
					const provider = loginProvider;
					loginProvider = undefined;
					write("\n");
					if (command) {
						options.login(provider, line);
						write(`${provider} API Key 已保存。\n`);
					}
				} else if (providerPicker) {
					const choices = providerPicker;
					providerPicker = undefined;
					if (command) promptForKey(choices[Number(command) - 1] ?? command);
				} else if (modelPicker) {
					const choices = modelPicker;
					modelPicker = undefined;
					if (command) {
						const selected = /^\d+$/.test(command) ? choices[Number(command) - 1] : undefined;
						const reference = selected ? `${selected.provider}/${selected.id}` : command;
						write(`当前模型：${options.selectModel(reference)}\n`);
					}
				} else if (picker) {
					if (command) {
						const selected = /^\d+$/.test(command) ? picker[Number(command) - 1] : undefined;
						if (!selected) throw new Error("请输入列表中的编号，或直接回车取消。");
						session.resume(selected);
						write("已恢复会话\n");
						showHistory();
					}
					picker = undefined;
				} else if (!multiline.length && command === "/login") {
					const providers = options.providers();
					if (providers.length === 1) {
						promptForKey(providers[0]);
					} else {
						providerPicker = providers;
						for (const [index, provider] of providers.entries()) write(`${index + 1}. ${display(provider)}\n`);
						write("输入供应商编号或 ID，直接回车取消\n");
					}
				} else if (!multiline.length && command.startsWith("/login ")) {
					promptForKey(command.slice(7).trim());
				} else if (!multiline.length && command === "/model") {
					modelPicker = options.models();
					for (const [index, model] of modelPicker.entries()) write(`${index + 1}. ${model.label}\n`);
					write("输入编号或 provider/model，直接回车取消\n");
				} else if (!multiline.length && command.startsWith("/model ")) {
					write(`当前模型：${options.selectModel(command.slice(7).trim())}\n`);
				} else if (!multiline.length && command === "/thinking") {
					write(`思考档位 ${options.getThinking()} · 可选 ${options.thinkingLevels().join("、")}\n`);
				} else if (!multiline.length && command.startsWith("/thinking ")) {
					write(`思考档位 ${options.setThinking(command.slice(10))}\n`);
				} else if (!multiline.length && command === "/new") {
					session.newSession();
					write("已创建新会话\n");
				} else if (!multiline.length && command === "/resume") {
					const sessions = session.list();
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
				} else if (!multiline.length && command === "/usage") {
					write(formatUsage(session) + "\n");
				} else if (!multiline.length && command === "/compact") {
					await session.compact(onEvent);
				} else if (!multiline.length && command === "/retry") {
					await respond("", true);
				} else if (line.endsWith("\\")) {
					multiline.push(line.slice(0, -1));
				} else {
					const text = [...multiline, line].join("\n").trim();
					multiline = [];
					if (text) await respond(text, false);
				}
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") {
					if (!exiting) write("已停止。\n");
				} else {
					errorLine("请求失败  " + errorMessage(error));
				}
			}
		}
	} finally {
		close();
		process.off("SIGINT", close);
		process.off("SIGTERM", close);
	}
}

async function startFullscreenChat(options: TerminalChatOptions): Promise<void> {
	return new Promise((resolve, reject) => {
		const { session } = options;
		let mode: "chat" | "login" | "resume" | "provider" | "model" | "thinking" = "chat";
		let loginProvider = "";
		let choices: readonly { label: string; value: string }[] = [];
		let filteredChoices = choices;
		let selectedChoice = 0;
		let picker: Session[] = [];
		let selectedSession = 0;
		let draft = "";
		let cursor = 0;
		let streamText = "";
		let liveUsage: Usage | undefined;
		let compacting = false;
		let activeTool: ToolCall | undefined;
	let activeToolProgress = "";
		let notice = "";
		let noticeIsError = false;
		let spinnerFrame = 0;
		let scrollOffset = 0;
		let maxScrollOffset = 0;
		let closed = false;
		const spinner = ["·", "··", "···", "··"];
		let previousScreen: string[] | undefined;

		const render = () => {
			if (closed) return;
			const busy = session.isRunning;
			const width = Math.max(24, stdout.columns || 80);
			const height = Math.max(10, stdout.rows || 24);
			const lines: string[] = [];
			lines.push(` ${styleTerminal(["red", "bold"], "T")}${styleTerminal(["yellow", "bold"], "i")}  ${styleTerminal("dim", "conversation")}`);
			lines.push(styleTerminal("magenta", "─".repeat(width)));

			const transcript: string[] = [];
			for (const message of session.history) {
				const text = messageText(message);
				if (transcript.length > 0) transcript.push("");
				if (message.role === "user") {
					for (const line of wrapTerminalText(text, width - 4)) {
						transcript.push(styleTerminal(["bgBlue", "whiteBright"], padTerminalText(`  ${line}  `, width)));
					}
				} else if (message.role === "toolResult") {
					transcript.push(...wrapTerminalText(toolResultStatus(message), width - 4)
						.map((line) => styleTerminal(message.isError ? "red" : "dim", "  " + line)));
				} else {
					if (text) transcript.push(...renderAssistantText(text, width - 2));
					for (const call of toolCalls(message)) {
						transcript.push(...wrapTerminalText(toolCallLabel(call), width - 4)
							.map((line) => styleTerminal("magenta", "  " + line)));
					}
					const status = replyStatus(message);
					if (status) transcript.push(...wrapTerminalText(status, width - 2).map((line) => styleTerminal("red", "  " + line)));
				}
			}
			if (streamText) transcript.push(...renderAssistantText(streamText, width - 2));
			if (mode === "resume") {
				transcript.push("");
				transcript.push(styleTerminal("yellow", "Resume session"));
				for (const [index, item] of picker.entries()) {
					const title = safeTerminalText(item.title).replace(/\s+/g, " ").slice(0, Math.max(8, width - 34));
					const prefix = index === selectedSession ? styleTerminal("magenta", "› ") : "  ";
					const detail = styleTerminal("dim", `${item.modified.toLocaleString()} · ${item.history.length} messages`);
					transcript.push(`${prefix}${index === selectedSession ? styleTerminal("magenta", title) : title}  ${detail}`);
				}
			}
			if (notice) transcript.push(...wrapTerminalText(notice, width - 2).map((line) => styleTerminal(noticeIsError ? "red" : "dim", "  " + line)));

			const choosing = mode === "model" || mode === "provider" || mode === "thinking";
			const prompt = mode === "login" ? "Key> " : mode === "model" || mode === "provider" ? "Search> " : "› ";
			const draftLayout = layoutTerminalDraft(draft, cursor, Math.max(1, width - 4), mode === "login");
			const hiddenInputRows = Math.max(0, draftLayout.lines.length - Math.max(1, height - 7));
			const inputRows = draftLayout.lines.map((line, index) => {
				const prefix = index === 0 ? prompt : "  ";
				return prefix + line;
			}).slice(hiddenInputRows);
			const activity = activeTool ? [activeTool.name, activeToolProgress].filter(Boolean).join(" · ") : "Working";
			const working = shortenTerminalText(`${spinner[spinnerFrame]} ${compacting ? "Compacting" : activity}`, width - 5);
			const editorBorder = busy
				? `${styleTerminal("magenta", "── ")}${styleTerminal("dim", working)}${styleTerminal("magenta", ` ${"─".repeat(width - terminalWidth(working) - 4)}`)}`
				: styleTerminal("magenta", "─".repeat(width));

			const thinking = options.thinkingLevels().length > 1 ? " · " + options.getThinking() : "";
			const footerRight = styleTerminal("magenta", shortenTerminalText(safeTerminalText(options.getModel()) + thinking, width - 2));
			const latest = liveUsage ?? session.history.findLast((message) => message.role === "assistant")?.usage;
			const usageLine = latest ? `↑${latest.input} ↓${latest.output} cache ${latest.cacheRead ?? "?"}` : process.cwd();
			const footerLeft = styleTerminal("dim", shortenTerminalText(usageLine, width - terminalWidth(footerRight) - 1));
			const footer = `${footerLeft}${" ".repeat(Math.max(1, width - terminalWidth(footerLeft) - terminalWidth(footerRight)))}${footerRight}`;
			const hints = mode === "login"
				? `${safeTerminalText(loginProvider)} · Enter save · Esc cancel`
				: mode === "thinking" ? "↑↓ select · Enter confirm · Ctrl+S save default · Esc cancel"
				: choosing ? "Search · ↑↓ select · Enter confirm · Esc cancel"
				: mode === "resume"
					? "↑↓ select · Enter resume · Esc cancel"
				: busy ? "Esc stop · Ctrl+C exit" : "/login · /model · Shift+Tab thinking · /thinking · /new · /resume · /exit";

			const transcriptRows = Math.max(1, height - inputRows.length - 5);
			if (choosing) {
				const start = Math.max(0, selectedChoice - transcriptRows + 1);
				transcript.splice(0, transcript.length, ...filteredChoices.slice(start, start + transcriptRows).map(({ label }, index) => {
					const line = shortenTerminalText(safeTerminalText(label), width - 2);
					return start + index === selectedChoice ? styleTerminal("magenta", "› " + line) : "  " + line;
				}));
				if (!filteredChoices.length) transcript.push("  No matches");
			}
			maxScrollOffset = Math.max(0, transcript.length - transcriptRows);
			scrollOffset = Math.min(scrollOffset, maxScrollOffset);
			const transcriptEnd = transcript.length - scrollOffset;
			const visibleTranscript = transcript.slice(Math.max(0, transcriptEnd - transcriptRows), transcriptEnd);
			lines.push(...Array.from({ length: transcriptRows - visibleTranscript.length }, () => ""));
			lines.push(...visibleTranscript);
			lines.push(editorBorder);
			lines.push(...inputRows);
			lines.push(footer);
			lines.push(styleTerminal("dim", hints.slice(0, width)));
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

		const openChoices = (next: "model" | "provider" | "thinking", items: typeof choices, current?: string) => {
			choices = items;
			filteredChoices = items;
			selectedChoice = Math.max(0, choices.findIndex(({ value }) => value === current));
			scrollOffset = 0;
			setMode(next);
		};

		const applyThinking = (level: string, persist = false) => {
			try {
				const chosen = options.setThinking(level, persist);
				notice = persist ? `Default thinking level: ${chosen}` : `Thinking level: ${chosen}`;
				noticeIsError = false;
			} catch (error) {
				notice = errorMessage(error);
				noticeIsError = true;
			}
			scrollOffset = 0;
			render();
		};

		const close = () => {
			if (closed) return;
			closed = true;
			session.abort();
			clearInterval(spinnerTimer);
			stdin.off("keypress", onKeypress);
			stdin.off("end", close);
			stdout.off("resize", render);
			process.off("SIGINT", close);
			process.off("SIGTERM", close);
			if (stdin.isTTY) stdin.setRawMode(false);
			stdin.pause();
			stdout.write("\x1b[?25h\x1b[?1049l");
			void session.waitForIdle().then(resolve, (error: unknown) => {
				if (error instanceof Error && error.name === "AbortError") resolve();
				else reject(error);
			});
		};

		const submit = () => {
			const text = draft.trim();
			if (mode === "login") {
				if (!text) {
					setMode("chat");
					return;
				}
				try {
					options.login(loginProvider, draft);
					setMode("chat");
					notice = `${loginProvider} API Key saved`;
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
					session.resume(picker[selectedSession]);
				}
				scrollOffset = 0;
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
				session.newSession();
				scrollOffset = 0;
				notice = "New session";
				noticeIsError = false;
				draft = "";
				cursor = 0;
				render();
				return;
			}
			if (text === "/resume") {
				try {
					picker = session.list();
				} catch (error) {
					notice = errorMessage(error);
					noticeIsError = true;
					render();
					return;
				}
				if (picker.length === 0) {
					notice = "No sessions to resume";
					noticeIsError = false;
					render();
					return;
				}
				selectedSession = 0;
				scrollOffset = 0;
				setMode("resume");
				return;
			}
			if (text === "/login" || text.startsWith("/login ")) {
				const requested = text.slice(6).trim();
				const available = options.providers();
				if (!requested && available.length !== 1) {
					openChoices("provider", available.map((value) => ({ label: value, value })));
					return;
				}
				loginProvider = requested || available[0];
				if (!available.includes(loginProvider)) {
					setMode("chat");
					notice = "Unknown provider. Use /login to see available providers.";
					noticeIsError = true;
					render();
					return;
				}
				setMode("login");
				return;
			}
			if (text === "/model") {
				openChoices("model", options.models().map(({ label, provider, id }) => ({ label, value: provider + "/" + id })), options.getModel());
				return;
			}
			if (text.startsWith("/model ")) {
				setMode("chat");
				try {
					notice = `Current model: ${options.selectModel(text.slice(7).trim())}`;
					noticeIsError = false;
				} catch (error) {
					notice = errorMessage(error);
					noticeIsError = true;
				}
				render();
				return;
			}
			if (text === "/thinking") {
				openChoices("thinking", options.thinkingLevels().map((value) => ({ label: value, value })), options.getThinking());
				return;
			}
			if (text.startsWith("/thinking ")) {
				setMode("chat");
				applyThinking(text.slice(10));
				return;
			}
			draft = "";
			cursor = 0;
			scrollOffset = 0;
			notice = "";
			noticeIsError = false;
			if (text === "/usage") {
				notice = formatUsage(session);
				render();
				return;
			}
			const onEvent = (event: AgentSessionEvent) => {
				if (event.type === "message_update" && event.event.type === "text_delta") streamText += event.event.text;
				else if (event.type === "message_update" && event.event.type === "usage") liveUsage = event.event.usage;
				else if (event.type === "message_end") {
					if (event.message.role === "assistant") streamText = "";
					if (event.message.role === "toolResult") activeTool = undefined;
				} else if (event.type === "tool_execution_start") {
					activeTool = event.call;
					activeToolProgress = "";
				} else if (event.type === "tool_execution_update") activeToolProgress = toolProgress(event.partialResult);
				else if (event.type === "compacting") compacting = true;
				else if (event.type === "compacted") {
					compacting = false;
					liveUsage = undefined;
					notice = "上下文已压缩。";
				}
				render();
			};
			const request = text === "/compact" ? session.compact(onEvent)
				: text === "/retry" ? session.continue(onEvent)
					: session.prompt(text, onEvent);
			render();
			void request.catch((error: unknown) => {
				notice = error instanceof Error && error.name === "AbortError" ? "已停止。" : errorMessage(error);
				noticeIsError = notice !== "已停止。";
			}).finally(() => {
				streamText = "";
				liveUsage = undefined;
				compacting = false;
				activeTool = undefined;
				activeToolProgress = "";
				render();
			});
		};

		const onKeypress = (char: string | undefined, key: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => {
			if (closed) return;
			if (key.ctrl && key.name === "c") {
				close();
				return;
			}
			if (session.isRunning) {
				if (key.name === "escape") session.abort();
				return;
			}
			if (mode === "chat" && ((key.name === "tab" && key.shift) || key.sequence === "\x1b[Z")) {
				const levels = options.thinkingLevels();
				if (levels.length > 1) {
					applyThinking(levels[(levels.indexOf(options.getThinking()) + 1) % levels.length]);
				} else {
					notice = "Current model has no adjustable thinking level";
					noticeIsError = false;
					scrollOffset = 0;
					render();
				}
				return;
			}
			if (mode === "model" || mode === "provider" || mode === "thinking") {
				if (key.name === "escape") {
					setMode("chat");
				} else if (key.name === "up" || key.name === "down") {
					const step = key.name === "up" ? -1 : 1;
					if (filteredChoices.length) selectedChoice = (selectedChoice + step + filteredChoices.length) % filteredChoices.length;
					render();
				} else if (key.name === "return" || key.name === "enter" || (mode === "thinking" && key.ctrl && key.name === "s")) {
					const selected = filteredChoices[selectedChoice];
					if (selected && mode === "thinking") {
						setMode("chat");
						applyThinking(selected.value, key.ctrl && key.name === "s");
					} else if (selected) {
						draft = `/${mode === "model" ? "model" : "login"} ${selected.value}`;
						submit();
					}
				} else if (mode !== "thinking" && (key.name === "backspace" || (char && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(char)))) {
					draft = key.name === "backspace" ? draft.slice(0, previousCharacterOffset(draft, draft.length)) : draft + char;
					cursor = draft.length;
					const terms = draft.trim().toLowerCase().split(/\s+/);
					filteredChoices = choices.filter(({ label }) => terms.every((term) => label.toLowerCase().includes(term)));
					selectedChoice = 0;
					render();
				}
				return;
			}
			if (mode === "resume") {
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
			if (key.name === "left") cursor = previousCharacterOffset(draft, cursor);
			else if (key.name === "right") cursor = nextCharacterOffset(draft, cursor);
			else if (mode === "chat" && (key.name === "up" || key.name === "down") && draft.length === 0) {
				scrollOffset = Math.max(0, Math.min(maxScrollOffset, scrollOffset + (key.name === "up" ? 3 : -3)));
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
			if (session.isRunning) {
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
		process.once("SIGINT", close);
		process.once("SIGTERM", close);
		stdout.write("\x1b[?1049h\x1b[?25l");
		render();
	});
}

function toolCallLabel(call: ToolCall): string {
	const target = call.arguments.path ?? call.arguments.command ?? call.arguments.pattern;
	const preview = typeof target === "string" ? target.replace(/\\s+/g, " ").slice(0, 160) : "";
	return preview ? call.name + " " + preview : call.name;
}

function toolProgress(result: Pick<ToolResultMessage, "content">): string {
	const text = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").trimEnd();
	return display(text.slice(text.lastIndexOf("\n") + 1).trim()).slice(0, 160);
}

function toolResultStatus(result: ToolResultMessage): string {
	const status = result.toolName + (result.isError ? " · 失败" : " · 完成");
	const detail = result.isError ? messageText(result).trim().slice(0, 320) : "";
	return detail ? status + "  " + detail : status;
}

function replyStatus(message: AssistantMessage): string | undefined {
	if (message.stopReason === "aborted") return "已停止。可用 /retry 重试。";
	if (message.stopReason === "length") return "回复达到输出上限，已截断。";
	if (message.stopReason === "error") {
		return "请求失败  " + (message.errorMessage ?? message.error?.message ?? "未知错误") + " · /retry";
	}
}

function formatUsage(session: AgentSession): string {
	const { latest, total, cacheReadPartial, contextTokens, contextWindow, inputBudget } = session.usage();
	const format = ({ input, output, cacheRead }: Usage) => `输入 ${input} · 输出 ${output} · 缓存命中 ${cacheRead ?? "未知"}`;
	const context = `上下文估算 ${contextTokens} / ${contextWindow} tokens（输入预算 ${inputBudget}）`;
	return [
		context,
		`最近回复  ${latest ? format(latest) : "暂无实报用量"}`,
		`会话累计（已报告）  ${total ? format(total) : "暂无实报用量"}${cacheReadPartial && total?.cacheRead !== undefined ? "（部分请求未报告缓存）" : ""}`,
	].join("\n");
}

function renderAssistantText(text: string, width: number): string[] {
	const output: string[] = [];
	let inCodeBlock = false;
	for (const source of text.split("\n")) {
		if (source.trimStart().startsWith("```")) {
			inCodeBlock = !inCodeBlock;
			output.push(styleTerminal("dim", `  ${"─".repeat(Math.max(1, width - 4))}`));
			continue;
		}
		if (inCodeBlock) {
			output.push(...wrapTerminalText(source, width - 4).map((line) => `  ${styleTerminal("green", line)}`));
			continue;
		}
		const heading = source.match(/^\s{0,3}(#{1,3})\s+(.*)$/);
		const quote = source.match(/^\s{0,3}>\s?(.*)$/);
		const bullet = source.match(/^\s{0,3}([-*+] |\d+\. )(.*)$/);
		if (heading) {
			output.push(...wrapTerminalText(heading[2], width - 2).map((line) => `  ${styleTerminal(["yellow", "bold"], line)}`));
		} else if (quote) {
			output.push(...wrapTerminalText(quote[1], width - 4).map((line) => `  ${styleTerminal("dim", `│ ${line}`)}`));
		} else if (bullet) {
			const marker = bullet[1];
			const parts = wrapTerminalText(bullet[2], width - 4);
			output.push(`  ${styleTerminal("magenta", marker)}${styleInlineMarkdown(parts[0] ?? "")}`);
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
		.replace(/`([^`]+)`/g, (_match, code: string) => styleTerminal("magenta", code))
		.replace(/\*\*([^*]+)\*\*/g, (_match, bold: string) => styleTerminal("bold", bold));
}

function styleTerminal(styles: string | string[], text: string): string {
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
	if (width <= 0) return "";
	const safe = safeTerminalText(text);
	if (terminalWidth(safe) <= width) return safe;
	const points = Array.from(safe);
	let start = points.length;
	let cells = terminalCharacterWidth("…");
	while (start > 0) {
		const pointWidth = terminalCharacterWidth(points[start - 1]);
		if (cells + pointWidth > width) break;
		cells += pointWidth;
		start--;
	}
	return `…${points.slice(start).join("")}`;
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
