import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { MAX_STACK_SIZE, QuickJS } from "quickjs-wasi";

interface WorkerInput {
	code: string;
	tools: Array<{ name: string; description: string; parameters: object }>;
}

interface WorkerResponse {
	type: "tool_result";
	id: number;
	result?: unknown;
	error?: string;
}

const input = workerData as WorkerInput;
const port = parentPort!;
const pending = new Map<number, ReturnType<QuickJS["newPromise"]>>();
let nextCallId = 0;
const deadline = Date.now() + 60_000;

const vm = await QuickJS.create({
	wasm: await WebAssembly.compile(await import("node:fs/promises").then(({ readFile }) =>
		readFile(createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")))),
	memoryLimit: 128 * 1024 * 1024,
	maxStackSize: MAX_STACK_SIZE,
	interruptHandler: () => Date.now() >= deadline,
	wasi: (memory) => ({
		fd_write(_fd: number, iovsPointer: number, iovsLength: number, writtenPointer: number) {
			const view = new DataView(memory.buffer);
			let written = 0;
			for (let index = 0; index < iovsLength; index++) written += view.getUint32(iovsPointer + index * 8 + 4, true);
			view.setUint32(writtenPointer, written, true);
			return 0;
		},
	}),
});

const requestTool = vm.newFunction("requestTool", (name, serializedInput) => {
	const id = ++nextCallId;
	const deferred = vm.newPromise();
	pending.set(id, deferred);
	port.postMessage({ type: "tool_call", id, name: name.toString(), input: serializedInput.toString() });
	return deferred.handle;
});
vm.setProp(vm.global, "requestTool", requestTool);
requestTool.dispose();

const output = vm.newFunction("writeOutput", (kind, value) => {
	port.postMessage({ type: "output", kind: kind.toString(), value: value.toString() });
	return vm.undefined;
});
vm.setProp(vm.global, "writeOutput", output);
output.dispose();

const toolCatalog = JSON.stringify(input.tools);
const bootstrap = `
const catalog = ${toolCatalog};
globalThis.ALL_TOOLS = catalog.map(({ name, description }) => ({ name, description }));
globalThis.tools = new Proxy(Object.create(null), {
  get(_target, property) {
    if (property === "then") return undefined;
    return (args = {}) => requestTool(String(property), JSON.stringify(args)).then((raw) => {
      const result = JSON.parse(raw);
      if (result.isError) throw new Error(result.error || result.content || "Tool call failed");
      return result.value;
    });
  }
});
globalThis.searchTools = async (query, options = {}) => {
  const terms = String(query).toLowerCase().split(/\\s+/).filter(Boolean);
  const limit = options.limit ?? 8;
  return catalog.filter((tool) => terms.every((term) =>
    (tool.name + " " + tool.description).toLowerCase().includes(term)
  )).slice(0, limit).map(({ name, description }) => ({ name, description }));
};
globalThis.describeTool = async (name) => catalog.find((tool) => tool.name === name);
globalThis.text = (value) => writeOutput("text", String(value));
globalThis.image = (value) => writeOutput("image", JSON.stringify(value));
globalThis.console = { log: (...values) => writeOutput("console", values.map(String).join(" ")) };
`;

port.on("message", (message: WorkerResponse) => {
	if (message.type !== "tool_result") return;
	const deferred = pending.get(message.id);
	if (!deferred) return;
	pending.delete(message.id);
	if (message.error !== undefined) deferred.reject(vm.newError(message.error));
	else deferred.resolve(vm.newString(JSON.stringify(message.result)));
	vm.executePendingJobs();
});

try {
	vm.evalCode(bootstrap, "codemode-bootstrap.js").dispose();
	const execution = vm.evalCode(`(async () => { ${input.code}\n })()`, "codemode.js");
	vm.executePendingJobs();
	const result = await vm.resolvePromise(execution);
	if ("error" in result) {
		port.postMessage({ type: "complete", error: result.error.toString() });
		result.error.dispose();
	} else {
		port.postMessage({ type: "complete", value: result.value.toString() });
		result.value.dispose();
	}
} catch (error) {
	port.postMessage({ type: "complete", error: error instanceof Error ? error.message : String(error) });
} finally {
	vm.dispose();
	port.close();
}
