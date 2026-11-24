// See THIRD_PARTY_NOTICES.md for licensing.
/**
 * Tool output files preserve content so the model can use output it was not shown in full, such as the
 * full text of truncated shell output.
 * Every output file is created here, so where they are stored can change in one place. Today they
 * go to the OS temp directory.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Output can carry private data, so only the user may read the files. */
const OUTPUT_FILE_MODE = 0o600;

/** A new, unused path: `<dir>/<prefix>-<random hex><extension>`. `extension` includes the dot. */
function createOutputFilePath(prefix: string, extension: string): string {
	return join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}${extension}`);
}

/** Open a new output file for streamed output. */
export function createOutputFileStream(prefix: string, extension: string): { path: string; stream: WriteStream } {
	const path = createOutputFilePath(prefix, extension);
	return { path, stream: createWriteStream(path, { mode: OUTPUT_FILE_MODE, flags: "wx" }) };
}
