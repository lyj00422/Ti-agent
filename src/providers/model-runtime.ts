import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ModelRegistry, STANDARD_THINKING_LEVELS } from "./model-registry.ts";
import type { TiModel } from "./model-registry.ts";
import type { ModelProvider, ModelRegistrationAPI, ModelStream, ProviderConfig, ThinkingLevel } from "./types.ts";

export interface ModelChoice {
	provider: string;
	id: string;
	name: string;
	label: string;
}

export interface ModelRuntimeOptions {
	env?: NodeJS.ProcessEnv;
	credentialHomes?: readonly string[];
}

interface SettingsJson {
	defaultProvider?: unknown;
	defaultModel?: unknown;
	defaultThinkingLevel?: ThinkingLevel;
}

export interface ModelRuntime extends ModelRegistrationAPI {
	readonly current: TiModel;
	readonly stream: ModelStream;
	readonly contextWindow: number;
	readonly thinkingLevel: ThinkingLevel;
	thinkingLevels(): readonly ThinkingLevel[];
	setThinking(level: string, persist?: boolean): ThinkingLevel;
	list(): readonly ModelChoice[];
	providers(): readonly string[];
	select(reference: string): TiModel;
	login(provider: string, key: string): void;
}

/** Owns Ti's model catalog, credential lookup, active selection, and API routing. */
export function createModelRuntime(home: string, options: ModelRuntimeOptions = {}): ModelRuntime {
	const userHome = resolve(home);
	const env = options.env ?? process.env;
	const credentialHomes = options.credentialHomes ?? [];
	const configPath = findModelsPath(userHome, env);
	const registry = new ModelRegistry(configPath ? readJson(configPath) : {});
	let models = registry.list();
	const settingsPath = join(userHome, "settings.json");
	const settings = readSettings(settingsPath);
	let preferredModel = defaultModelReference(settings);
	let selected = chooseInitialModel(models, preferredModel, env);
	const refreshSelection = () => {
		models = registry.list();
		selected = chooseInitialModel(models, preferredModel, env);
	};
	let preferredThinking = settings.defaultThinkingLevel;
	const levels = (model: TiModel) => model.reasoning ? model.thinkingLevels ?? STANDARD_THINKING_LEVELS : ["off"] as const;
	const thinkingLevel = () => clampThinking(levels(selected), preferredThinking ?? selected.defaultThinkingLevel ?? "medium");

	const runtime: ModelRuntime = {
		get current() {
			return selected;
		},
		stream: (messages, options) => {
			const model = selected;
			const provider = registry.get(model.provider);
			const stream = provider.streamFor(model.api)!;
			return stream(model, messages, {
				...options,
				thinkingLevel: thinkingLevel(),
				resolveApiKey: () => resolveModelKey(model, provider.apiKey, userHome, credentialHomes, env),
			});
		},
		get contextWindow() {
			return selected.contextWindow;
		},
		get thinkingLevel() {
			return thinkingLevel();
		},
		thinkingLevels: () => levels(selected),
		setThinking(value, persist = false) {
			const level = levels(selected).find((item) => item === value.trim().toLowerCase());
			if (!level) throw new Error(`思考档位无效。当前模型支持：${levels(selected).join("、")}。`);
			if (persist) updateJson(settingsPath, { defaultThinkingLevel: level });
			preferredThinking = level;
			return level;
		},
		list: () => models.map(toChoice),
		providers: () => [...new Set(models.map((model) => model.provider))],
		select(reference) {
			const model = findModel(models, reference);
			if (!model) throw new Error(`找不到模型 ${reference}。请使用 /model 查看可用模型。`);
			writeDefaultModel(settingsPath, model);
			preferredModel = `${model.provider}/${model.id}`;
			selected = model;
			return model;
		},
		login(provider, key) {
			if (!models.some((model) => model.provider === provider)) throw new Error(`找不到供应商 ${provider}。`);
			saveKey(userHome, provider, key);
		},
		registerProvider(providerOrName: ModelProvider | string, config?: ProviderConfig) {
			if (typeof providerOrName === "string") {
				if (!config) throw new Error(`供应商 ${providerOrName} 缺少配置。`);
				registry.registerProvider(providerOrName, config);
			} else {
				registry.registerProvider(providerOrName.id, providerOrName);
			}
			refreshSelection();
		},
		unregisterProvider(name) {
			if (registry.unregisterProvider(name)) refreshSelection();
		},
	};
	return runtime;
}

function findModelsPath(home: string, env: NodeJS.ProcessEnv): string | undefined {
	const explicit = env.TI_MODELS_FILE?.trim();
	if (explicit) return resolve(explicit);
	const tiPath = join(home, "models.json");
	return existsSync(tiPath) ? tiPath : undefined;
}

function chooseInitialModel(models: readonly TiModel[], stored: string | undefined, env: NodeJS.ProcessEnv): TiModel {
	const saved = stored && findModel(models, stored);
	if (saved) return saved;
	const requested = env.TI_MODEL?.trim();
	const match = requested && findModel(models, requested);
	if (match) return match;
	const provider = env.TI_PROVIDER?.trim().toLowerCase();
	if (provider) {
		const selection = models.find((model) => model.provider.toLowerCase() === provider);
		if (selection) return selection;
	}
	return models[0];
}

function findModel(models: readonly TiModel[], reference: string): TiModel | undefined {
	const query = reference.trim().toLowerCase();
	if (!query) return undefined;
	const qualified = models.find((model) => `${model.provider}/${model.id}`.toLowerCase() === query);
	if (qualified) return qualified;
	const matches = models.filter((model) => model.id.toLowerCase() === query || model.name?.toLowerCase() === query);
	return matches.length === 1 ? matches[0] : undefined;
}

function resolveModelKey(model: TiModel, apiKey: string | undefined, home: string, credentialHomes: readonly string[], env: NodeJS.ProcessEnv): string {
	const stored = readKey(home, model.provider);
	if (stored) return stored;
	const configured = resolveConfiguredKey(apiKey, env);
	if (configured) return configured;
	for (const name of model.apiKeyEnv ?? []) if (env[name]?.trim()) return env[name]!.trim();
	for (const directory of credentialHomes) {
		const legacy = readKey(directory, model.provider);
		if (legacy && !legacy.startsWith("!") && !legacy.includes("$")) return legacy;
	}
	throw new Error(`请用 /login ${model.provider} 保存 API Key，或设置对应的 API Key 环境变量。`);
}

function resolveConfiguredKey(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
	if (!value || value.startsWith("!")) return undefined;
	const match = value.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/);
	return match ? env[match[1] ?? match[2]]?.trim() : value;
}

function saveKey(home: string, provider: string, value: string): void {
	const key = value.trim();
	if (!key || /\s/.test(key)) throw new Error("请输入有效的 API Key。");
	updateJson(join(home, "auth.json"), { [provider]: { type: "api_key", key } });
}

function readKey(home: string, provider: string): string | undefined {
	try {
		const credential = (readJson(join(home, "auth.json")) as Record<string, unknown>)[provider] as { type?: unknown; key?: unknown } | undefined;
		return credential?.type === "api_key" && typeof credential.key === "string" ? credential.key.trim() : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function readSettings(path: string): SettingsJson {
	try {
		return readJson(path) as SettingsJson;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

function defaultModelReference(settings: SettingsJson): string | undefined {
	if (typeof settings.defaultModel !== "string") return undefined;
	return typeof settings.defaultProvider === "string" ? `${settings.defaultProvider}/${settings.defaultModel}` : settings.defaultModel;
}

function writeDefaultModel(path: string, model: TiModel): void {
	updateJson(path, { defaultProvider: model.provider, defaultModel: model.id });
}

function updateJson(path: string, fields: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const lockPath = path + ".lock";
	const lock = openSync(lockPath, "wx", 0o600);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		let existing: Record<string, unknown> = {};
		try {
			existing = readJson(path) as Record<string, unknown>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		writeFileSync(temporary, JSON.stringify({ ...existing, ...fields }, null, 2) + "\n", { mode: 0o600, flag: "wx", flush: true });
		renameSync(temporary, path);
	} finally {
		closeSync(lock);
		rmSync(lockPath);
		rmSync(temporary, { force: true });
	}
}

function readJson(path: string): unknown {
	const contents = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	try {
		const value = JSON.parse(contents);
		if (value && typeof value === "object" && !Array.isArray(value)) return value;
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
	}
	throw new Error(`配置 ${path} 必须是有效的 JSON 对象。`);
}

function clampThinking(levels: readonly ThinkingLevel[], requested: ThinkingLevel): ThinkingLevel {
	if (levels.includes(requested)) return requested;
	const index = STANDARD_THINKING_LEVELS.indexOf(requested);
	return STANDARD_THINKING_LEVELS.slice(index + 1).find((level) => levels.includes(level))
		?? STANDARD_THINKING_LEVELS.slice(0, index).reverse().find((level) => levels.includes(level))
		?? levels[0];
}

function toChoice(model: TiModel): ModelChoice {
	return { provider: model.provider, id: model.id, name: model.name ?? model.id, label: `${model.provider}/${model.id} · ${model.providerName}` };
}
