// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  androidInstallDismissedStorageKey,
  defaultReleaseManifestUrl,
  expectedAndroidPackageId,
  parseAndroidRelease,
  loadAndroidRelease,
  isTrustedHttpsUrl,
  readAndroidInstallDismissed,
  persistAndroidInstallDismissed
} from "../apps/web/src/android-release";

const manifestUrl = defaultReleaseManifestUrl;

const validRelease = {
  packageName: expectedAndroidPackageId,
  versionName: "1.0.0",
  versionCode: 1,
  downloadUrl: "https://grogoni.com/android/grogoni-1.0.0.apk",
  sha256:
    "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
  minSdk: 23
};

describe("parseAndroidRelease", () => {
  it("reports not-published when the release block is null", () => {
    const status = parseAndroidRelease({ release: null }, manifestUrl);
    expect(status.available).toBe(false);
    expect(status).toMatchObject({ reason: "not-published" });
  });

  it("reports not-published for a missing release block or non-object manifest", () => {
    expect(parseAndroidRelease({}, manifestUrl)).toMatchObject({
      available: false,
      reason: "not-published"
    });
    expect(parseAndroidRelease(null, manifestUrl)).toMatchObject({
      available: false,
      reason: "not-published"
    });
  });

  it("accepts a fully valid release and returns typed metadata", () => {
    const status = parseAndroidRelease({ release: validRelease }, manifestUrl);
    expect(status.available).toBe(true);
    if (!status.available) throw new Error("expected available");
    expect(status.release).toMatchObject({
      packageName: expectedAndroidPackageId,
      versionName: "1.0.0",
      versionCode: 1,
      downloadUrl: validRelease.downloadUrl,
      sha256: validRelease.sha256,
      minSdk: 23
    });
  });

  it("rejects a non-HTTPS or empty download URL", () => {
    const empty = parseAndroidRelease(
      { release: { ...validRelease, downloadUrl: "" } },
      manifestUrl
    );
    expect(empty).toMatchObject({ available: false, reason: "invalid-url" });
    const http = parseAndroidRelease(
      { release: { ...validRelease, downloadUrl: "http://grogoni.com/a.apk" } },
      manifestUrl
    );
    expect(http).toMatchObject({ available: false, reason: "untrusted-host" });
  });

  it("rejects a download from an untrusted third-party host", () => {
    const status = parseAndroidRelease(
      { release: { ...validRelease, downloadUrl: "https://evil.example.com/a.apk" } },
      manifestUrl
    );
    expect(status).toMatchObject({ available: false, reason: "untrusted-host" });
  });

  it("rejects a release for a different package id", () => {
    const status = parseAndroidRelease(
      { release: { ...validRelease, packageName: "com.example.app" } },
      manifestUrl
    );
    expect(status).toMatchObject({ available: false, reason: "invalid-package" });
  });

  it("rejects a non-positive or non-integer versionCode", () => {
    for (const versionCode of [0, -1, 1.5, "1"]) {
      expect(
        parseAndroidRelease({ release: { ...validRelease, versionCode } }, manifestUrl)
      ).toMatchObject({ available: false, reason: "invalid-version" });
    }
  });

  it("rejects a malformed SHA-256 fingerprint", () => {
    for (const sha256 of ["", "deadbeef", "ab:cd", validRelease.sha256.toLowerCase()]) {
      expect(
        parseAndroidRelease({ release: { ...validRelease, sha256 } }, manifestUrl)
      ).toMatchObject({ available: false, reason: "invalid-sha256" });
    }
  });
});

describe("loadAndroidRelease", () => {
  it("returns not-published on a network failure", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const status = await loadAndroidRelease(fetcher, manifestUrl);
    expect(status).toMatchObject({ available: false, reason: "not-published" });
  });

  it("returns not-published on a non-ok response", async () => {
    const fetcher = vi.fn(
      async () => new Response("missing", { status: 404 })
    ) as unknown as typeof fetch;
    const status = await loadAndroidRelease(fetcher, manifestUrl);
    expect(status).toMatchObject({ available: false, reason: "not-published" });
  });

  it("returns not-published when the body is not JSON", async () => {
    const fetcher = vi.fn(
      async () => new Response("<html>oops", { status: 200 })
    ) as unknown as typeof fetch;
    const status = await loadAndroidRelease(fetcher, manifestUrl);
    expect(status).toMatchObject({ available: false, reason: "not-published" });
  });

  it("returns the validated release when the manifest is well-formed", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ release: validRelease }), { status: 200 })
    ) as unknown as typeof fetch;
    const status = await loadAndroidRelease(fetcher, manifestUrl);
    expect(status.available).toBe(true);
  });
});

describe("isTrustedHttpsUrl", () => {
  it("trusts the production origin and rejects everything else", () => {
    expect(isTrustedHttpsUrl("https://grogoni.com/android/a.apk")).toBe(true);
    expect(isTrustedHttpsUrl("https://evil.example.com/a.apk")).toBe(false);
    expect(isTrustedHttpsUrl("http://grogoni.com/a.apk")).toBe(false);
    expect(isTrustedHttpsUrl("not a url")).toBe(false);
    expect(isTrustedHttpsUrl("")).toBe(false);
  });
});

describe("android install dismissal persistence", () => {
  it("persists and reads the 'Not Now' dismissal", () => {
    window.localStorage.clear();
    expect(readAndroidInstallDismissed()).toBe(false);
    persistAndroidInstallDismissed();
    expect(window.localStorage.getItem(androidInstallDismissedStorageKey)).toBe("true");
    expect(readAndroidInstallDismissed()).toBe(true);
  });
});

describe("verify-android-release-manifest.mjs pre-release gate", () => {
  it("passes in the default (no release published) state", () => {
    const out = execFileSync("node", ["scripts/verify-android-release-manifest.mjs"], {
      encoding: "utf8"
    });
    expect(out).toContain("no release published");
  });

  it("fails the strict --require-release gate when no release is published", () => {
    expect(() =>
      execFileSync("node", ["scripts/verify-android-release-manifest.mjs", "--require-release"], {
        encoding: "utf8",
        stdio: "pipe"
      })
    ).toThrow();
  });
});

describe("published release manifest (apps/web/public/android/release.json)", () => {
  it("ships with no published release, so the install CTA stays hidden by default", () => {
    const manifest = JSON.parse(readFileSync("apps/web/public/android/release.json", "utf8"));
    expect(manifest.release).toBeNull();
    const status = parseAndroidRelease(manifest, defaultReleaseManifestUrl);
    expect(status.available).toBe(false);
  });

  it("has a schema file next to it documenting the contract", () => {
    const schema = JSON.parse(readFileSync("apps/web/public/android/release.schema.json", "utf8"));
    expect(schema.properties.release).toBeDefined();
  });
});

describe("website install page wiring", () => {
  it("renders the gated native install card only through the validated release module", () => {
    const page = readFileSync("apps/web/src/InstallPage.tsx", "utf8");
    // Must gate on the release module, never fabricate a download link.
    expect(page).toContain("loadAndroidRelease");
    expect(page).toContain("showNativeCard");
    expect(page).toContain("Not now");
    expect(page).toContain("dismissNativeInstall");
    // The old placeholder "Download Android APK" always linked to "/" - that must be gone.
    expect(page).toContain("href={androidNative.release.downloadUrl}");
    expect(page).not.toContain('href="/" aria-label="Open the HTTPS download page"');
  });

  it("only loads the release when the device is Android", () => {
    const page = readFileSync("apps/web/src/InstallPage.tsx", "utf8");
    expect(page).toMatch(/if \(!\/Android\/i\.test\(navigator\.userAgent\)\) \{\s*return;\s*\}/u);
  });
});
