import { describe, expect, it, vi } from "vitest";
import type * as Api from "../apps/web/src/lib/api";

// voicecom P2.4, web side: a storefront guest's speech calls go to the guest routes with the
// guest's current capability token; the signed-in /v1/voice/* API is never called for a guest.

const apiFetch = vi.fn(async () => ({ text: "ok" }));
vi.mock("../apps/web/src/lib/api", async (original) => ({
  ...(await original<typeof Api>()),
  apiFetch: (...args: unknown[]) => apiFetch(...(args as []))
}));

const { guestVoicePost } = await import("../apps/web/src/messaging/voice-speech");

describe("guestVoicePost", () => {
  it("rewrites both speech calls to the storefront and sends the latest token", async () => {
    let token = "first";
    const post = guestVoicePost("mama mboga/1", () => token);
    await post(
      "/v1/voice/transcribe",
      { audioBase64: "AQID", contentType: "audio/webm" },
      {
        timeoutMs: 45_000
      }
    );
    token = "second";
    await post("/v1/voice/speak", { text: "Karibu." }, { timeoutMs: 45_000 });
    expect(apiFetch.mock.calls).toEqual([
      [
        "/public/storefronts/mama%20mboga%2F1/voice/transcribe",
        {
          method: "POST",
          body: { audioBase64: "AQID", contentType: "audio/webm", capabilityToken: "first" },
          urgent: true,
          timeoutMs: 45_000
        }
      ],
      [
        "/public/storefronts/mama%20mboga%2F1/voice/speak",
        {
          method: "POST",
          body: { text: "Karibu.", capabilityToken: "second" },
          urgent: true,
          timeoutMs: 45_000
        }
      ]
    ]);
  });
});
