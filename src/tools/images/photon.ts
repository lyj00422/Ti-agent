import type * as photon from "@silvia-odwyer/photon-node";
import { createRequire } from "node:module";

export type { PhotonImage as PhotonImageType } from "@silvia-odwyer/photon-node";

const require = createRequire(import.meta.url);

export async function loadPhoton(): Promise<typeof photon> {
	return require("@silvia-odwyer/photon-node");
}
