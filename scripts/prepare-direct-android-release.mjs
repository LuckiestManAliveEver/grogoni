import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

// Prepares a reviewable website bundle. Publishing remains a separate deployment operation.
const root = fileURLToPath(new URL("../", import.meta.url));
function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}
const apk = argument("--apk");
const output = argument("--out");
const tools = argument("--build-tools");
if (!apk || !output || !tools)
  throw new Error(
    "Usage: node scripts/prepare-direct-android-release.mjs --apk signed.apk --out directory --build-tools android-sdk/build-tools/36.0.0"
  );
const artifact = resolve(apk);
const badging = execFileSync(join(tools, "aapt"), ["dump", "badging", artifact], {
  encoding: "utf8"
});
if (/application-debuggable/.test(badging)) throw new Error("Refusing a debuggable APK.");
const identity = badging.match(/package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/);
if (!identity || identity[1] !== "market.grogoni.app")
  throw new Error("Unexpected Android package identity.");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identity[3])) throw new Error("Unsafe version name.");
const signature = execFileSync(
  join(tools, "apksigner"),
  ["verify", "--verbose", "--print-certs", artifact],
  { encoding: "utf8" }
);
const sharedWeb = JSON.parse(
  execFileSync(
    "python3",
    [
      "-c",
      `
import hashlib,json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    raw=archive.read('assets/web-bundle.json')
    manifest=json.loads(raw)
    if manifest.get('source')!='apps/web': raise SystemExit('APK does not use the shared web source')
    for name,digest in manifest['files'].items():
        if hashlib.sha256(archive.read('assets/web/'+name)).hexdigest()!=digest:
            raise SystemExit('Shared asset mismatch: '+name)
    print(json.dumps({'sha256':hashlib.sha256(raw).hexdigest(),'files':len(manifest['files'])}))
`,
      artifact
    ],
    { encoding: "utf8" }
  )
);
if (/certificate DN:.*CN=Android Debug/i.test(signature))
  throw new Error("Refusing Android's debug signing identity.");
const digest = signature.match(/Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})/i)?.[1];
if (!digest) throw new Error("A verified release signer certificate is required.");
const versionCode = Number(identity[2]);
if (!Number.isSafeInteger(versionCode) || versionCode < 1) throw new Error("Invalid versionCode.");
const minSdk = Number(badging.match(/sdkVersion:'(\d+)'/)?.[1]);
if (minSdk < 23 || !Number.isSafeInteger(minSdk))
  throw new Error("Unsupported minimum Android SDK.");
const fingerprint = (hex) => hex.toUpperCase().match(/../g).join(":");
const bytes = readFileSync(artifact);
const filename = `grogoni-${identity[3]}-${versionCode}.apk`;
const directory = resolve(output);
mkdirSync(join(directory, "android"), { recursive: true });
mkdirSync(join(directory, ".well-known"), { recursive: true });
copyFileSync(artifact, join(directory, "android", filename));
const manifest = {
  $schema: "./release.schema.json",
  note: "Direct website distribution. Metadata comes from a verified, non-debuggable signed APK.",
  release: {
    packageName: identity[1],
    versionName: identity[3],
    versionCode,
    downloadUrl: `https://grogoni.com/android/${filename}`,
    sha256: fingerprint(createHash("sha256").update(bytes).digest("hex")),
    minSdk
  }
};
writeFileSync(join(directory, "android", "release.json"), JSON.stringify(manifest, null, 2) + "\n");
copyFileSync(
  join(root, "apps/web/public/android/release.schema.json"),
  join(directory, "android/release.schema.json")
);
writeFileSync(
  join(directory, ".well-known/assetlinks.json"),
  JSON.stringify(
    [
      {
        relation: [
          "delegate_permission/common.handle_all_urls",
          "delegate_permission/common.get_login_creds"
        ],
        target: {
          namespace: "android_app",
          package_name: identity[1],
          sha256_cert_fingerprints: [fingerprint(digest)]
        }
      }
    ],
    null,
    2
  ) + "\n"
);
writeFileSync(
  join(directory, "verification.json"),
  JSON.stringify(
    {
      distribution: "direct-web",
      packageName: identity[1],
      artifact: basename(filename),
      certificateSha256: fingerprint(digest),
      apkSha256: manifest.release.sha256,
      signatureVerified: true,
      sharedWebSource: "apps/web",
      sharedWebBundleSha256: sharedWeb.sha256,
      sharedWebAssetCount: sharedWeb.files,
      debuggable: false,
      published: false
    },
    null,
    2
  ) + "\n"
);
console.log(`Verified direct-download bundle prepared at ${directory}`);
