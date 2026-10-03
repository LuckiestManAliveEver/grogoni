import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createSignedNetworkInviteSender } from "../services/api/src/cp2/network-invite-provider";
import { createCp2Store, type NetworkInviteSender } from "../services/api/src/cp2/store";

describe("network invite delivery pipeline", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers created invites and returns their persisted delivery status", async () => {
    const sender = vi.fn<NetworkInviteSender>().mockResolvedValue({ status: "sent" });
    const app = buildApi({ cp2: { store: createCp2Store({ networkInviteSender: sender }) } });
    const { businessId, cookie } = await createOwnerBusiness(app);

    const response = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/network/invites`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({
        contacts: [{ name: "Amina", phone: "+254700000333", email: null }]
      })
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      invites: [
        {
          status: "sent",
          deliveredAt: expect.any(String),
          failureReason: null
        }
      ]
    });
    expect(sender).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId,
        businessName: "Invite Delivery Shop",
        channel: "phone",
        destination: "+254700000333"
      })
    );
    await app.close();
  });

  it("signs webhook deliveries and converts upstream rejection into a stable failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const sender = createSignedNetworkInviteSender(
      "https://delivery.example.test/invites",
      "a-secure-test-secret-that-is-long-enough"
    );

    await expect(
      sender({
        inviteId: "invite-0001",
        businessId: "business-0001",
        businessName: "Test Shop",
        channel: "email",
        destination: "buyer@example.test",
        contactName: "Buyer"
      })
    ).resolves.toEqual({ status: "failed", failureReason: "delivery_http_503" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://delivery.example.test/invites",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "idempotency-key": "invite-0001",
          "x-grogoni-invite-signature": expect.stringMatching(/^sha256=[a-f0-9]{64}$/u)
        })
      })
    );
  });
});

async function createOwnerBusiness(app: ReturnType<typeof buildApi>) {
  const verified = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({
      method: "phone",
      contact: "+254700000332",
      pin: "1234"
    })
  });
  const setCookie = verified.headers["set-cookie"];
  const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0] ?? "";
  const business = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: { cookie, "content-type": "application/json" },
    payload: JSON.stringify({ name: "Invite Delivery Shop", language: "en" })
  });

  return { businessId: business.json<{ business: { id: string } }>().business.id, cookie };
}
