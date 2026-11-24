import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runAgentTurn } from "./agent.ts";
import { getKey, MODEL_ID, saveKey } from "./deepseek.ts";
import { SessionStore } from "./sessions.ts";
import { startTerminalChat } from "./terminal-chat.ts";

const userHome = resolve(process.env.TI_HOME || join(homedir(), ".ti"));
const sessionHome = resolve(process.env.TI_SESSION_HOME || join(process.cwd(), ".ti"));
const legacyHome = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
const sessions = new SessionStore(sessionHome, [userHome, legacyHome], process.cwd());

await startTerminalChat({
	model: MODEL_ID,
	sessions,
	send: (session, text, onDelta, signal) => runAgentTurn(
		text,
		session.history,
		(message) => sessions.append(session, message),
		() => getKey(userHome, legacyHome),
		onDelta,
		signal,
	),
	login: (key) => saveKey(userHome, key),
});
