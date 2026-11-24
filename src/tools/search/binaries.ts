import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function findSearchBinary(tool: "fd" | "rg"): string | undefined {
	const override = tool === "fd" ? process.env.TI_FD_PATH : process.env.TI_RG_PATH;
	if (override) {
		accessSync(override, constants.X_OK);
		return override;
	}
	const windows = process.platform === "win32";
	const names = windows ? [tool + ".exe"] : tool === "fd" ? ["fd", "fdfind"] : ["rg"];
	const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	if (windows && tool === "fd") directories.push("D:\\ruanjian\\fd");
	for (const directory of directories) {
		for (const name of names) {
			const path = join(directory, name);
			try {
				accessSync(path, constants.X_OK);
				return path;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES") throw error;
			}
		}
	}
}
