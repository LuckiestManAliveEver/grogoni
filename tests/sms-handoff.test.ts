import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildExternalSmsUri,
  isLongSmsBody,
  normalizeSmsRecipient,
  openSmsComposer,
  selectMessageComposerChannel,
  smsNativeSendingEnabled
} from "../apps/web/src/messaging/sms-handoff";

describe("external SMS composer handoff", () => {
  it.each([
    ["0712345678", "+254712345678"],
    ["0112345678", "+254112345678"],
    ["+254712345678", "+254712345678"],
    ["254712345678", "+254712345678"]
  ])("normalizes Kenyan recipient %s to %s", (input, expected) => {
    expect(normalizeSmsRecipient(input, "KE")).toBe(expected);
  });

  it("keeps a valid non-Kenyan international number", () => {
    expect(normalizeSmsRecipient("+14155552671", "KE")).toBe("+14155552671");
  });

  it.each(["", "123", "grogoni: grogoni.janes-shop", "grogoni.janes-shop"])(
    "rejects invalid or Grogoni-only recipient %s",
    (input) => {
      expect(() => normalizeSmsRecipient(input, "KE")).toThrow();
    }
  );

  it("safely builds a text-only sms URI", () => {
    expect(buildExternalSmsUri("+254712345678", "Hello & karibu?")).toBe(
      "sms:+254712345678?body=Hello%20%26%20karibu%3F"
    );
  });

  it("prefers the typed native composer bridge", async () => {
    const openSmsComposerBridge = vi.fn().mockResolvedValue({ status: "composer_opened" });
    const navigate = vi.fn();
    const result = await openSmsComposer("+254712345678", "Hello", {
      nativeBridge: { openSmsComposer: openSmsComposerBridge },
      navigate,
      userAgent: "Android"
    });

    expect(openSmsComposerBridge).toHaveBeenCalledWith("+254712345678", "Hello");
    expect(navigate).not.toHaveBeenCalled();
    expect(result).toEqual({
      channel: "sms_external_app",
      status: "composer_opened",
      errorCode: null,
      nativeBridgeUsed: true
    });
  });

  it("returns a controlled error when the native bridge finds no SMS app", async () => {
    const result = await openSmsComposer("+254712345678", "Hello", {
      nativeBridge: {
        openSmsComposer: vi
          .fn()
          .mockResolvedValue({ status: "no_sms_app", errorCode: "no_sms_app" })
      },
      navigate: vi.fn(),
      userAgent: "Android"
    });

    expect(result.status).toBe("no_sms_app");
    expect(result.errorCode).toBe("no_sms_app");
  });

  it("uses the PWA fallback on Android without a native bridge", async () => {
    const navigate = vi.fn();
    const result = await openSmsComposer("+254712345678", "Hello Jane", {
      navigate,
      userAgent: "Mozilla/5.0 (Linux; Android 15) Mobile"
    });

    expect(navigate).toHaveBeenCalledWith("sms:+254712345678?body=Hello%20Jane");
    expect(result).toMatchObject({
      status: "composer_opened",
      nativeBridgeUsed: false
    });
  });

  it.each([
    "Mozilla/5.0 (X11; Linux x86_64)",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "KaiOS/3.0",
    ""
  ])("allows the operating system to resolve an SMS handler for %s", async (userAgent) => {
    const navigate = vi.fn();
    const result = await openSmsComposer("+254712345678", "Hello", {
      navigate,
      userAgent
    });

    expect(navigate).toHaveBeenCalledWith("sms:+254712345678?body=Hello");
    expect(result).toMatchObject({
      status: "composer_opened",
      errorCode: null
    });
  });

  it.each(["iPhone", "iPad", "Macintosh"])(
    "uses recipient-only Apple SMS links on %s",
    async (userAgent) => {
      const navigate = vi.fn();
      await openSmsComposer("+254712345678", "Copy this text", { navigate, userAgent });
      expect(navigate).toHaveBeenCalledWith("sms:+254712345678");
    }
  );

  it("preserves a controlled failure when URI dispatch throws", async () => {
    const result = await openSmsComposer("+254712345678", "Hello", {
      navigate: () => {
        throw new Error("No handler");
      },
      userAgent: "Unknown device"
    });
    expect(result.status).toBe("no_sms_app");
  });

  it("keeps Grogoni as default and selects SMS only after an explicit request", () => {
    expect(selectMessageComposerChannel({ isGrogoniRecipient: true, smsRequested: false })).toBe(
      "grogoni"
    );
    expect(selectMessageComposerChannel({ isGrogoniRecipient: false, smsRequested: false })).toBe(
      "unsupported"
    );
    expect(selectMessageComposerChannel({ isGrogoniRecipient: true, smsRequested: true })).toBe(
      "sms_external_app"
    );
    expect(smsNativeSendingEnabled).toBe(false);
  });

  it("warns for content that may be split into multiple carrier messages", () => {
    expect(isLongSmsBody("a".repeat(160))).toBe(false);
    expect(isLongSmsBody("a".repeat(161))).toBe(true);
  });

  it("does not hard-code an SMS package or request restricted SMS access", () => {
    const source = readFileSync(
      new URL("../apps/web/src/messaging/sms-handoff.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toMatch(/com\.google\.android\.apps\.messaging|com\.samsung/i);
    expect(source).not.toMatch(/\b(?:READ_SMS|RECEIVE_SMS|SEND_SMS|WRITE_SMS|SmsManager)\b/);
  });
});
