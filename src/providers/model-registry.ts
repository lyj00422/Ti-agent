import { BUILTIN_MODELS } from "./catalog.ts";
import { streamAnthropicReply } from "./anthropic.ts";
import { streamOpenAiCompletions } from "./openai-completions.ts";
import { streamGoogleReply } from "./google.ts";
import type { ModelDefinition, ModelDescriptor, ModelProvider, ProviderConfig, ProviderStream } from "./types.ts";

export interface TiModel extends ModelDescriptor {
	providerName: string;
}

interface FileProvider extends Omit<ProviderConfig, "streamSimple"> {
	modelOverrides?: Readonly<Record<string, Omit<Partial<ModelDefinition>, "id" | "api" | "baseUrl">>>;
}

interface RegisteredProvider {
	models: TiModel[];
	apiKey?: string;
	streamFor(api: string): ProviderStream | undefined;
}

const adapters = new Map<string, ProviderStream>([
	["anthropic-messages", streamAnthropicReply],
	["openai-completions", streamOpenAiCompletions],
	["google-generative-ai", streamGoogleReply],
]);

export const STANDARD_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Compose each provider from its baseline, file configuration, and live extension registration. */
export class ModelRegistry {
	private readonly builtins = Map.groupBy(BUILTIN_MODELS, (model) => model.provider);
	private readonly configured: ReadonlyMap<string, FileProvider>;
	private readonly providers = new Map<string, RegisteredProvider>();
	private readonly extensions = new Map<string, ModelProvider | ProviderConfig>();

	constructor(config: unknown) {
		this.configured = readProviders(config);
		for (const id of new Set([...this.builtins.keys(), ...this.configured.keys()])) {
			this.providers.set(id, this.compose(id));
		}
	}

	list(): TiModel[] {
		return [...this.providers.values()].flatMap((provider) => provider.models);
	}

	get(id: string): RegisteredProvider {
		return this.providers.get(id)!;
	}

	registerProvider(id: string, extension: ModelProvider | ProviderConfig): void {
		if (!/^[\w.-]+$/.test(id)) throw new Error(`供应商 ID 无效：${id}`);
		const previous = this.extensions.get(id);
		const registration = "id" in extension || !previous || "id" in previous
			? extension
			: { ...previous, ...Object.fromEntries(Object.entries(extension).filter(([, value]) => value !== undefined)) };
		const provider = this.compose(id, registration);
		if (!provider.models.length) throw new Error(`供应商 ${id} 必须提供至少一个模型。`);
		this.extensions.set(id, registration);
		this.providers.set(id, provider);
	}

	unregisterProvider(id: string): boolean {
		if (!this.extensions.delete(id)) return false;
		if (this.builtins.has(id) || this.configured.has(id)) this.providers.set(id, this.compose(id));
		else this.providers.delete(id);
		return true;
	}

	private compose(id: string, extension?: ModelProvider | ProviderConfig): RegisteredProvider {
		const file = this.configured.get(id);
		const native = extension && "id" in extension ? extension : undefined;
		const settings = extension && !("id" in extension) ? extension : undefined;
		if (native && typeof native.stream !== "function") throw new Error(`供应商 ${id} 必须提供 stream 函数。`);
		if (settings?.streamSimple !== undefined && (typeof settings.streamSimple !== "function" || !settings.api)) {
			throw new Error(`供应商 ${id} 必须同时提供 streamSimple 函数与 api。`);
		}
		const nativeStream = native?.stream.bind(native);
		const streamFor = (api: string) => nativeStream ??
			(settings?.api === api && settings.streamSimple ? settings.streamSimple : adapters.get(api));
		const builtins = this.builtins.get(id) ?? [];
		const providerName = settings?.name ?? file?.name ?? native?.name ?? builtins[0]?.name ?? id;
		const models = new Map<string, ModelDescriptor>(native
			? native.models.map((definition) => {
				const model = buildModel(id, definition, { api: id });
				return [model.id, model];
			})
			: builtins.map((model) => [model.id, model]));

		if (file) {
			for (const [modelId, model] of models) models.set(modelId, applyDefaults(model, file));
			for (const definition of file.models ?? []) {
				if (!definition || typeof definition.id !== "string" || !definition.id.trim()) {
					throw new Error(`models.json 的供应商 ${id} 包含缺少 id 的模型。`);
				}
				const previous = models.get(definition.id);
				const defaults = previous ?? models.values().next().value;
				const api = definition.api ?? file.api ?? defaults?.api ?? (native ? id : undefined);
				// Shared models.json files may also describe APIs owned by other clients.
				if (api && streamFor(api)) {
					models.set(definition.id, buildModel(id, { ...definition, api }, file, previous, defaults));
				}
			}
		}

		const composed = settings?.models
			? settings.models.map((definition) => buildModel(id, definition, settings, models.get(definition.id), models.values().next().value))
			: [...models.values()].map((model) => settings ? applyDefaults(model, settings) : model);
		const ids = new Set<string>();
		const visible = composed.map((model) => {
			if (ids.has(model.id)) throw new Error(`供应商 ${id} 重复定义模型 ${model.id}。`);
			ids.add(model.id);
			if (!streamFor(model.api)) throw new Error(`模型 ${id}/${model.id} 使用了未注册的 API ${model.api}。`);
			if (!native && !model.baseUrl) throw new Error(`模型 ${id}/${model.id} 缺少 baseUrl。`);
			const override = file?.modelOverrides && Object.hasOwn(file.modelOverrides, model.id) ? file.modelOverrides[model.id] : undefined;
			return {
				...(override ? buildModel(id, { ...override, id: model.id, api: model.api, baseUrl: model.baseUrl }, {}, model) : model),
				providerName,
			};
		});
		return { models: visible, apiKey: settings?.apiKey ?? file?.apiKey ?? native?.apiKey, streamFor };
	}
}

function applyDefaults(model: ModelDescriptor, config: ProviderConfig): ModelDescriptor {
	return {
		...model,
		baseUrl: config.baseUrl ?? model.baseUrl,
		headers: { ...model.headers, ...config.headers },
		compat: { ...model.compat, ...config.compat },
	};
}

function buildModel(
	provider: string, definition: ModelDefinition, config: ProviderConfig,
	previous?: ModelDescriptor, defaults = previous,
): ModelDescriptor {
	const id = definition.id;
	const api = definition.api ?? config.api ?? defaults?.api;
	if (typeof id !== "string" || !id.trim() || typeof api !== "string" || !api.trim()) {
		throw new Error(`供应商 ${provider} 的模型缺少 id 或 api。`);
	}
	const contextWindow = definition.contextWindow ?? previous?.contextWindow ?? 128_000;
	const maxOutputTokens = definition.maxTokens ?? previous?.maxOutputTokens ?? 16_384;
	if (![contextWindow, maxOutputTokens].every((value) => Number.isSafeInteger(value) && value > 0)) {
		throw new Error(`模型 ${provider}/${id} 的 token 上限必须为正整数。`);
	}
	const thinkingLevelMap = definition.thinkingLevelMap
		? { ...previous?.thinkingLevelMap, ...definition.thinkingLevelMap }
		: previous?.thinkingLevelMap;
	const thinkingLevels = definition.thinkingLevels ?? (definition.thinkingLevelMap
		? STANDARD_THINKING_LEVELS.filter((level) => {
			const value = thinkingLevelMap?.[level];
			return value !== null && (value !== undefined || (level !== "xhigh" && level !== "max"));
		})
		: previous?.thinkingLevels);
	return {
		provider, id, api, contextWindow, maxOutputTokens, thinkingLevelMap, thinkingLevels,
		name: definition.name ?? previous?.name ?? id,
		baseUrl: definition.baseUrl ?? config.baseUrl ?? defaults?.baseUrl,
		apiKeyEnv: definition.apiKeyEnv ?? previous?.apiKeyEnv,
		reasoning: definition.reasoning ?? previous?.reasoning,
		defaultThinkingLevel: definition.defaultThinkingLevel ?? previous?.defaultThinkingLevel,
		headers: { ...previous?.headers, ...config.headers, ...definition.headers },
		compat: { ...previous?.compat, ...config.compat, ...definition.compat },
	};
}

function readProviders(config: unknown): ReadonlyMap<string, FileProvider> {
	const providers = (config as { providers?: unknown }).providers;
	if (providers === undefined) return new Map();
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
		throw new Error("models.json 的 providers 必须是对象。");
	}
	return new Map(Object.entries(providers).map(([id, provider]) => {
		if (!provider || typeof provider !== "object" || Array.isArray(provider) ||
			(provider.models !== undefined && !Array.isArray(provider.models))) {
			throw new Error(`models.json 的供应商 ${id} 配置无效。`);
		}
		// Only file-defined fields enter composition. Stream callbacks are registered by extensions.
		const { name, api, apiKey, baseUrl, headers, compat, models, modelOverrides } = provider as FileProvider;
		return [id, { name, api, apiKey, baseUrl, headers, compat, models, modelOverrides }];
	}));
}
