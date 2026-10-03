import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface AndroidReleaseIdentity {
  checkpoint: string;
  identityStatus: "proposed" | "approved";
  brand: {
    appName: string;
    launcherName: string;
  };
  android: {
    applicationId: string;
    applicationIdStatus: "proposed" | "approved";
    versionName: string;
    versionCode: number;
    minSdk: number;
    targetSdk: number;
    compileSdk: number;
    wrapper: string;
    firstTrack: string;
  };
  web: {
    origin: string;
    startUrl: string;
    scope: string;
    manifestUrl: string;
    digitalAssetLinksUrl: string;
    apiOrigin: string;
  };
  signing: {
    playAppSigning: boolean;
    privateKeysCommitted: boolean;
    rotationAndRecoveryDocumented: boolean;
  };
  developer: {
    accountTypeStatus: "proposed" | "approved";
    playDeveloperName: string | null;
    legalEntityName: string | null;
    playDeveloperAccountId: string | null;
    identityVerificationStatus: "pending" | "verified";
  };
  ownership: Record<string, string | null>;
  approval: {
    approvedBy: string | null;
    approvedOn: string | null;
    changeRecord: string | null;
  };
}

describe("CP26 Android release identity", () => {
  it("pins a structurally valid proposal to the production PWA and Render origins", async () => {
    const [identity, manifest, rootPackage, renderBlueprint] = await Promise.all([
      readJson<AndroidReleaseIdentity>("../config/android-release-identity.json"),
      readJson<{ name: string; short_name: string }>("../apps/web/public/manifest.webmanifest"),
      readJson<{ version: string }>("../package.json"),
      readFile(new URL("../render.yaml", import.meta.url), "utf8")
    ]);

    expect(identity.checkpoint).toBe("CP26");
    expect(identity.identityStatus).toBe("proposed");
    expect(identity.brand).toMatchObject({
      appName: manifest.name,
      launcherName: manifest.short_name
    });
    expect(identity.android).toMatchObject({
      applicationId: "market.grogoni.app",
      applicationIdStatus: "proposed",
      wrapper: "trusted-web-activity",
      firstTrack: "internal",
      versionName: rootPackage.version,
      versionCode: 1,
      minSdk: 23,
      targetSdk: 35,
      compileSdk: 35
    });
    expect(identity.web).toEqual({
      origin: "https://grogoni.com",
      startUrl: "https://grogoni.com/",
      scope: "https://grogoni.com/",
      manifestUrl: "https://grogoni.com/manifest.webmanifest",
      digitalAssetLinksUrl: "https://grogoni.com/.well-known/assetlinks.json",
      apiOrigin: "https://grogoni.com"
    });
    expect(renderBlueprint).toContain("domains:\n      - grogoni");
    expect(renderBlueprint).toContain("value: https://grogoni.com");
    expect(identity.signing).toMatchObject({
      playAppSigning: true,
      privateKeysCommitted: false
    });
  });

  it("preserves an explicit approval gate until every owner-controlled field is recorded", async () => {
    const [identity, rootPackage] = await Promise.all([
      readJson<AndroidReleaseIdentity>("../config/android-release-identity.json"),
      readJson<{ scripts: Record<string, string> }>("../package.json")
    ]);

    expect(identity.android.applicationIdStatus).toBe("proposed");
    expect(identity.developer.accountTypeStatus).toBe("proposed");
    expect(identity.developer.identityVerificationStatus).toBe("pending");
    expect(
      [
        identity.developer.playDeveloperName,
        identity.developer.legalEntityName,
        identity.developer.playDeveloperAccountId,
        ...Object.values(identity.ownership),
        identity.approval.approvedBy,
        identity.approval.approvedOn,
        identity.approval.changeRecord
      ].every((value) => value === null)
    ).toBe(true);
    expect(identity.signing.rotationAndRecoveryDocumented).toBe(false);
    expect(rootPackage.scripts["android:identity:verify"]).toContain(
      "verify-android-release-identity.mjs"
    );
    expect(rootPackage.scripts["android:identity:gate"]).toContain("--require-approved");
  });
});

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8")) as T;
}
