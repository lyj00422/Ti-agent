import { spawn } from "node:child_process";
import { win32 } from "node:path";
import { waitForChildProcess } from "./child-process.ts";
import { resolveTimeoutMs, ShellTimeoutError, type ShellOperations } from "./shell-tool.ts";

const groupMarker = "TI_WSL_GROUP ";
const launch = "printf 'TI_WSL_GROUP %d\\n' \"$$\" >&2\nexec /bin/bash --noprofile --norc -s";
export const wslExecutable = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "wsl.exe");
export const wslDistribution = "Ubuntu-24.04";

export function createWslBashOperations(): ShellOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			signal?.throwIfAborted();
			const timeoutMs = resolveTimeoutMs(timeout);
			const distribution = ["--distribution", wslDistribution];
			const child = spawn(wslExecutable, [
				...distribution, "--cd", cwd, "--exec", "/usr/bin/setsid", "--wait",
				"/bin/bash", "--noprofile", "--norc", "-c", launch,
			], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

			let group: string | undefined;
			let pending = Buffer.alloc(0);
			let timedOut = false;
			let cancellation: Promise<number | null> | undefined;
			const stop = () => {
				if (!group) {
					child.stdin.end();
					child.kill();
					return;
				}
				if (cancellation) return;
				cancellation = waitForChildProcess(spawn(wslExecutable, [
					...distribution, "--exec", "/bin/kill", "-KILL", "--", "-" + group,
				], { stdio: "ignore", windowsHide: true }));
				// If the launcher exits while cancellation is in flight, its error is reported below.
				void cancellation.catch(() => child.kill());
			};

			child.stdout.on("data", onData);
			child.stderr.on("data", (chunk: Buffer) => {
				if (group) {
					onData(chunk);
					return;
				}
				pending = Buffer.concat([pending, chunk]);
				let newline = pending.indexOf(10);
				while (newline >= 0) {
					const line = pending.subarray(0, newline + 1);
					pending = pending.subarray(newline + 1);
					const text = line.toString().trim();
					const candidate = text.startsWith(groupMarker) ? text.slice(groupMarker.length) : "";
					if (/^[1-9]\d*$/.test(candidate)) {
						group = candidate;
						if (timedOut || signal?.aborted) stop();
						else child.stdin.end(command + "\n");
						if (pending.length) onData(pending);
						pending = Buffer.alloc(0);
						return;
					}
					onData(line);
					newline = pending.indexOf(10);
				}
			});
			const stdinError = new Promise<never>((_, reject) => {
				child.stdin.on("error", (error: NodeJS.ErrnoException) => {
					if (error.code !== "EPIPE") reject(error);
				});
			});
			const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
				timedOut = true;
				stop();
			}, timeoutMs);
			signal?.addEventListener("abort", stop, { once: true });
			try {
				const exitCode = await Promise.race([waitForChildProcess(child), stdinError]);
				await cancellation;
				if (pending.length) onData(pending);
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new ShellTimeoutError(timeout, undefined);
				return { exitCode };
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", stop);
			}
		},
	};
}
