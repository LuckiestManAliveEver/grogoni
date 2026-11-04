import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
if (!process.argv.includes("--from-dist"))
  execFileSync(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "build"], {
    cwd: join(root, "apps/web"),
    stdio: "inherit",
    env: { ...process.env, VITE_API_BASE_URL: "https://grogoni.com/api" }
  });
const source = join(root, "apps/web/dist");
if (!existsSync(join(source, "index.html"))) throw new Error("Build the shared web app first.");
const destination = join(root, "apps/android/app/src/main/assets/web");
// This directory contains generated copies only; it is never a second source tree.
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
// AAPT excludes hidden directories; Vite's build manifest is not a runtime asset.
cpSync(source, destination, {
  recursive: true,
  filter: (path) => !basename(path).startsWith(".")
});
const files = {};
function hash(directory, prefix = "") {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // Android's asset merger decompresses and renames .gz files. Preserve the web
    // bytes under an opaque packaging suffix; the host maps the original URL.
    if (entry.isFile() && entry.name.endsWith(".gz")) {
      renameSync(join(directory, entry.name), join(directory, `${entry.name}.bin`));
      entry.name += ".bin";
    }
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) hash(join(directory, entry.name), `${name}/`);
    else
      files[name] = createHash("sha256")
        .update(readFileSync(join(directory, entry.name)))
        .digest("hex");
  }
}
hash(destination);
writeFileSync(
  join(root, "apps/android/app/src/main/assets/web-bundle.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      source: "apps/web",
      apiOrigin: "https://grogoni.com/api",
      files
    },
    null,
    2
  ) + "\n"
);
console.log(`Bundled ${Object.keys(files).length} shared web assets for Android.`);
