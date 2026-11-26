import type { AssistantMessage, GenerationEvent, ModelMessage, ToolDeclaration } from "../agent/messages.ts";

export type ModelStream = (
	messages: readonly ModelMessage[],
	options: {
		signal: AbortSignal;
		maxOutputTokens?: number;
		tools?: readonly ToolDeclaration[];
		thinkingLevel?: ThinkingLevel;
		onEvent: (event: GenerationEvent) => void;
	},
) => Promise<AssistantMessage>;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ModelDescriptor {
	provider: string;
	id: string;
	contextWindow: number;
	maxOutputTokens: number;
	api: string;
	baseUrl?: string;
	name?: string;
	apiKeyEnv?: readonly string[];
	headers?: Readonly<Record<string, string>>;
	reasoning?: boolean;
	thinkingLevels?: readonly ThinkingLevel[];
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	defaultThinkingLevel?: ThinkingLevel;
	compat?: { supportsUsageInStreaming?: boolean; maxTokensField?: "max_tokens" | "max_completion_tokens" };
}

export type ProviderStream = (
	model: ModelDescriptor,
	messages: Parameters<ModelStream>[0],
	options: Parameters<ModelStream>[1] & { resolveApiKey: () => string },
) => ReturnType<ModelStream>;

export interface ModelDefinition extends Partial<Omit<ModelDescriptor, "provider" | "id" | "maxOutputTokens">> {
	id: string;
	maxTokens?: number;
}

export interface ModelProvider {
	readonly id: string;
	readonly name?: string;
	readonly apiKey?: string;
	readonly models: readonly ModelDefinition[];
	stream: ProviderStream;
}

export interface ProviderConfig {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Readonly<Record<string, string>>;
	compat?: ModelDescriptor["compat"];
	models?: readonly ModelDefinition[];
	streamSimple?: ProviderStream;
}

export interface ModelRegistrationAPI {
	registerProvider(provider: ModelProvider): void;
	registerProvider(name: string, config: ProviderConfig): void;
	unregisterProvider(name: string): void;
}
