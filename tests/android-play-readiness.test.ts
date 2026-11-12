import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without declarations
import {
  findPackagedWebProblems,
  findPlayBundleProblems
} from "../scripts/verify-android-play-bundle.mjs";

const read = (path: string) => readFileSync(path, "utf8");
const manifest = read("apps/android/app/src/main/AndroidManifest.xml");
const gradle = read("apps/android/app/build.gradle.kts");
const policy = JSON.parse(read("config/android-play-policy.json")) as {
  policy: { minTargetSdk: number };
  allowedPermissions: string[];
};

/** Same shape as `bundletool dump manifest`: multi-line tags, attributes on activities too. */
const goodManifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    android:compileSdkVersion="36" android:versionCode="4" android:versionName="0.1.0" package="market.grogoni.app">
  <uses-sdk android:minSdkVersion="23" android:targetSdkVersion="36"/>
  <uses-permission android:name="android.permission.READ_SMS"/>
  <application android:allowBackup="false"
      android:icon="@mipmap/ic_launcher" android:label="Grogoni">
    <activity android:exported="false" android:name="market.grogoni.app.auth.AccountActivity"/>
    <activity android:exported="true" android:name="market.grogoni.app.MainActivity">
      <intent-filter><category android:name="android.intent.category.LAUNCHER"/></intent-filter>
    </activity>
  </application>
</manifest>`;
const goodSignature = "jar verified.\n  CN=Grogoni";

describe("Android source meets Google Play's upload rules", () => {
  it("targets the Play floor", () => {
    const target = Number(/targetSdk = (\d+)/.exec(gradle)?.[1]);
    expect(target).toBeGreaterThanOrEqual(policy.policy.minTargetSdk);
    expect(Number(/compileSdk = (\d+)/.exec(gradle)?.[1])).toBeGreaterThanOrEqual(target);
  });

  it("declares a launcher icon that exists at every density", () => {
    expect(manifest).toContain('android:icon="@mipmap/ic_launcher"');
    for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
      for (const name of ["ic_launcher", "ic_launcher_round", "ic_launcher_foreground"]) {
        expect(existsSync(`apps/android/app/src/main/res/mipmap-${density}/${name}.png`)).toBe(
          true
        );
      }
    }
    expect(existsSync("apps/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml")).toBe(
      true
    );
  });

  it("declares only reviewed permissions", () => {
    const declared = [...manifest.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map(
      (match) => match[1] ?? ""
    );
    expect(declared.filter((name) => !policy.allowedPermissions.includes(name))).toEqual([]);
  });
});

describe("findPlayBundleProblems", () => {
  const check = (xml = goodManifest, signature = goodSignature, published = 3) =>
    findPlayBundleProblems(xml, signature, published) as string[];

  it("passes a good bundle", () => expect(check()).toEqual([]));

  it.each([
    [
      "old target",
      goodManifest.replace('targetSdkVersion="36"', 'targetSdkVersion="35"'),
      "below the Play floor"
    ],
    ["no icon", goodManifest.replace(' android:icon="@mipmap/ic_launcher"', ""), "no android:icon"],
    [
      "debuggable",
      goodManifest.replace("<application", '<application android:debuggable="true"'),
      "debuggable"
    ],
    ["unused permission", goodManifest.replace("READ_SMS", "RECORD_AUDIO"), "RECORD_AUDIO"],
    ["reused version", goodManifest.replace('versionCode="4"', 'versionCode="3"'), "must exceed"],
    [
      "icon only on an activity",
      goodManifest
        .replace(' android:icon="@mipmap/ic_launcher"', "")
        .replace("<activity", '<activity android:icon="@drawable/x"'),
      "no android:icon"
    ],
    [
      "target outside uses-sdk",
      goodManifest
        .replace(' android:targetSdkVersion="36"', "")
        .replace("<activity", '<activity android:targetSdkVersion="36"'),
      "below the Play floor"
    ],
    [
      "test-only",
      goodManifest.replace("<application", '<application android:testOnly="true"'),
      "test-only"
    ],
    ["no launcher", goodManifest.replace("android.intent.category.LAUNCHER", "x"), "no launcher"],
    [
      "launcher only in queries",
      goodManifest
        .replace("android.intent.category.LAUNCHER", "x")
        .replace(
          "<application",
          '<queries><intent><category android:name="android.intent.category.LAUNCHER"/></intent></queries><application'
        ),
      "no launcher"
    ],
    [
      "disabled launcher",
      goodManifest.replace(
        '<activity android:exported="true"',
        '<activity android:enabled="false" android:exported="true"'
      ),
      "no launcher"
    ]
  ])("rejects %s", (_name, xml, expected) => {
    expect(check(xml).join()).toContain(expected);
  });

  it("rejects bad signatures", () => {
    expect(check(goodManifest, "jar is unsigned.").join()).toContain("does not verify");
    expect(
      check(goodManifest, "jar verified.\nThis jar contains unsigned entries").join()
    ).toContain("does not verify");
    expect(check(goodManifest, "jar verified.\n CN=Android Debug").join()).toContain("debug key");
  });
});

describe("packaged web app", () => {
  it("rejects a development build", () => {
    expect(findPackagedWebProblems("const a = jsxDEV(App)")).toHaveLength(1);
    expect(findPackagedWebProblems("const a = jsx(App)")).toEqual([]);
  });

  it("forces production when bundling, whatever .env.local says", () => {
    expect(read("scripts/bundle-android-web.mjs")).toContain('NODE_ENV: "production"');
  });
});

describe("screen capture", () => {
  it("can only be allowed in debug builds", () => {
    const debug = gradle.slice(gradle.indexOf("debug {"), gradle.indexOf("release {"));
    expect(debug).toContain("GROGONI_ALLOW_CAPTURE");
    expect(gradle.split("GROGONI_ALLOW_CAPTURE")).toHaveLength(2);
    expect(gradle).toContain('buildConfigField("boolean", "ALLOW_SCREEN_CAPTURE", "false")');
  });
});

describe("installed app offers no APK", () => {
  it("guards every route to the download", () => {
    expect(read("apps/web/src/AppRouter.tsx")).toContain("routes.install && !isNativeDeviceHost()");
    const page = read("apps/web/src/DeviceMessagingPage.tsx");
    expect(page.indexOf("isNativeDeviceHost() ?")).toBeLessThan(page.indexOf('href="/install"'));
  });
});
