import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Postgres persistence boundary", () => {
  it("queues verified task experience extraction as a snapshot mutation", () => {
    const source = readFileSync("services/api/src/cp2/postgres-store.ts", "utf8");
    const methods = source.slice(
      source.indexOf("const mutatingMethodNames"),
      source.indexOf("const targetedPasskeyCeremonyMethodNames")
    );
    expect(methods).toContain('"recordVerifiedBusinessTaskExperience"');
    expect(methods).not.toContain('"businessTaskExperienceAdvice"');
  });
  it("persists every route-level mutation and read that materializes durable defaults", () => {
    const source = readFileSync("services/api/src/cp2/postgres-store.ts", "utf8");
    const requiredMethods = [
      "authenticateMcpAccessToken",
      "confirmInvoice",
      "disconnectSocialAccount",
      "getBetaReadiness",
      "getBusinessKnowledge",
      "getDeviceTrust",
      "getDirectNetwork",
      "getExtendedNetwork",
      "getLaunchReadiness",
      "getNetworkGraph",
      "getSecurityReview",
      "getTaxConfig",
      "getVerificationTier",
      "listBetaFeatureFlags",
      "listLaunchChecklist",
      "listNotifications",
      "upsertModelCatalogEntry",
      "removeModelCatalogEntry",
      "upsertAgentCatalogEntry",
      "removeAgentCatalogEntry",
      "syncConnectedSocialProvider",
      "updateInvoice"
    ];

    for (const method of requiredMethods) {
      expect(source).toContain(`"${method}"`);
    }
  });

  it("uses a targeted write for passkey ceremony creation and reports queue timing", () => {
    const source = readFileSync("services/api/src/cp2/postgres-store.ts", "utf8");
    const snapshotMutationMethods = source.slice(
      source.indexOf("const mutatingMethodNames"),
      source.indexOf("const targetedPasskeyCeremonyMethodNames")
    );

    expect(snapshotMutationMethods).not.toContain('"beginPasskeyAuthentication"');
    expect(snapshotMutationMethods).not.toContain('"beginPasskeyRegistration"');
    expect(source).toContain("insert into cp2_passkey_ceremonies");
    expect(source).toContain('enqueuePersistenceOperation("passkey_ceremony"');
    expect(source).toContain("oldestPendingAgeMs");
    expect(source).toContain("lastWaitDurationMs");
    expect(source).toContain("lastRunDurationMs");
  });
});
