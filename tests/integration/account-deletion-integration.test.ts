import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../../services/api/src/app";
import {
  createCp2Store,
  type AccountDeletionProcessor,
  type AccountDeletionProcessorInput
} from "../../services/api/src/cp2/store";

describe("Account deletion HTTP + purge integration", () => {
  let processorCalls: AccountDeletionProcessorInput[] = [];

  beforeEach(() => {
    processorCalls = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts an HTTP deletion request then runs purge with processor webhook", async () => {
    const processor: AccountDeletionProcessor = {
      id: "identity-gateway",
      async deleteAccount(input) {
        processorCalls.push(input);
        return { externalReference: "processor-proof-int-001" };
      }
    };

    const store = createCp2Store({ accountDeletionProcessors: [processor] });
    const app = buildApi({ cp2: { store } });

    const verifyResponse = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        method: "phone",
        contact: "+254700000999",
        pin: "3927"
      })
    });
    const setCookie = verifyResponse.headers["set-cookie"] as string | string[] | undefined;
    const cookieValue = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!cookieValue) throw new Error("Expected session cookie from PIN signup");
    const cookie = cookieValue.split(";")[0];

    const businessResponse = await app.inject({
      method: "POST",
      url: "/businesses",
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({ name: "Integration Shop", language: "en" })
    });
    const created = businessResponse.json<{ business: { id: string } }>().business;

    const res = await app.inject({
      method: "POST",
      url: `/businesses/${created.id}/compliance/account-deletion`,
      payload: { confirmation: "DELETE", reason: "Integration purge" },
      headers: { cookie }
    });

    expect(res.statusCode).toBe(200);
    const deletion = res.json<{
      id: string;
      status: string;
      anonymizeAfter: string;
    }>();
    expect(deletion).toHaveProperty("id");
    expect(deletion).toHaveProperty("status");
    expect(deletion.status).toBe("scheduled");

    const laterPurgeAt = new Date(new Date(deletion.anonymizeAfter).getTime() + 1);
    const result = await store.purgeExpiredAccountDeletions(laterPurgeAt);
    expect(result).toMatchObject({
      checked: 1,
      completed: 1,
      partiallyFailed: 0
    });
    expect(processorCalls).toHaveLength(1);
    expect(processorCalls[0]).toMatchObject({
      requestId: deletion.id,
      subjects: [{ provider: "primary_phone", subject: "+254700000999" }]
    });

    const snapshot = store.snapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("+254700000999");
    expect(snapshot.accountDeletionProofs?.length).toBeGreaterThan(0);
    await app.close();
  });
});
