import { describe, expect, it } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";
import type { ModelRuntimeAdapter } from "../services/api/src/inference/model-runtime";

const modelId = "qwen2.5-0.5b-android";
const now = new Date("2026-01-01T00:00:00.000Z");
const purgeAt = new Date("2026-02-02T00:00:01.000Z");

// Regression coverage for the account-deletion gap this consolidation closed: before it,
// deleteAccountOwnedData swept every legacy agent-runtime map but never touched the native runtime
// graph (NativeRuntimeBindingStore's agents/hosts/installations/bindings/binding-models) or
// cp2_platform_operators, so deleting an account with a custom activated model left orphaned
// business/account-scoped rows behind forever. See services/api/src/cp2/store.ts
// deleteAccountOwnedData's own comment for exactly which maps are swept and why modelsMap (the
// global, operator-editable catalog - never account-owned) is deliberately excluded.
describe("account deletion sweeps native runtime state", () => {
  it("removes every business/account-scoped native runtime row and platform-operator grant, but leaves the global default binding untouched", async () => {
    const adapter = healthyAdapter(modelId);
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId: requested, executionTarget }) =>
        requested === modelId && executionTarget === "backend" ? adapter : undefined
    });

    const auth = store.completeOAuthProfileAuthentication({
      provider: "google",
      profile: {
        providerSubject: "google-runtime-sweep-1",
        email: "runtime-sweep@example.test",
        emailVerified: true,
        displayName: "Runtime Sweep Owner"
      },
      tokens: { accessToken: "secret-access-token", refreshToken: "secret-refresh-token" },
      now
    });
    const business = store.createBusiness({
      sessionId: auth.session.id,
      name: "Deletable Runtime Shop",
      language: "en",
      phoneNumber: "+254712399001",
      phoneCountry: "KE",
      now
    });
    const businessId = business.business.id;
    const accountId = auth.account.id;

    await store.activateAgentModel({
      sessionId: auth.session.id,
      businessId,
      agentId: businessId,
      modelId,
      executionTarget: "backend",
      executionMode: "LOCAL_FIRST",
      costResponsibility: "merchant",
      permissions: { allowRemoteShopDevice: false },
      now
    });
    store.grantPlatformOperator({ accountId, grantedBy: "system-test" });

    const before = store.snapshot();
    const globalDefaultBindingId = "builtin:grogoni-default-runtime:v1";
    const scopedBindings = before.nativeRuntimeBindings.filter(
      (binding) => binding.businessId === businessId
    );
    const scopedAgents = before.nativeRuntimeAgents.filter(
      (agent) => agent.businessId === businessId
    );
    const scopedHosts = before.nativeExecutionHosts.filter(
      (host) => host.businessId === businessId
    );
    const scopedInstallations = before.nativeModelInstallations.filter((installation) =>
      scopedHosts.some((host) => host.id === installation.executionHostId)
    );
    const scopedRoles = before.nativeRuntimeBindingModels.filter((role) =>
      scopedBindings.some((binding) => binding.id === role.runtimeBindingId)
    );
    expect(scopedBindings.length).toBeGreaterThan(0);
    expect(scopedAgents.length).toBeGreaterThan(0);
    expect(scopedHosts.length).toBeGreaterThan(0);
    expect(scopedInstallations.length).toBeGreaterThan(0);
    expect(scopedRoles.length).toBeGreaterThan(0);
    expect(before.platformOperators).toContainEqual(expect.objectContaining({ accountId }));
    expect(
      before.nativeRuntimeBindings.find((binding) => binding.id === globalDefaultBindingId)
    ).toBeDefined();

    store.requestAccountDeletion({
      sessionId: auth.session.id,
      businessId,
      deletion: { confirmation: "DELETE", reason: "Runtime sweep proof" },
      now
    });
    const result = await store.purgeExpiredAccountDeletions(purgeAt);
    expect(result).toEqual({ checked: 1, completed: 1, partiallyFailed: 0, skipped: 0 });

    const after = store.snapshot();
    expect(
      after.nativeRuntimeBindings.filter((binding) => binding.businessId === businessId)
    ).toHaveLength(0);
    expect(
      after.nativeRuntimeAgents.filter((agent) => agent.businessId === businessId)
    ).toHaveLength(0);
    expect(
      after.nativeExecutionHosts.filter((host) => host.businessId === businessId)
    ).toHaveLength(0);
    for (const role of scopedRoles) {
      expect(
        after.nativeRuntimeBindingModels.find((candidate) => candidate.id === role.id)
      ).toBeUndefined();
    }
    for (const installation of scopedInstallations) {
      expect(
        after.nativeModelInstallations.find((candidate) => candidate.id === installation.id)
      ).toBeUndefined();
    }
    expect(after.platformOperators.find((grant) => grant.accountId === accountId)).toBeUndefined();

    // The global default runtime slot is not account-owned data - it must survive every account's
    // deletion untouched.
    expect(
      after.nativeRuntimeBindings.find((binding) => binding.id === globalDefaultBindingId)
    ).toBeDefined();
    // The model catalog itself is global, operator-editable data (like cp2_model_catalog), never
    // account-owned - deleting the account that happened to activate a catalog model must not
    // remove that model from the shared catalog.
    expect(after.nativeRuntimeModels.find((model) => model.id === modelId)).toBeDefined();
  });
});

function healthyAdapter(modelIdForAdapter: string): ModelRuntimeAdapter {
  return {
    provider: "test",
    executionTarget: "backend",
    async canRun() {
      return { available: true, errorCode: null, message: null };
    },
    async healthCheck() {
      return {
        available: true,
        modelId: modelIdForAdapter,
        provider: "test",
        executionTarget: "backend",
        latencyMs: 1,
        responsePreview: "GROGONI_MODEL_OK",
        errorCode: null,
        message: null,
        retryable: false
      };
    },
    async generate() {
      return {
        text: JSON.stringify({ type: "response", message: "ok" }),
        modelId: modelIdForAdapter,
        provider: "test",
        executionTarget: "backend",
        latencyMs: 1
      };
    }
  };
}
