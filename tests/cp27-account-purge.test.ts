import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBrevoDeletionProcessor,
  createSignedDeletionWebhookProcessor,
  deletionEmails,
  readAccountDeletionProcessors
} from "../services/api/src/cp2/account-deletion-processors";
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
          { provider: "google", subject: "google-owner-123" },
          // Account identities (backup/linked emails and phones) are deletion subjects too; the
          // one that repeats the primary destination is not listed twice.
          { provider: "identity_phone", subject: "+254712345678" }
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

// Brevo holds a transactional log entry (address, IP, subject) for every OTP and notification it
// delivers. The production purge runs {"id":"brevo","type":"brevo"}, which erases those logs and
// any contact for each email address the account is known by.
describe("CP27 Brevo deletion processor", () => {
  afterEach(() => vi.unstubAllGlobals());

  const webhookSecret = "a-secure-test-secret-that-is-longer-than-thirty-two-characters";
  const brevoOnly = JSON.stringify([{ id: "brevo", type: "brevo" }]);

  type BrevoReply = { status: number; code?: string };
  function stubBrevo(reply: (url: string) => BrevoReply) {
    const calls: { url: string; method: string; apiKey: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({
          url,
          method: init?.method ?? "GET",
          apiKey: new Headers(init?.headers).get("api-key")
        });
        const { status, code } = reply(url);
        return new Response(status === 204 ? null : JSON.stringify({ code, message: "x" }), {
          status
        });
      })
    );
    return calls;
  }

  it("reads a brevo processor with BREVO_API_KEY and no webhook secret", () => {
    const processors = readAccountDeletionProcessors({
      ACCOUNT_DELETION_PROCESSORS_JSON: brevoOnly,
      BREVO_API_KEY: "brevo-key"
    });
    expect(processors.map((processor) => processor.id)).toEqual(["brevo"]);
  });

  it.each([
    [{ ACCOUNT_DELETION_PROCESSORS_JSON: brevoOnly }, /BREVO_API_KEY is required/u],
    [
      { ACCOUNT_DELETION_PROCESSORS_JSON: JSON.stringify([{ id: "brevo", type: "mailgun" }]) },
      /unknown type/u
    ],
    [
      {
        ACCOUNT_DELETION_PROCESSORS_JSON: JSON.stringify([
          { id: "brevo", type: "brevo", url: "https://x.example/delete" }
        ]),
        BREVO_API_KEY: "k"
      },
      /both type and url/u
    ],
    [
      {
        ACCOUNT_DELETION_PROCESSORS_JSON: JSON.stringify([
          { id: "brevo", type: "brevo" },
          { id: "brevo", type: "brevo" }
        ]),
        BREVO_API_KEY: "k"
      },
      /Duplicate deletion processor id/u
    ],
    [
      // A webhook processor still needs the signing secret, even beside a brevo one.
      {
        ACCOUNT_DELETION_PROCESSORS_JSON: JSON.stringify([
          { id: "brevo", type: "brevo" },
          { id: "gateway", url: "https://processor.example.test/delete" }
        ]),
        BREVO_API_KEY: "k"
      },
      /ACCOUNT_DELETION_WEBHOOK_SECRET/u
    ]
  ])("rejects an unusable processor configuration %#", (environment, message) => {
    expect(() => readAccountDeletionProcessors(environment)).toThrow(message);
  });

  it("accepts brevo and webhook processors together when both credentials are present", () => {
    const processors = readAccountDeletionProcessors({
      ACCOUNT_DELETION_PROCESSORS_JSON: JSON.stringify([
        { id: "brevo", type: "brevo" },
        { id: "gateway", url: "https://processor.example.test/delete" }
      ]),
      BREVO_API_KEY: "k",
      ACCOUNT_DELETION_WEBHOOK_SECRET: webhookSecret
    });
    expect(processors.map((processor) => processor.id)).toEqual(["brevo", "gateway"]);
  });

  it("picks each distinct email address out of the subjects, whatever the provider", () => {
    expect(
      deletionEmails([
        { provider: "primary_email", subject: " Owner+Shop@Example.test " },
        { provider: "email", subject: "owner+shop@example.test" },
        { provider: "google", subject: "google-owner-123" },
        { provider: "primary_phone", subject: "+254700000001" },
        { provider: "github", subject: "second@example.test" },
        { provider: "local", subject: "not an @ email" }
      ])
    ).toEqual(["Owner+Shop@Example.test", "owner+shop@example.test", "second@example.test"]);
  });

  it("erases logs and contact per address, treating document_not_found as already gone", async () => {
    const calls = stubBrevo((url) =>
      url.includes("/contacts/") ? { status: 404, code: "document_not_found" } : { status: 204 }
    );
    const processor = createBrevoDeletionProcessor({ id: "brevo", apiKey: "brevo-key" });

    const result = await processor.deleteAccount({
      requestId: "request-1",
      subjects: [
        { provider: "primary_email", subject: "Owner+Shop@Example.test" },
        { provider: "google", subject: "google-owner-123" }
      ]
    });

    // Erased as recorded and lower-cased, in case Brevo matches log identifiers by exact case.
    expect(calls).toEqual(
      ["Owner%2BShop%40Example.test", "owner%2Bshop%40example.test"].flatMap((address) => [
        {
          url: `https://api.brevo.com/v3/smtp/log/${address}`,
          method: "DELETE",
          apiKey: "brevo-key"
        },
        {
          url: `https://api.brevo.com/v3/contacts/${address}`,
          method: "DELETE",
          apiKey: "brevo-key"
        }
      ])
    );
    // The reference lands in the deletion proof, so it carries counts, never the address.
    expect(result).toEqual({ externalReference: "brevo:emails-2:logs-2:contacts-0" });
  });

  it("completes without calling Brevo when the account has no email address", async () => {
    const calls = stubBrevo(() => ({ status: 500 }));
    const processor = createBrevoDeletionProcessor({ id: "brevo", apiKey: "k" });
    await expect(
      processor.deleteAccount({
        requestId: "request-2",
        subjects: [{ provider: "primary_phone", subject: "+254700000001" }]
      })
    ).resolves.toEqual({ externalReference: "brevo:emails-0:logs-0:contacts-0" });
    expect(calls).toEqual([]);
  });

  it.each([
    [{ status: 500 }, /HTTP 500 from Brevo smtp\/log/u],
    [{ status: 401, code: "unauthorized" }, /HTTP 401 from Brevo smtp\/log/u],
    [{ status: 429, code: "too_many_requests" }, /HTTP 429 from Brevo smtp\/log/u],
    // A 404 that is not "nothing stored" (a wrong route, a moved API) must not count as erased.
    [{ status: 404, code: "not_found" }, /HTTP 404 from Brevo smtp\/log/u]
  ])("fails on Brevo reply %j without leaking the address", async (reply, message) => {
    stubBrevo(() => reply);
    const processor = createBrevoDeletionProcessor({ id: "brevo", apiKey: "k" });
    const attempt = processor.deleteAccount({
      requestId: "request-3",
      subjects: [{ provider: "primary_email", subject: "owner@example.test" }]
    });
    await expect(attempt).rejects.toThrow(message);
    await expect(attempt).rejects.not.toThrow(/owner@example\.test|owner%40/u);
  });

  it("purges an account end to end through the configured brevo processor", async () => {
    const calls = stubBrevo(() => ({ status: 204 }));
    const store = createCp2Store({
      accountDeletionProcessors: readAccountDeletionProcessors({
        ACCOUNT_DELETION_PROCESSORS_JSON: brevoOnly,
        BREVO_API_KEY: "brevo-key"
      })
    });
    const seeded = seedAccount(store);
    store.requestAccountDeletion({
      sessionId: seeded.sessionId,
      businessId: seeded.businessId,
      deletion: { confirmation: "DELETE" },
      now: requestedAt
    });

    const result = await store.purgeExpiredAccountDeletions(purgeAt);

    expect(result).toEqual({ checked: 1, completed: 1, partiallyFailed: 0, skipped: 0 });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.brevo.com/v3/smtp/log/owner%40example.test",
      "https://api.brevo.com/v3/contacts/owner%40example.test"
    ]);
    const snapshot = store.snapshot();
    expect(snapshot.accountDeletionProofs?.[0]?.processorReceipts).toEqual([
      expect.objectContaining({
        processorId: "brevo",
        status: "completed",
        externalReference: "brevo:emails-1:logs-1:contacts-1"
      })
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("owner@example.test");
  });

  it("erases a phone-primary account's backup and pending emails, which Brevo mails most", async () => {
    // Message notifications and recovery notices go to the verified backup email, and OTPs go to
    // every email being linked. Those live in account identities, not the primary destination.
    const calls = stubBrevo(() => ({ status: 204 }));
    const store = createCp2Store({
      accountDeletionProcessors: [createBrevoDeletionProcessor({ id: "brevo", apiKey: "k" })]
    });
    const owner = store.signupWithPhonePin({ destination: "+254700008555", pin: "7392" });
    store.beginEmailIdentityUpgrade({ sessionId: owner.session.id, email: "Backup@Example.test" });
    const otp = store.requestOtp({
      channel: "email",
      destination: "backup@example.test",
      purpose: "signup"
    });
    store.verifyPendingEmail({
      sessionId: owner.session.id,
      challengeId: otp.challengeId,
      code: otp.devOtp as string
    });
    store.beginEmailIdentityUpgrade({ sessionId: owner.session.id, email: "pending@example.test" });
    const created = store.createBusiness({
      sessionId: owner.session.id,
      name: "Phone Shop",
      language: "en",
      phoneNumber: "+254700008555",
      phoneCountry: "KE",
      now: requestedAt
    });
    store.requestAccountDeletion({
      sessionId: owner.session.id,
      businessId: created.business.id,
      deletion: { confirmation: "DELETE" },
      now: requestedAt
    });

    const result = await store.purgeExpiredAccountDeletions(
      new Date(Date.now() + 40 * 24 * 60 * 60 * 1000)
    );

    expect(result).toMatchObject({ completed: 1, partiallyFailed: 0 });
    expect(calls.map((call) => decodeURIComponent(call.url.split("/").pop() ?? ""))).toEqual([
      "backup@example.test",
      "backup@example.test",
      "pending@example.test",
      "pending@example.test"
    ]);
    expect(store.snapshot().accountDeletionProofs?.[0]?.processorReceipts[0]).toMatchObject({
      status: "completed",
      externalReference: "brevo:emails-2:logs-2:contacts-2"
    });
  });

  it("keeps the account when Brevo is down and finishes it on the next run", async () => {
    let brevoUp = false;
    stubBrevo(() => (brevoUp ? { status: 204 } : { status: 503 }));
    const store = createCp2Store({
      accountDeletionProcessors: [createBrevoDeletionProcessor({ id: "brevo", apiKey: "k" })]
    });
    const seeded = seedAccount(store);
    store.requestAccountDeletion({
      sessionId: seeded.sessionId,
      businessId: seeded.businessId,
      deletion: { confirmation: "DELETE" },
      now: requestedAt
    });

    expect(await store.purgeExpiredAccountDeletions(purgeAt)).toMatchObject({
      completed: 0,
      partiallyFailed: 1
    });
    expect(store.snapshot().accounts).toContainEqual(
      expect.objectContaining({ id: seeded.accountId })
    );

    brevoUp = true;
    expect(
      await store.purgeExpiredAccountDeletions(new Date("2026-02-02T00:00:01.000Z"))
    ).toMatchObject({ completed: 1, partiallyFailed: 0 });
    expect(store.snapshot().accounts).not.toContainEqual(
      expect.objectContaining({ id: seeded.accountId })
    );
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
