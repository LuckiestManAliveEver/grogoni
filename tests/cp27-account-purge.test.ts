import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignedDeletionWebhookProcessor } from "../services/api/src/cp2/account-deletion-processors";
import {
  createCp2Store,
  type AccountDeletionProcessor,
  type AccountDeletionProcessorInput
} from "../services/api/src/cp2/store";

const requestedAt = new Date("2026-01-01T00:00:00.000Z");
const purgeAt = new Date("2026-02-01T00:00:01.000Z");

describe("CP27 complete account purge", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("propagates deletion before removing all account-linked local records", async () => {
    const calls: AccountDeletionProcessorInput[] = [];
    const processor: AccountDeletionProcessor = {
      id: "identity-gateway",
      async deleteAccount(input) {
        calls.push(input);
        return { externalReference: "processor-proof-001" };
      }
    };
    const store = createCp2Store({ accountDeletionProcessors: [processor] });
    const seeded = seedAccount(store);
    const deletion = store.requestAccountDeletion({
      sessionId: seeded.sessionId,
      businessId: seeded.businessId,
      deletion: { confirmation: "DELETE", reason: "Purge proof" },
      now: requestedAt
    });

    const result = await store.purgeExpiredAccountDeletions(purgeAt);
    const snapshot = store.snapshot();
    const serialized = JSON.stringify(snapshot);

    expect(result).toEqual({ checked: 1, completed: 1, partiallyFailed: 0, skipped: 0 });
    expect(calls).toEqual([
      {
        requestId: deletion.id,
        subjects: [
          { provider: "primary_email", subject: "owner@example.test" },
          { provider: "google", subject: "google-owner-123" }
        ]
      }
    ]);
    expect(snapshot.accountDeletionRequests).toEqual([]);
    expect(snapshot.accountDeletionProofs).toEqual([
      expect.objectContaining({
        requestId: deletion.id,
        status: "COMPLETED",
        completedAt: purgeAt.toISOString(),
        deletedRecordCount: expect.any(Number),
        processorReceipts: [
          expect.objectContaining({
            processorId: "identity-gateway",
            status: "completed",
            attempts: 1,
            externalReference: "processor-proof-001"
          })
        ]
      })
    ]);
    expect(snapshot.accountDeletionProofs?.[0]?.deletedRecordCount).toBeGreaterThan(10);
    for (const sensitiveValue of [
      seeded.accountId,
      seeded.userId,
      seeded.businessId,
      "owner@example.test",
      "google-owner-123",
      "Sensitive product name"
    ]) {
      expect(serialized).not.toContain(sensitiveValue);
    }
  });

  it("retains local data after processor failure and completes on an idempotent retry", async () => {
    let shouldFail = true;
    const processor: AccountDeletionProcessor = {
      id: "identity-gateway",
      async deleteAccount() {
        if (shouldFail) throw new Error("temporary processor outage");
        return { externalReference: "processor-proof-retry" };
      }
    };
    const store = createCp2Store({ accountDeletionProcessors: [processor] });
    const seeded = seedAccount(store);
    const deletion = store.requestAccountDeletion({
      sessionId: seeded.sessionId,
      businessId: seeded.businessId,
      deletion: { confirmation: "DELETE" },
      now: requestedAt
    });

    const failed = await store.purgeExpiredAccountDeletions(purgeAt);
    expect(failed).toEqual({ checked: 1, completed: 0, partiallyFailed: 1, skipped: 0 });
    expect(store.snapshot().accounts).toContainEqual(
      expect.objectContaining({ id: seeded.accountId })
    );
    expect(store.snapshot().accountDeletionRequests).toContainEqual(
      expect.objectContaining({ id: deletion.id, status: "PARTIALLY_FAILED" })
    );
    expect(store.snapshot().accountDeletionProofs?.[0]?.processorReceipts[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      errorCode: "processor_deletion_failed"
    });

    shouldFail = false;
    const completed = await store.purgeExpiredAccountDeletions(
      new Date("2026-02-02T00:00:01.000Z")
    );
    expect(completed).toEqual({ checked: 1, completed: 1, partiallyFailed: 0, skipped: 0 });
    expect(store.snapshot().accounts).not.toContainEqual(
      expect.objectContaining({ id: seeded.accountId })
    );
    expect(store.snapshot().accountDeletionProofs?.[0]?.processorReceipts[0]).toMatchObject({
      status: "completed",
      attempts: 2,
      externalReference: "processor-proof-retry"
    });
  });

  it("signs processor webhooks and requires an external completion reference", async () => {
    const secret = "a-secure-test-secret-that-is-longer-than-thirty-two-characters";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      const headers = new Headers(init?.headers);
      const timestamp = headers.get("x-grogoni-deletion-timestamp") ?? "";
      expect(headers.get("idempotency-key")).toBe("request-123");
      expect(headers.get("x-grogoni-deletion-signature")).toBe(
        `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`
      );
      return new Response(JSON.stringify({ externalReference: "identity-delete-456" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const processor = createSignedDeletionWebhookProcessor(
      { id: "identity-provider", url: "https://processor.example.test/delete" },
      secret
    );

    await expect(
      processor.deleteAccount({
        requestId: "request-123",
        subjects: [{ provider: "primary_phone", subject: "+254700000001" }]
      })
    ).resolves.toEqual({ externalReference: "identity-delete-456" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function seedAccount(store: ReturnType<typeof createCp2Store>) {
  const auth = store.completeOAuthProfileAuthentication({
    provider: "google",
    profile: {
      providerSubject: "google-owner-123",
      email: "owner@example.test",
      emailVerified: true,
      displayName: "Deletion Owner"
    },
    tokens: { accessToken: "secret-access-token", refreshToken: "secret-refresh-token" },
    now: requestedAt
  });
  const created = store.createBusiness({
    sessionId: auth.session.id,
    name: "Deletion Proof Shop",
    language: "en",
    phoneNumber: "+254712345678",
    phoneCountry: "KE",
    now: requestedAt
  });
  store.createProduct({
    sessionId: auth.session.id,
    businessId: created.business.id,
    product: {
      name: "Sensitive product name",
      sku: "DELETE-ME",
      unit: "item",
      quantity: 2,
      buyingPrice: 1,
      sellingPrice: 2
    },
    now: requestedAt
  });
  return {
    accountId: auth.account.id,
    userId: auth.user.id,
    sessionId: auth.session.id,
    businessId: created.business.id
  };
}
