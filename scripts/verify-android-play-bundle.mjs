// Upload-gate for a Play bundle: fails on what Play Console or Play review rejects, read from the
// built .aab, so a passing source tree cannot hide a bad artifact.
// Usage: node scripts/verify-android-play-bundle.mjs [app-release.aab] [--bundletool <jar>]
// Needs the standalone bundletool-all jar (github.com/google/bundletool/releases): pass --bundletool
// or set GROGONI_BUNDLETOOL. JAVA_HOME selects the JDK.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { policy, allowedPermissions, lastPlayVersionCode } = JSON.parse(
  readFileSync(join(root, "config/android-play-policy.json"), "utf8")
);

/** Pure so the rules are testable without a built bundle. */
export function findPlayBundleProblems(manifestXml, jarSignerOutput, lastVersionCode) {
  const problems = [];
  const startTag = (element) => new RegExp(`<${element}[\\s>][^>]*`).exec(manifestXml)?.[0] ?? "";
  const attribute = (element, name) =>
    new RegExp(`android:${name}="([^"]*)"`).exec(startTag(element))?.[1] ?? null;
  const target = Number(attribute("uses-sdk", "targetSdkVersion"));
  if (!(target >= policy.minTargetSdk)) {
    problems.push(`targetSdkVersion ${target} is below the Play floor ${policy.minTargetSdk}`);
  }
  if (!attribute("application", "icon")) problems.push("application has no android:icon");
  if (attribute("application", "debuggable") === "true") problems.push("bundle is debuggable");
  if (attribute("application", "testOnly") === "true") problems.push("bundle is test-only");
  const launcher = [
    ...manifestXml.matchAll(/<activity(?:\s[^>]*[^/])?>[\s\S]*?<\/activity>/g)
  ].some(
    ([activity]) =>
      activity.includes("android.intent.category.LAUNCHER") &&
      !/^<activity[^>]*android:enabled="false"/.test(activity)
  );
  if (!launcher) problems.push("no launcher activity");
  const versionCode = Number(attribute("manifest", "versionCode"));
  if (!(versionCode > lastVersionCode)) {
    problems.push(`versionCode ${versionCode} must exceed last Play upload ${lastVersionCode}`);
  }
  const declared = [...manifestXml.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map(
    (match) => match[1]
  );
  for (const permission of declared) {
    if (!allowedPermissions.includes(permission)) {
      problems.push(`permission not on the reviewed list: ${permission}`);
    }
  }
  if (!jarSignerOutput.includes("jar verified") || /unsigned entries/.test(jarSignerOutput)) {
    problems.push("bundle signature does not verify");
  }
  if (/CN=Android Debug/.test(jarSignerOutput)) problems.push("bundle is signed with a debug key");
  return problems;
}

/** Text of the packaged web JavaScript. */
export function findPackagedWebProblems(javascript) {
  return javascript.includes("jsxDEV") ? ["packaged web app is a development build"] : [];
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { bundletool: { type: "string" } }
  });
  const bundletool = values.bundletool ?? process.env.GROGONI_BUNDLETOOL;
  const bundle =
    positionals[0] ?? join(root, "apps/android/app/build/outputs/bundle/release/app-release.aab");
  if (!bundletool) {
    throw new Error("Pass --bundletool <bundletool-all.jar> or set GROGONI_BUNDLETOOL.");
  }
  const bin = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin") : "";
  const run = (tool, ...args) =>
    execFileSync(join(bin, tool), args, {
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "pipe"]
    });
  const manifest = run("java", "-jar", bundletool, "dump", "manifest", `--bundle=${bundle}`);
  const signature = run("jarsigner", "-verify", "-verbose:summary", "-certs", bundle);
  const javascript = execFileSync("unzip", ["-p", bundle, "base/assets/web/assets/*.js"], {
    encoding: "utf8",
    maxBuffer: 1 << 28
  });
  if (javascript.length === 0) throw new Error("The bundle has no packaged web JavaScript.");
  const problems = [
    ...findPlayBundleProblems(manifest, signature, lastPlayVersionCode),
    ...findPackagedWebProblems(javascript)
  ];
  for (const problem of problems) console.error(`FAIL ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`Play bundle checks passed: ${bundle}`);
}
