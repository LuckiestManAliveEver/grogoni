#!/usr/bin/env node
// Bundles the on-device WhatsApp Linked Devices sidecar from repository source into one ESM
// file for the Android app's assets. The bundle reuses the API's connector, vault, cipher and
// Baileys driver modules unchanged (services/api/src/messaging/whatsapp-linked/sidecar/entry.ts).
//
// Usage: node apps/android/scripts/build-whatsapp-sidecar.mjs --out <assets dir>
// Writes <out>/whatsapp-sidecar/sidecar.mjs, THIRD-PARTY-NOTICES.txt and manifest.json.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const outIndex = process.argv.indexOf("--out");
if (outIndex < 0 || !process.argv[outIndex + 1]) {
  console.error("usage: build-whatsapp-sidecar.mjs --out <assets dir>");
  process.exit(2);
}
const out = join(resolve(process.argv[outIndex + 1]), "whatsapp-sidecar");
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite", { paths: [repo] }));
const { build } = viteRequire("esbuild");

// Optional Baileys peers for media thumbnails, audio and link previews. The device sidecar is
// text-only, so they are left out; Baileys loads them lazily and only on those paths.
const optionalPeers = ["sharp", "jimp", "link-preview-js", "audio-decode", "qrcode-terminal"];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const outfile = join(out, "sidecar.mjs");
const result = await build({
  entryPoints: [join(repo, "services/api/src/messaging/whatsapp-linked/sidecar/entry.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "external",
  external: optionalPeers,
  metafile: true,
  // CommonJS dependencies call require(); give the ESM bundle a real one.
  banner: {
    js: 'import { createRequire as sidecarCreateRequire } from "node:module"; const require = sidecarCreateRequire(import.meta.url);'
  },
  logLevel: "warning"
});
const bytes = readFileSync(outfile);
const inputs = Object.keys(result.metafile.inputs);
const pkg = (name) =>
  JSON.parse(
    readFileSync(
      join(
        dirname(
          createRequire(join(repo, "services/api/package.json")).resolve(`${name}/package.json`)
        ),
        "package.json"
      ),
      "utf8"
    )
  ).version;
const manifest = {
  entry: "sidecar.mjs",
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  minimumNode: "20.0.0",
  baileys: pkg("baileys"),
  inputs: inputs.length,
  connectorModules: inputs.filter((path) => path.includes("messaging/whatsapp-linked/")).sort()
};
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
// Every npm package that contributed code to the bundle, with its declared license and text.
// Minification strips most in-file notices, so the APK carries them here instead.
const packages = new Map();
for (const input of inputs) {
  const match = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input);
  if (!match || packages.has(match[1])) continue;
  const root = join(repo, match[1]);
  const meta = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const licenseFile = readdirSync(root).find((name) => /^(licen[cs]e|copying|notice)/i.test(name));
  packages.set(match[1], {
    name: meta.name ?? match[2],
    version: meta.version ?? "unknown",
    license:
      typeof meta.license === "string" ? meta.license : JSON.stringify(meta.license ?? "UNKNOWN"),
    text: licenseFile ? readFileSync(join(root, licenseFile), "utf8").trim() : null
  });
}
const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
const unknown = sorted.filter((entry) => entry.license === '"UNKNOWN"' && !entry.text);
if (unknown.length)
  throw new Error(`Bundled packages without license data: ${unknown.map((e) => e.name)}`);
const legalPath = `${outfile}.LEGAL.txt`;
const extracted = existsSync(legalPath) ? readFileSync(legalPath, "utf8").trim() : "";
writeFileSync(
  join(out, "THIRD-PARTY-NOTICES.txt"),
  [
    "Third-party software bundled in the Grogoni WhatsApp sidecar (sidecar.mjs).",
    "Note: libsignal declares GPL-3.0. Distribution review is a release prerequisite.",
    "",
    ...sorted.map(
      (entry) =>
        `== ${entry.name}@${entry.version} (${entry.license})\n${entry.text ?? "No license file shipped; see the declared license."}\n`
    ),
    extracted ? `== Extracted legal comments\n${extracted}\n` : ""
  ].join("\n")
);
rmSync(legalPath, { force: true });
manifest.packages = sorted.map((entry) => `${entry.name}@${entry.version} ${entry.license}`);
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `whatsapp sidecar: ${manifest.bytes} bytes, sha256 ${manifest.sha256.slice(0, 16)}, ` +
    `${manifest.inputs} inputs from ${sorted.length} packages`
);
