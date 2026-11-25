import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

const input = createInterface({ input: process.stdin });
let initialized = false;
for await (const line of input) {
	const message = JSON.parse(line);
	let result: object;
	switch (message.method) {
		case "initialize":
			result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stdio fixture", version: "1" } };
			break;
		case "notifications/initialized":
			initialized = true;
			continue;
		case "tools/list":
			assert.ok(initialized);
			result = { tools: [{ name: "echo", description: "Echo the input", inputSchema: {
				type: "object", properties: { text: { type: "string" } }, required: ["text"],
			} }] };
			break;
		case "tools/call":
			assert.ok(initialized);
			assert.equal(message.params.name, "echo");
			result = { content: [{ type: "text", text: process.env.TI_FIXTURE_PREFIX + message.params.arguments.text }],
				structuredContent: { transport: "stdio" } };
			break;
		default:
			throw new Error("Unexpected MCP request: " + message.method);
	}
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
}
writeFileSync(join(process.cwd(), "mcp-closed"), String(process.pid));
