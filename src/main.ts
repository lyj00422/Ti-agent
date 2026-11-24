import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ChatSession } from "./chat-session.ts";
import { CONTEXT_WINDOW, getKey, MODEL_ID, saveKey, streamReply } from "./deepseek.ts";
import { SessionStore } from "./sessions.ts";
import { startTerminalChat } from "./terminal-chat.ts";

const userHome = resolve(process.env.TI_HOME || join(homedir(), ".ti"));
const sessionHome = resolve(process.env.TI_SESSION_HOME || join(process.cwd(), ".ti"));
const legacyHome = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
const sessions = new SessionStore(sessionHome, [userHome, legacyHome], process.cwd());
const session = new ChatSession(sessions, {
	contextWindow: CONTEXT_WINDOW,
	stream: (messages, options) => streamReply(messages, () => getKey(userHome, legacyHome), options),
});

await startTerminalChat({
	model: MODEL_ID,
	session,
	login: (key) => saveKey(userHome, key),
});
