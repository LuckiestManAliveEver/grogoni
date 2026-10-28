import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { dirname, join } from "node:path";

// Verifies apps/web/public/android/release.json before it ships. The browser install CTA is gated
// on this file at runtime (apps/web/src/android-release.ts), but a bad *edit* of the file - a
// placeholder URL, an untrusted host, a malformed fingerprint - should fail CI rather than silently
// offering an unverified download. Kept in the same style as verify-android-release-identity.mjs.

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const requireRelease = process.argv.includes("--require-release");
const manifestPath = join(workspaceRoot, "apps/web/public/android/release.json");
const releaseIdentity = JSON.parse(
  readFileSync(join(workspaceRoot, "config/android-release-identity.json"), "utf8")
);

const errors = [];

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.error(`Android release manifest is not valid JSON at ${manifestPath}: ${error.message}`);
  process.exit(1);
}

const expectedPackage = "market.grogoni.app";
const sha256Pattern = /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/;
const productionOrigin = "https://grogoni.com";

check(
  releaseIdentity.android?.applicationId === expectedPackage,
  `release identity applicationId must be ${expectedPackage}`
);
check(
  Object.prototype.hasOwnProperty.call(manifest, "release"),
  "manifest must have a 'release' key"
);

if (manifest.release === null) {
  // No release published. This is the safe default; the install CTA stays hidden. Only an explicit
  // --require-release (used before a store submission) treats "no release" as a failure.
  if (requireRelease) {
    errors.push("manifest.release is null but --require-release was requested");
  } else {
    console.log("Android release manifest is valid (no release published; install CTA hidden).");
  }
} else if (typeof manifest.release !== "object") {
  errors.push("manifest.release must be null or an object");
} else {
  const release = manifest.release;
  check(release.packageName === expectedPackage, `release.packageName must be ${expectedPackage}`);
  check(
    typeof release.versionName === "string" && release.versionName.trim().length > 0,
    "release.versionName must be a non-empty string"
  );
  check(
    Number.isInteger(release.versionCode) && release.versionCode > 0,
    "release.versionCode must be a positive integer"
  );
  check(
    typeof release.sha256 === "string" && sha256Pattern.test(release.sha256),
    "release.sha256 must be a colon-separated uppercase SHA-256 fingerprint"
  );

  const downloadUrl = release.downloadUrl;
  if (typeof downloadUrl !== "string" || !isTrustedHttpsUrl(downloadUrl)) {
    errors.push("release.downloadUrl must be an HTTPS URL on the production Grogoni origin");
  }

  if (release.minSdk !== undefined) {
    check(
      Number.isInteger(release.minSdk) && release.minSdk >= 23,
      "release.minSdk must be an integer >= 23"
    );
  }
}

if (errors.length > 0) {
  console.error("Android release manifest verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

if (manifest.release !== null && errors.length === 0) {
  console.log(
    `Android release manifest is valid (published ${manifest.release.versionName}, code ${manifest.release.versionCode}).`
  );
}

function check(condition, message) {
  if (!condition) errors.push(message);
}

function isTrustedHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === productionOrigin;
  } catch {
    return false;
  }
}
