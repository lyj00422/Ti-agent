import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModelRuntime } from "../src/providers/model-runtime.ts";
import type { ModelMessage } from "../src/agent/messages.ts";

test("configured compatible models can be selected, authenticated, routed, and restored", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "ti-model-runtime-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const home = join(directory, "ti");
	const modelsPath = join(directory, "models.json");
	writeFileSync(modelsPath, JSON.stringify({ providers: {
		"openai-proxy": {
			name: "OpenAI Proxy",
			baseUrl: "https://openai.example/v1",
			api: "openai-completions",
			compat: { supportsUsageInStreaming: false, maxTokensField: "max_completion_tokens" },
			models: [{ id: "code-model", name: "Code Model", contextWindow: 65_536, maxTokens: 4_096 }],
		},
		"anthropic-proxy": {
			name: "Anthropic Proxy",
			baseUrl: "https://anthropic.example",
			api: "anthropic-messages",
			models: [{ id: "sonnet-custom", contextWindow: 100_000, maxTokens: 8_192, reasoning: true }],
		},
	} }));
	const env = { TI_MODELS_FILE: modelsPath } as NodeJS.ProcessEnv;
	const runtime = createModelRuntime(home, { env });
	for (const provider of ["deepseek", "openai", "anthropic", "google", "openrouter", "moonshotai-cn", "qwen", "siliconflow", "openai-proxy", "anthropic-proxy"]) {
		assert.ok(runtime.providers().includes(provider), provider);
	}
	assert.equal(runtime.current.provider, "openai");
	assert.equal(runtime.select("openai-proxy/code-model").contextWindow, 65_536);
	runtime.login("openai-proxy", "openai-test-key");
	assert.deepEqual(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")), {
		"openai-proxy": { type: "api_key", key: "openai-test-key" },
	});
	assert.deepEqual(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")), {
		defaultProvider: "openai-proxy", defaultModel: "code-model",
	});

	let requestUrl = "";
	let request: Record<string, unknown> = {};
	t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
		requestUrl = String(url);
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer openai-test-key");
		request = JSON.parse(String(init?.body));
		return new Response([
		'data: {"choices":[{"delta":{"content":"routed"}}]}\n\n',
		'data: [DONE]\n\n',
	].join(""));
	});
	const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
	const reply = await runtime.stream(messages, { signal: new AbortController().signal, onEvent: () => {} });
	assert.equal(requestUrl, "https://openai.example/v1/chat/completions");
	assert.equal(request.model, "code-model");
	assert.equal(request.max_completion_tokens, 4_096);
	assert.equal(request.thinking, undefined);
	assert.equal(request.stream_options, undefined);
	assert.equal(reply.content[0]?.type === "text" ? reply.content[0].text : "", "routed");

	const restored = createModelRuntime(home, { env: { ...env, TI_PROVIDER: "deepseek", TI_MODEL: "deepseek-flash" } });
	assert.equal(restored.current.provider, "openai-proxy");
	assert.equal(restored.current.id, "code-model");
	assert.equal(restored.select("sonnet-custom").provider, "anthropic-proxy");
	restored.login("anthropic-proxy", "anthropic-test-key");
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, "auth.json"), "utf8"))).sort(), ["anthropic-proxy", "openai-proxy"]);
	restored.setThinking("high");
	t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
		requestUrl = String(url);
		assert.equal(new Headers(init?.headers).get("x-api-key"), "anthropic-test-key");
		request = JSON.parse(String(init?.body));
		return new Response([
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"anthropic"}}',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
			'event: message_stop\ndata: {"type":"message_stop"}',
			"",
		].join("\n\n"));
	});
	const anthropicReply = await restored.stream(messages, { signal: new AbortController().signal, onEvent: () => {} });
	assert.equal(requestUrl, "https://anthropic.example/v1/messages");
	assert.equal(request.model, "sonnet-custom");
	assert.deepEqual(request.thinking, { type: "enabled", budget_tokens: 6_144 });
	assert.equal(anthropicReply.content[0]?.type === "text" ? anthropicReply.content[0].text : "", "anthropic");
});

test("built-in OpenAI and Gemini use saved keys and send the selected thinking level", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "ti-builtin-models-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const modelsPath = join(directory, "models.json");
	writeFileSync(modelsPath, "{}");
	const env = { TI_MODELS_FILE: modelsPath };
	const runtime = createModelRuntime(directory, { env });
	runtime.login("openai", "test-openai-key");
	runtime.login("google", "test-gemini-key");
	runtime.select("openai/gpt-5.2");
	assert.deepEqual(runtime.thinkingLevels(), ["off", "low", "medium", "high", "xhigh"]);
	assert.throws(() => runtime.setThinking("max"), /思考档位无效/);
	runtime.setThinking("xhigh", true);
	const restored = createModelRuntime(directory, { env });
	assert.equal(restored.thinkingLevel, "xhigh");
	const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		requests.push({ url: request.url, headers: request.headers, body: await request.json() as Record<string, unknown> });
		const google = request.url.includes("generativelanguage.googleapis.com");
		const events = google ? [{
			candidates: [{ content: { role: "model", parts: [{ text: "Gemini reply" }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
		}] : [
			{ choices: [{ delta: { content: "OpenAI reply" }, finish_reason: "stop" }] },
			{ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
		];
		return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("")
			+ (google ? "" : "data: [DONE]\n\n"), {
			headers: { "content-type": "text/event-stream" },
		});
	});
	const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
	const streamOptions = { signal: new AbortController().signal, onEvent: () => {} };
	const openai = await restored.stream(messages, streamOptions);
	assert.equal(openai.stopReason, "stop", openai.errorMessage);
	assert.equal(openai.content[0]?.type === "text" && openai.content[0].text, "OpenAI reply");
	assert.equal(requests[0].url, "https://api.openai.com/v1/chat/completions");
	assert.equal(requests[0].headers.get("authorization"), "Bearer test-openai-key");
	assert.equal(requests[0].body.reasoning_effort, "xhigh");
	restored.select("google/gemini-2.5-flash");
	assert.equal(restored.thinkingLevel, "high");
	restored.setThinking("low");
	const gemini = await restored.stream([...messages, openai, ...messages], streamOptions);
	assert.equal(gemini.stopReason, "stop", gemini.errorMessage);
	assert.equal(gemini.content[0]?.type === "text" && gemini.content[0].text, "Gemini reply");
	assert.match(requests[1].url, /gemini-2.5-flash:streamGenerateContent/);
	assert.equal(requests[1].headers.get("x-goog-api-key"), "test-gemini-key");
	assert.deepEqual((requests[1].body.generationConfig as { thinkingConfig: object }).thinkingConfig, {
		includeThoughts: true, thinkingBudget: 1_024,
	});
});

test("USTC is registered by models.json and both USTC and DeepSeek can enable thinking", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "ti-default-models-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const withoutConfig = createModelRuntime(directory, { env: {} });
	assert.ok(!withoutConfig.providers().includes("ustc"));
	assert.throws(() => withoutConfig.login("ustc", "test-ustc-key"), /找不到供应商/);
	const config = join(directory, "models.json");
	writeFileSync(config, JSON.stringify({ providers: {
		ustc: {
			baseUrl: "https://ustc.example/v1",
			api: "anthropic-messages",
			models: [{
				id: "deepseek-flash-2", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536,
				thinkingLevels: ["off", "low", "medium", "high"], defaultThinkingLevel: "off",
			}],
		},
	} }));
	const configured = createModelRuntime(directory, { env: {} });
	configured.login("ustc", "test-ustc-key");
	configured.select("ustc/deepseek-flash-2");
	const runtime = createModelRuntime(directory, { env: {} });
	assert.equal(runtime.current.provider, "ustc");
	assert.equal(runtime.current.id, "deepseek-flash-2");
	runtime.login("deepseek", "test-deepseek-key");
	assert.equal(runtime.thinkingLevel, "off");
	runtime.setThinking("high");
	const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		requests.push({ url: request.url, headers: request.headers, body: await request.json() as Record<string, unknown> });
		return new Response('{"error":{"message":"request captured"}}', {
			status: 400, headers: { "content-type": "application/json" },
		});
	});
	const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
	const options = { signal: new AbortController().signal, maxOutputTokens: 16_384, onEvent: () => {} };
	await runtime.stream(messages, options);
	assert.equal(new URL(requests[0].url).origin, "https://ustc.example");
	assert.equal(new URL(requests[0].url).pathname, "/v1/messages");
	assert.equal(requests[0].headers.get("x-api-key"), "test-ustc-key");
	assert.equal((requests[0].body.thinking as { type: string }).type, "enabled");
	runtime.select("deepseek/deepseek-flash");
	assert.deepEqual(runtime.thinkingLevels(), ["off", "low", "high", "max"]);
	runtime.setThinking("max");
	await runtime.stream(messages, options);
	assert.equal(requests[1].url, "https://api.deepseek.com/chat/completions");
	assert.equal(requests[1].headers.get("authorization"), "Bearer test-deepseek-key");
	assert.deepEqual(requests[1].body.thinking, { type: "enabled" });
	assert.equal(requests[1].body.reasoning_effort, "max");
});

test("extension providers enter the shared catalog and native providers receive the selected model", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "ti-injected-provider-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const modelsPath = join(directory, "models.json");
	writeFileSync(modelsPath, "{}");
	const runtime = createModelRuntime(directory, { env: { TI_MODELS_FILE: modelsPath } });
	runtime.registerProvider("acme", {
		name: "Acme AI",
		baseUrl: "https://acme.example/v1",
		api: "openai-completions",
		headers: { "x-gateway": "test" },
		models: [{ id: "acme-chat", contextWindow: 32_000, maxTokens: 4_000 }],
	});
	assert.ok(runtime.providers().includes("acme"));
	assert.equal(runtime.select("acme/acme-chat").contextWindow, 32_000);
	runtime.login("acme", "acme-key");
	assert.deepEqual(JSON.parse(readFileSync(join(directory, "auth.json"), "utf8")), {
		acme: { type: "api_key", key: "acme-key" },
	});
	let request: Request | undefined;
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		request = new Request(input, init);
		return new Response('data: {"choices":[{"delta":{"content":"acme"}}]}\n\ndata: [DONE]\n\n');
	});
	await runtime.stream([], { signal: new AbortController().signal, onEvent: () => {} });
	assert.equal(request?.url, "https://acme.example/v1/chat/completions");
	assert.equal(request?.headers.get("authorization"), "Bearer acme-key");
	assert.equal(request?.headers.get("x-gateway"), "test");
	const restored = createModelRuntime(directory, { env: { TI_MODELS_FILE: modelsPath } });
	restored.registerProvider("acme", {
		api: "openai-completions", baseUrl: "https://acme.example/v1",
		models: [{ id: "acme-chat", contextWindow: 32_000, maxTokens: 4_000 }],
	});
	assert.equal(restored.current.provider, "acme");
	assert.equal(restored.current.id, "acme-chat");

	let receivedModel = "";
	runtime.registerProvider({
		id: "native-acme",
		models: [{ id: "native-chat", api: "acme-native", contextWindow: 16_000, maxTokens: 2_000 }],
		async stream(model, _messages, options) {
			receivedModel = `${model.provider}/${model.id}`;
			assert.equal(options.resolveApiKey(), "native-key");
			options.onEvent({ type: "text_delta", text: "native" });
			return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "native" }], timestamp: Date.now() };
		},
	});
	runtime.select("native-acme/native-chat");
	runtime.login("native-acme", "native-key");
	const reply = await runtime.stream([], { signal: new AbortController().signal, onEvent: () => {} });
	assert.equal(receivedModel, "native-acme/native-chat");
	assert.equal(reply.content[0]?.type === "text" ? reply.content[0].text : "", "native");
	runtime.unregisterProvider("native-acme");
	assert.ok(!runtime.providers().includes("native-acme"));
	assert.equal(runtime.current.provider, "openai");
});

test("provider composition upserts file models, replaces extension models, and rolls back failed registration", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "ti-provider-composition-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(join(directory, "models.json"), JSON.stringify({ providers: {
		deepseek: {
			baseUrl: "https://file.example/v1",
			models: [{ id: "file-chat" }, { id: "ignored", api: "unsupported-api" }],
			modelOverrides: { "extension-chat": { contextWindow: 64_000 } },
		},
	} }));
	const runtime = createModelRuntime(directory, { env: {} });
	const deepseekModels = () => runtime.list().filter(({ provider }) => provider === "deepseek").map(({ id }) => id);
	assert.deepEqual(deepseekModels(), ["deepseek-flash", "file-chat"]);
	runtime.select("deepseek/deepseek-flash");
	runtime.registerProvider("deepseek", { baseUrl: "https://extension.example/v1" });
	assert.equal(runtime.current.baseUrl, "https://extension.example/v1");
	assert.deepEqual(deepseekModels(), ["deepseek-flash", "file-chat"]);

	runtime.registerProvider("deepseek", {
		api: "custom-chat",
		models: [{ id: "extension-chat", contextWindow: 32_000 }],
		async streamSimple(model) {
			return {
				role: "assistant", stopReason: "stop", timestamp: Date.now(),
				content: [{ type: "text", text: model.id }],
			};
		},
	});
	assert.equal(runtime.current.provider, "openai");
	assert.deepEqual(deepseekModels(), ["extension-chat"]);
	assert.equal(runtime.select("deepseek/extension-chat").contextWindow, 64_000);
	assert.throws(() => runtime.registerProvider("deepseek", { models: [{ id: "other", api: "unknown-api" }] }), /未注册的 API/);
	assert.deepEqual(deepseekModels(), ["extension-chat"]);
	assert.equal(runtime.current.id, "extension-chat");
	const reply = await runtime.stream([], { signal: new AbortController().signal, onEvent: () => {} });
	assert.deepEqual(reply.content, [{ type: "text", text: "extension-chat" }]);

	runtime.unregisterProvider("deepseek");
	assert.deepEqual(deepseekModels(), ["deepseek-flash", "file-chat"]);
	assert.equal(runtime.select("deepseek/deepseek-flash").baseUrl, "https://file.example/v1");
});
