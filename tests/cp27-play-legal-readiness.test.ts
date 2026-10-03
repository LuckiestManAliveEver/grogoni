import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface PlayLegalReadiness {
  checkpoint: string;
  readinessStatus: "proposed" | "approved";
  product: Record<string, string | null>;
  contacts: {
    supportEmail: string | null;
    privacyEmail: string | null;
    legalEmail: string | null;
    contactVerificationStatus: "pending" | "verified";
  };
  legalDocuments: {
    privacyPolicyUrl: string;
    privacyPolicyStatus: "draft" | "approved";
    privacyPolicyEffectiveOn: string | null;
    termsUrl: string;
    termsStatus: "draft" | "approved";
    termsEffectiveOn: string | null;
    legalApprovalReference: string | null;
  };
  accountDeletion: {
    externalRequestUrl: string;
    inAppPath: string;
    authenticationRequired: boolean;
    androidAppRequired: boolean;
    requestPathImplemented: boolean;
    recoveryPeriodDays: number;
    associatedDataIncluded: boolean;
    lawfulRetentionDisclosed: boolean;
    fulfillmentRunbookStatus: "pending" | "verified";
    serviceProviderDeletionStatus: "pending" | "verified";
    operationsOwner: string | null;
    privacyOwner: string | null;
  };
  approval: Record<string, string | null>;
}

describe("CP27 Google Play legal readiness", () => {
  it("provides a public account-deletion resource and secure authenticated web path", async () => {
    const [
      readiness,
      application,
      deleteAccountPanel,
      router,
      routes,
      deletionPage,
      renderBlueprint
    ] = await Promise.all([
      readJson<PlayLegalReadiness>("../config/play-legal-readiness.json"),
      readFile(new URL("../apps/web/src/GrogoniApplication.tsx", import.meta.url), "utf8"),
      readFile(new URL("../apps/web/src/DeleteAccountPanel.tsx", import.meta.url), "utf8"),
      readFile(new URL("../apps/web/src/AppRouter.tsx", import.meta.url), "utf8"),
      readFile(new URL("../apps/web/src/routes.ts", import.meta.url), "utf8"),
      readFile(new URL("../apps/web/src/legal/AccountDeletionPage.tsx", import.meta.url), "utf8"),
      readFile(new URL("../render.yaml", import.meta.url), "utf8")
    ]);

    expect(readiness.checkpoint).toBe("CP27");
    expect(readiness.accountDeletion).toMatchObject({
      externalRequestUrl: "https://grogoni.com/account-deletion",
      inAppPath: "Account Settings > Delete account",
      authenticationRequired: true,
      androidAppRequired: false,
      requestPathImplemented: true,
      recoveryPeriodDays: 30,
      associatedDataIncluded: true,
      lawfulRetentionDisclosed: true
    });
    expect(routes).toContain('accountDeletion: "/account-deletion"');
    expect(router).toContain("window.location.pathname === routes.accountDeletion");
    expect(application).toContain('get("intent") === "account-deletion"');
    expect(deleteAccountPanel).toContain("Delete account and associated data");
    expect(deletionPage).toContain("Continue to secure deletion request");
    expect(deletionPage).toContain("You do not need to reinstall or open the Android app.");
    expect(renderBlueprint).toContain("source: /*\n        destination: /index.html");
  });

  it("keeps legal publication and operational fulfillment behind explicit approval", async () => {
    const [readiness, rootPackage] = await Promise.all([
      readJson<PlayLegalReadiness>("../config/play-legal-readiness.json"),
      readJson<{ scripts: Record<string, string> }>("../package.json")
    ]);

    expect(readiness.readinessStatus).toBe("proposed");
    expect(readiness.legalDocuments).toMatchObject({
      privacyPolicyUrl: "https://grogoni.com/privacy",
      privacyPolicyStatus: "draft",
      privacyPolicyEffectiveOn: null,
      termsUrl: "https://grogoni.com/terms",
      termsStatus: "draft",
      termsEffectiveOn: null,
      legalApprovalReference: null
    });
    expect(readiness.contacts.contactVerificationStatus).toBe("pending");
    expect(readiness.accountDeletion.fulfillmentRunbookStatus).toBe("pending");
    expect(readiness.accountDeletion.serviceProviderDeletionStatus).toBe("pending");
    expect(rootPackage.scripts["android:legal:verify"]).toContain(
      "verify-play-legal-readiness.mjs"
    );
    expect(rootPackage.scripts["android:legal:gate"]).toContain("--require-approved");
  });
});

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8")) as T;
}
