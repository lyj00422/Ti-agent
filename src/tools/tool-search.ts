// Adapted from Pi 1.5.2. See THIRD_PARTY_NOTICES.md.
import { Type } from "typebox";
import type { ToolDefinition, ToolInfo } from "./registry.ts";

export const TOOL_SEARCH_NAME = "tool_search";
const SEARCH_LIMIT = 8;
const parameters = Type.Object({
	query: Type.String({ description: "Tool name or a short description of the required capability." }),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SEARCH_LIMIT })),
});

export function createToolSearch(candidates: readonly ToolInfo[]): ToolDefinition<typeof parameters, { loaded: string[] }> {
	return {
		name: TOOL_SEARCH_NAME,
		label: "Tool search",
		description: "Find deferred MCP tools by tool name or capability. Matching tools are available from the next model request. Use English capability terms when descriptions are in English.",
		parameters,
		async execute(_id, { query, limit = SEARCH_LIMIT }) {
			if (query.trim() === "") throw new Error("搜索词不能为空。");
			const tools = new Map(candidates.map((tool) => [tool.name, tool]));
			const matches = new Bm25Ranker().rank(query, candidates.map(createToolSearchDocument), limit);
			const lines = matches.map(({ name }) => {
				const summary = tools.get(name)?.description.trim().split(/\r?\n/, 1)[0].slice(0, 240);
				return `- ${name}: ${summary ?? ""}`;
			});
			const text = lines.length ? "Available on the next model request:\n" + lines.join("\n") : "No matching tools found.";
			return { content: [{ type: "text", text }], details: { loaded: matches.map(({ name }) => name) } };
		},
	};
}

interface ToolSearchDocument {
	name: string;
	text: string;
	namespaceText: string;
}

interface ToolSearchMatch {
	name: string;
	score: number;
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

const STOP_WORDS: ReadonlySet<string> = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"with",
]);

/** Naive singular form, so `issues` matches `issue` and `searches` matches `search`. */
function stem(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	return term;
}

/** Unicode word segmentation with identifier boundaries and English stop words/singular forms. */
function tokenize(text: string): string[] {
	const normalized = text
		.normalize("NFC")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ");
	// The segmenter costs about 15 times a split. Plain ASCII splits into the same words at spaces, so only other
	// text, such as Chinese written without spaces, goes through it.
	const words = /^[a-z0-9 ]*$/.test(normalized)
		? normalized.split(" ")
		: Array.from(wordSegmenter.segment(normalized), (segment) => (segment.isWordLike ? segment.segment : ""));
	return words
		.filter((word) => word.length > 0 && !STOP_WORDS.has(word))
		.map((word) => (/^[a-z0-9]+$/.test(word) ? stem(word) : word));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Schema descriptions and property names, recursively, following local `$ref`s into `root`. `seen` holds the
 * subschemas already reached through a reference, so recursive and shared definitions are read once, and
 * definitions no property references are not read.
 */
function schemaText(schema: unknown, root: unknown, parts: string[], seen: Set<unknown>): void {
	if (!isObject(schema)) return;
	if (typeof schema.$ref === "string") {
		const target = resolveSchemaRef(schema.$ref, root);
		if (isObject(target) && !seen.has(target)) {
			seen.add(target);
			schemaText(target, root, parts, seen);
		}
	}
	if (typeof schema.description === "string") parts.push(schema.description);
	if (isObject(schema.properties)) {
		for (const [name, property] of Object.entries(schema.properties)) {
			parts.push(name);
			schemaText(property, root, parts, seen);
		}
	}
	schemaText(schema.items, root, parts, seen);
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const variants = schema[key];
		if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, root, parts, seen);
	}
}

/**
 * Search text of a tool: the description and the schema descriptions and property names, and
 * separately the namespace name, description, and instructions. The ranker reads the name from `name`.
 */
function createToolSearchDocument(tool: ToolInfo): ToolSearchDocument {
	const parts = [tool.description];
	schemaText(tool.parameters, tool.parameters, parts, new Set([tool.parameters]));
	const namespaceText = tool.source.type === "mcp" ? tool.source.server : "";
	return { name: tool.name, text: parts.filter((part) => part.trim()).join(" "), namespaceText };
}

/** Lowercase with characters invalid in script identifiers as `_`, so `dev-radius` matches `dev_radius`. */
function normalizeName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_$]/g, "_");
}

/**
 * Whether the whole query is the tool's name: its full name or a suffix after a `__` separator, so
 * `thread_read` and `app__thread_read` both name `mcp__app__thread_read`.
 */
function isExactNameQuery(query: string, name: string): boolean {
	const normalized = normalizeName(name);
	return normalized === query || normalized.endsWith(`__${query}`);
}

/** A document split into the fields the ranker weighs differently. */
interface IndexedDocument {
	name: string;
	/** Terms of the name, for example `mcp`, `app`, `thread`, `read` for `mcp__app__thread_read`. */
	nameTerms: ReadonlySet<string>;
	/** Terms of the last `__` segment of the name, the part models say: `thread`, `read`. */
	localNameTerms: readonly string[];
	textCounts: ReadonlyMap<string, number>;
	textLength: number;
	namespaceTerms: ReadonlySet<string>;
}

function indexDocument(document: ToolSearchDocument): IndexedDocument {
	const textCounts = new Map<string, number>();
	for (const term of tokenize(document.text)) textCounts.set(term, (textCounts.get(term) ?? 0) + 1);
	const segments = document.name.split("__");
	return {
		name: document.name,
		nameTerms: new Set(tokenize(document.name)),
		localNameTerms: [...new Set(tokenize(segments[segments.length - 1]))],
		textCounts,
		textLength: [...textCounts.values()].reduce((sum, count) => sum + count, 0),
		namespaceTerms: new Set(tokenize(document.namespaceText ?? "")),
	};
}

/**
 * A query term in the name counts this many times its IDF. The text part of a term is at most
 * `k1 + 1` (2.2) times its IDF and about 1 for a single mention, so a name match beats any number of
 * mentions in the description.
 */
const NAME_WEIGHT = 3;

/**
 * A query term in the namespace name, description, or instructions counts this many times its IDF. They
 * are shared by every tool of the server, so they help find the server but not the tool in it.
 */
const NAMESPACE_WEIGHT = 0.5;

/**
 * Okapi BM25 over the description, with the name and the namespace as separate fields:
 * - a tool that matches more of the query's terms, in any field, ranks above one that matches
 *   fewer, whatever their scores: for `screenshot window`, a tool whose description has both words
 *   beats `window`, whose name has one;
 * - a query term in the name scores more than any number of mentions in the description;
 * - a tool whose whole local name is in the query (`app` in `peekaboo app` for
 *   `mcp__peekaboo__app`) gets a bonus worth one more match of every query term, so among tools
 *   matching as many terms it mostly wins over tools that only mention the words;
 * - a query that is exactly a tool's name ranks that tool first, before coverage.
 *
 * The description alone is length-normalized, so a long name or long namespace instructions do
 * not lower a tool's score. Ties keep document order.
 */
class Bm25Ranker {
	private readonly k1: number;
	private readonly b: number;

	constructor(options: { k1?: number; b?: number } = {}) {
		this.k1 = options.k1 ?? 1.2;
		this.b = options.b ?? 0.75;
	}

	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[] {
		const queryTerms = new Set(tokenize(query));
		if (queryTerms.size === 0 || documents.length === 0 || limit <= 0) return [];
		const indexed = documents.map(indexDocument);
		const averageLength = indexed.reduce((sum, document) => sum + document.textLength, 0) / indexed.length || 1;
		const idf = new Map(
			[...queryTerms].map((term) => {
				const frequency = indexed.filter(
					(document) =>
						document.nameTerms.has(term) || document.textCounts.has(term) || document.namespaceTerms.has(term),
				).length;
				return [term, Math.log(1 + (indexed.length - frequency + 0.5) / (frequency + 0.5))] as const;
			}),
		);
		const fullNameBonus = [...idf.values()].reduce((sum, value) => sum + value, 0);
		const exactQuery = normalizeName(query);
		const matches: (ToolSearchMatch & { covered: number; exact: boolean })[] = [];
		for (const document of indexed) {
			const norm = this.k1 * (1 - this.b + (this.b * document.textLength) / averageLength);
			let score = 0;
			let covered = 0;
			for (const term of queryTerms) {
				const count = document.textCounts.get(term) ?? 0;
				const weight =
					(document.nameTerms.has(term) ? NAME_WEIGHT : 0) +
					(document.namespaceTerms.has(term) ? NAMESPACE_WEIGHT : 0) +
					(count * (this.k1 + 1)) / (count + norm);
				if (weight > 0) covered++;
				score += (idf.get(term) ?? 0) * weight;
			}
			if (score === 0) continue;
			const local = document.localNameTerms;
			if (local.length > 0 && local.every((term) => queryTerms.has(term))) score += fullNameBonus;
			matches.push({ name: document.name, score, covered, exact: isExactNameQuery(exactQuery, document.name) });
		}
		return matches
			.sort((a, b) => Number(b.exact) - Number(a.exact) || b.covered - a.covered || b.score - a.score)
			.slice(0, limit)
			.map(({ name, score }) => ({ name, score }));
	}
}

function resolveSchemaRef(ref: string, root: unknown): unknown {
	if (ref !== "#" && !ref.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const segment of ref.slice(2).split("/").filter(Boolean)) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			// Schemas come from tools and MCP servers: a malformed escape names nothing instead of failing the caller.
			return undefined;
		}
		const key = decoded.replaceAll("~1", "/").replaceAll("~0", "~");
		if (typeof current !== "object" || current === null || Array.isArray(current) || !Object.hasOwn(current, key)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}
