import type { ModelDescriptor } from "./types.ts";

const effortLevels = ["off", "low", "medium", "high"] as const;
const openAiLevels = ["off", "low", "medium", "high", "xhigh"] as const;

/** Ti-owned defaults for common API-key model services. */
export const BUILTIN_MODELS: readonly ModelDescriptor[] = [
	{
		provider: "openai", name: "OpenAI", api: "openai-completions", baseUrl: "https://api.openai.com/v1",
		apiKeyEnv: ["OPENAI_API_KEY"], id: "gpt-5.2", contextWindow: 400_000, maxOutputTokens: 128_000,
		reasoning: true, thinkingLevels: openAiLevels, compat: { maxTokensField: "max_completion_tokens" },
	},
	{
		provider: "anthropic", name: "Anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com",
		apiKeyEnv: ["ANTHROPIC_API_KEY"], id: "claude-sonnet-4-5", contextWindow: 200_000, maxOutputTokens: 64_000,
		reasoning: true, thinkingLevels: effortLevels,
	},
	{
		provider: "google", name: "Google Gemini", api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		apiKeyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], id: "gemini-2.5-flash", contextWindow: 1_048_576, maxOutputTokens: 65_536,
		reasoning: true, thinkingLevels: effortLevels,
	},
	{
		provider: "openrouter", name: "OpenRouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1",
		apiKeyEnv: ["OPENROUTER_API_KEY"], id: "openai/gpt-5.2", contextWindow: 256_000, maxOutputTokens: 64_000,
		reasoning: true, thinkingLevels: openAiLevels,
	},
	{
		provider: "moonshotai", name: "Moonshot AI", api: "openai-completions", baseUrl: "https://api.moonshot.ai/v1",
		apiKeyEnv: ["MOONSHOT_API_KEY"], id: "kimi-k2.5", contextWindow: 256_000, maxOutputTokens: 32_768,
		reasoning: true, thinkingLevels: effortLevels,
	},
	{
		provider: "moonshotai-cn", name: "Moonshot AI China", api: "openai-completions", baseUrl: "https://api.moonshot.cn/v1",
		apiKeyEnv: ["MOONSHOT_API_KEY"], id: "kimi-k2.5", contextWindow: 256_000, maxOutputTokens: 32_768,
		reasoning: true, thinkingLevels: effortLevels,
	},
	{
		provider: "qwen", name: "Alibaba Cloud Bailian", api: "openai-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		apiKeyEnv: ["DASHSCOPE_API_KEY"], id: "qwen3.5-plus", contextWindow: 1_000_000, maxOutputTokens: 65_536,
		reasoning: true, thinkingLevels: effortLevels,
	},
	{
		provider: "kimi-coding", name: "Kimi For Coding", api: "openai-completions", baseUrl: "https://api.kimi.com/coding/v1",
		apiKeyEnv: ["KIMI_API_KEY"], id: "kimi-for-coding", contextWindow: 256_000, maxOutputTokens: 32_768,
		reasoning: true, thinkingLevels: effortLevels,
	},
	{
		provider: "deepseek", name: "DeepSeek", api: "openai-completions", baseUrl: "https://api.deepseek.com",
		apiKeyEnv: ["DEEPSEEK_API_KEY"], id: "deepseek-flash", contextWindow: 1_000_000, maxOutputTokens: 16_384,
		reasoning: true, thinkingLevels: ["off", "low", "high", "max"],
		thinkingLevelMap: { low: "low", high: "high", max: "max" },
		defaultThinkingLevel: "off",
	},
	{
		provider: "groq", name: "Groq", api: "openai-completions", baseUrl: "https://api.groq.com/openai/v1",
		apiKeyEnv: ["GROQ_API_KEY"], id: "openai/gpt-oss-120b", contextWindow: 131_072, maxOutputTokens: 32_768,
	},
	{
		provider: "mistral", name: "Mistral", api: "openai-completions", baseUrl: "https://api.mistral.ai/v1",
		apiKeyEnv: ["MISTRAL_API_KEY"], id: "devstral-medium-latest", contextWindow: 131_072, maxOutputTokens: 32_768,
	},
	{
		provider: "siliconflow", name: "SiliconFlow", api: "openai-completions", baseUrl: "https://api.siliconflow.cn/v1",
		apiKeyEnv: ["SILICONFLOW_API_KEY"], id: "deepseek-ai/DeepSeek-V3.2", contextWindow: 163_840, maxOutputTokens: 32_768,
		reasoning: true, thinkingLevels: effortLevels,
	},
	{
		provider: "together", name: "Together AI", api: "openai-completions", baseUrl: "https://api.together.xyz/v1",
		apiKeyEnv: ["TOGETHER_API_KEY"], id: "moonshotai/Kimi-K2.5", contextWindow: 262_144, maxOutputTokens: 32_768,
		reasoning: true, thinkingLevels: effortLevels,
	},
	{
		provider: "cerebras", name: "Cerebras", api: "openai-completions", baseUrl: "https://api.cerebras.ai/v1",
		apiKeyEnv: ["CEREBRAS_API_KEY"], id: "zai-glm-4.7", contextWindow: 131_072, maxOutputTokens: 16_384,
	},
	{
		provider: "fireworks", name: "Fireworks AI", api: "openai-completions", baseUrl: "https://api.fireworks.ai/inference/v1",
		apiKeyEnv: ["FIREWORKS_API_KEY"], id: "accounts/fireworks/models/deepseek-v3p2", contextWindow: 163_840, maxOutputTokens: 32_768,
		reasoning: true, thinkingLevels: effortLevels,
	},
	{
		provider: "xai", name: "xAI", api: "openai-completions", baseUrl: "https://api.x.ai/v1",
		apiKeyEnv: ["XAI_API_KEY"], id: "grok-4-1-fast", contextWindow: 2_000_000, maxOutputTokens: 32_768,
		reasoning: true, thinkingLevels: effortLevels,
	},
	{
		provider: "zai", name: "Z.AI", api: "openai-completions", baseUrl: "https://api.z.ai/api/paas/v4",
		apiKeyEnv: ["ZAI_API_KEY"], id: "glm-5", contextWindow: 200_000, maxOutputTokens: 32_768,
		reasoning: true, thinkingLevels: effortLevels,
	},
	{
		provider: "zai-coding-cn", name: "Z.AI Coding Plan China", api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		apiKeyEnv: ["ZAI_CODING_CN_API_KEY"], id: "glm-5", contextWindow: 200_000, maxOutputTokens: 32_768,
		reasoning: true, thinkingLevels: effortLevels,
	},
	{
		provider: "minimax", name: "MiniMax", api: "anthropic-messages", baseUrl: "https://api.minimax.io/anthropic",
		apiKeyEnv: ["MINIMAX_API_KEY"], id: "MiniMax-M2.5", contextWindow: 1_000_000, maxOutputTokens: 65_536,
		reasoning: true, thinkingLevels: effortLevels,
	},
	{
		provider: "minimax-cn", name: "MiniMax China", api: "anthropic-messages", baseUrl: "https://api.minimaxi.com/anthropic",
		apiKeyEnv: ["MINIMAX_CN_API_KEY"], id: "MiniMax-M2.5", contextWindow: 1_000_000, maxOutputTokens: 65_536,
		reasoning: true, thinkingLevels: effortLevels,
	},
	{
		provider: "nvidia", name: "NVIDIA NIM", api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1",
		apiKeyEnv: ["NVIDIA_API_KEY"], id: "nvidia/llama-3.3-nemotron-super-49b-v1", contextWindow: 131_072, maxOutputTokens: 16_384,
	},
];
