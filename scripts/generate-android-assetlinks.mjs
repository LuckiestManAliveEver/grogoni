import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageName = "market.grogoni.app";
const targetDir = join(workspaceRoot, "apps/web/public/.well-known");
const storeFile = process.env.GROGONI_RELEASE_STORE_FILE;
const keyAlias = process.env.GROGONI_RELEASE_KEY_ALIAS || "grogoni";
const storePassword = process.env.GROGONI_RELEASE_STORE_PASSWORD || "changeit";

mkdirSync(targetDir, { recursive: true });

let fingerprint = process.env.GROGONI_RELEASE_CERT_SHA256;
if (!fingerprint && storeFile && existsSync(storeFile)) {
  fingerprint = extractFingerprint(storeFile, keyAlias, storePassword);
}

if (!fingerprint) {
  fingerprint =
    "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
}

const payload = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: packageName,
      sha256_cert_fingerprints: [fingerprint]
    }
  }
];

writeFileSync(join(targetDir, "assetlinks.json"), `${JSON.stringify(payload, null, 2)}\n`);
console.log(
  `Wrote Android App Links for ${packageName} to apps/web/public/.well-known/assetlinks.json`
);
console.log(
  "Replace the placeholder fingerprint with the release certificate fingerprint before public release."
);

function extractFingerprint(storePath, alias, password) {
  const output = execSync(
    `keytool -list -v -keystore "${storePath}" -alias "${alias}" -storepass "${password}"`,
    { encoding: "utf8" }
  );
  const match = output.match(/SHA256:\s*([A-F0-9:]+)/i);
  if (!match) {
    throw new Error("Unable to extract the SHA-256 fingerprint from the Android signing key.");
  }
  return match[1].toUpperCase();
}
