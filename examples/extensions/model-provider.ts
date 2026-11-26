import type { ExtensionAPI, ProviderConfig } from "../../src/sdk.ts";

export default function (ti: ExtensionAPI): void {
	ti.registerProvider("acme", {
		name: "Acme AI",
		baseUrl: "https://api.acme.example/v1",
		apiKey: "$ACME_API_KEY",
		api: "openai-completions",
		models: [
			{
				id: "acme-chat",
				name: "Acme Chat",
				contextWindow: 128_000,
				maxTokens: 8_192,
				reasoning: false,
			},
		],
	} satisfies ProviderConfig);
}
