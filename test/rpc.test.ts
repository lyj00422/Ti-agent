import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("RPC accepts a prompt, streams events, and shuts down cleanly", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "ti rpc "));
	t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
	const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
	const fetch = `globalThis.fetch = async () => new Response("data: " + JSON.stringify({ choices: [{ delta: { content: "rpc answer" }, finish_reason: "stop" }] }) + "\\n\\ndata: [DONE]\\n\\n")`;
	const preload = "data:text/javascript;base64," + Buffer.from(fetch).toString("base64");
	const input = [
		{ id: "prompt-1", type: "prompt", message: "hello" },
		{ id: "shutdown-1", type: "shutdown" },
	].map((command) => JSON.stringify(command)).join("\n") + "\n";
	const child = spawnSync(process.execPath, ["--import", preload, main, "--mode", "rpc", "--yolo"], {
		cwd,
		input,
		encoding: "utf8",
		timeout: 15_000,
		env: { ...process.env, TI_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "fake", TI_HOME: join(cwd, "auth"), TI_SESSION_HOME: join(cwd, "sessions") },
	});
	assert.ifError(child.error);
	assert.equal(child.status, 0, child.stderr);
	const records = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(records.some((record) => record.id === "prompt-1" && record.type === "response" && record.success));
	assert.ok(records.some((record) => record.type === "agent_settled"));
	assert.ok(records.some((record) => record.id === "shutdown-1" && record.type === "response" && record.success), JSON.stringify(records));
});
