import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

export interface BuildManifest {
  gitCommitSha: string;
  buildTimestamp: string;
  runtimeArchitecture: string;
}

// Written by scripts/write-build-manifest.mjs as the last step of `pnpm --filter @grogoni/api
// build`, right next to this module's own compiled output, so it always describes the dist
// this process is actually running from - see docs/architecture/native-runtime-deployment.md.
export function readBuildManifest(): BuildManifest | null {
  try {
    const manifestPath = fileURLToPath(new URL("./build-manifest.json", import.meta.url));
    return JSON.parse(readFileSync(manifestPath, "utf8")) as BuildManifest;
  } catch {
    return null;
  }
}
