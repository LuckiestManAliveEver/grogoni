import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";

// voicecom P2.4: storefront guests can talk too. The full Node API: a real guest session's
// capability unlocks /public/storefronts/:id/voice/*, an expired or unknown one does not.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubProvider() {
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
  const fetch = vi.fn(async (url: string | URL) =>
    String(url).endsWith("/audio/transcriptions")
      ? Response.json({ text: "Do you have two kilos of sugar?" })
      : new Response(new Uint8Array([0x49, 0x44, 0x33, 4]), {
          headers: { "content-type": "audio/mpeg" }
        })
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("guest voice on the storefront", () => {
  it("serves a real guest session and refuses an unknown or expired one", async () => {
    const fetch = stubProvider();
    const app = buildApi();
    try {
      const owner = await createOwnerBusiness(app, "254700000091", "Voice Market", "3091");
      const guest = await injectJson(
        app,
        "POST",
        `/public/storefronts/${owner.grogoniId}/sessions`,
        { visitorId: "voice-visitor-1" }
      );
      const heard = await app.inject({
        method: "POST",
        url: `/public/storefronts/${owner.grogoniId}/voice/transcribe`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          capabilityToken: guest.capabilityToken,
          audioBase64: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString("base64"),
          contentType: "audio/webm"
        })
      });
      expect(heard.statusCode, heard.body).toBe(200);
      expect(heard.json().text).toBe("Do you have two kilos of sugar?");
      const spoken = await app.inject({
        method: "POST",
        url: `/public/storefronts/${owner.grogoniId}/voice/speak`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ capabilityToken: guest.capabilityToken, text: "Ndiyo, tunayo." })
      });
      expect(spoken.statusCode, spoken.body).toBe(200);
      expect(spoken.json().contentType).toBe("audio/mpeg");
      expect(fetch).toHaveBeenCalledTimes(2);

      const refused = await app.inject({
        method: "POST",
        url: `/public/storefronts/${owner.grogoniId}/voice/speak`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ capabilityToken: "not-a-real-token", text: "Hi." })
      });
      expect(refused.statusCode).toBe(401);
      expect(refused.json().code).toBe("customer_capability_invalid");

      // Past expiry the same token stops working.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 400 * 24 * 60 * 60 * 1000);
      const expired = await app.inject({
        method: "POST",
        url: `/public/storefronts/${owner.grogoniId}/voice/speak`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ capabilityToken: guest.capabilityToken, text: "Hi." })
      });
      vi.useRealTimers();
      expect(expired.statusCode).toBe(401);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });
});

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  destination: string,
  name: string,
  pin: string
): Promise<{ grogoniId: string }> {
  const verify = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: destination, pin })
  });
  const raw = verify.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0] ?? "";
  const business = await injectJson(app, "POST", "/businesses", { name, language: "en" }, cookie);
  return business.business as { grogoniId: string };
}

async function injectJson(
  app: ReturnType<typeof buildApi>,
  method: "POST",
  url: string,
  payload: unknown,
  cookie?: string
  // Fastify injection returns untyped JSON; shapes are asserted at each call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const response = await app.inject({
    method,
    url,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode, response.body).toBeLessThan(300);
  return response.json();
}
