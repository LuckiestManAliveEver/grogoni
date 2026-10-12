import { describe, expect, it, vi } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";
import type { RuntimeApprovalStore } from "../services/api/src/cp2/domains/agent-runtime/runtime-approval-store";
import { startRuntimeExperienceRetentionRunner } from "../services/api/src/cp2/runtime-experience-retention-runner";

describe("approval privacy and retention wiring", () => {
  it("awaits native deletion, preserves failed-deletion retries, and does not claim anonymization success", async () => {
    const deleteScope = vi
      .fn<RuntimeApprovalStore["deleteScope"]>()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(1);
    const approvals: RuntimeApprovalStore = {
      deleteScope,
      purgeExpired: async () => 0,
      put: async () => {},
      claim: async () => {
        throw new Error("not used");
      }
    };
    const processor = vi.fn(async () => ({ externalReference: "external-deletion" }));
    const store = createCp2Store({
      runtimeApprovalStore: approvals,
      accountDeletionProcessors: [{ id: "external-fixture", deleteAccount: processor }]
    });
    const now = new Date("2026-01-01T00:00:00Z");
    const auth = store.completeOAuthProfileAuthentication({
      provider: "google",
      profile: {
        providerSubject: "approval-delete",
        email: "approval-delete@example.test",
        emailVerified: true,
        displayName: "Owner"
      },
      tokens: { accessToken: "fixture" },
      now
    });
    const business = store.createBusiness({
      sessionId: auth.session.id,
      name: "Approval shop",
      language: "en",
      phoneNumber: "+254712399019",
      phoneCountry: "KE",
      now
    }).business;
    store.requestAccountDeletion({
      sessionId: auth.session.id,
      businessId: business.id,
      deletion: { confirmation: "DELETE", reason: "Privacy test" },
      now
    });
    const purgeAt = new Date("2026-02-02T00:00:00Z");
    expect(await store.purgeExpiredAccountDeletions(purgeAt)).toMatchObject({
      completed: 0,
      partiallyFailed: 1
    });
    expect(store.snapshot().businesses.some((row) => row.id === business.id)).toBe(true);
    expect(deleteScope).toHaveBeenCalledWith([auth.user.id], [business.id]);
    expect(await store.purgeExpiredAccountDeletions(purgeAt)).toMatchObject({
      completed: 1,
      partiallyFailed: 0
    });
    expect(store.snapshot().businesses.some((row) => row.id === business.id)).toBe(false);
    expect(processor).toHaveBeenCalledTimes(1);
  });
  it("uses the existing daily maintenance runner for approval expiry", async () => {
    const now = new Date();
    const purge = vi.fn(async () => 2);
    const experiences = vi.fn(() => 3);
    const runner = startRuntimeExperienceRetentionRunner({
      store: { purgeExpiredRuntimeApprovals: purge, purgeExpiredRuntimeExperiences: experiences },
      runOnStart: false,
      now: () => now
    });
    try {
      expect(await runner.runNow()).toBe(3);
      expect(purge).toHaveBeenCalledWith(now);
      expect(experiences).toHaveBeenCalledWith(now);
    } finally {
      await runner.stop();
    }
  });
});
