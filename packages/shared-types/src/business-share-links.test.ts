import { describe, expect, it } from "vitest";
import { parseWhatsAppShareLink } from "./whatsapp-link.js";
import { businessShareLinksLimits } from "./business-settings.js";

describe("parseWhatsAppShareLink", () => {
  it("parses a https://wa.me/<digits> link", () => {
    expect(parseWhatsAppShareLink("https://wa.me/254712345678")).toEqual({
      url: "https://wa.me/254712345678",
      phoneDigits: "254712345678"
    });
  });

  it("parses the wa.me/?phone= form", () => {
    expect(parseWhatsAppShareLink("https://wa.me/?phone=254712345678")).toEqual({
      url: "https://wa.me/254712345678",
      phoneDigits: "254712345678"
    });
  });

  it("parses an api.whatsapp.com/send?phone= link", () => {
    expect(parseWhatsAppShareLink("https://api.whatsapp.com/send?phone=254712345678")).toEqual({
      url: "https://wa.me/254712345678",
      phoneDigits: "254712345678"
    });
  });

  it("accepts a bare phone number as a friendly shorthand", () => {
    expect(parseWhatsAppShareLink("+254 712 345 678")).toEqual({
      url: "https://wa.me/254712345678",
      phoneDigits: "254712345678"
    });
  });

  it("treats blank input as unset", () => {
    expect(parseWhatsAppShareLink("   ")).toBeNull();
    expect(parseWhatsAppShareLink("")).toBeNull();
  });

  it("rejects non-WhatsApp hosts, protocols and malformed numbers", () => {
    expect(parseWhatsAppShareLink("https://evil.example.com/254712345678")).toBeNull();
    expect(parseWhatsAppShareLink("javascript:alert(1)")).toBeNull();
    expect(parseWhatsAppShareLink("tel:+254712345678")).toBeNull();
    expect(parseWhatsAppShareLink("https://wa.me/123")).toBeNull();
    expect(parseWhatsAppShareLink("https://wa.me/1234567890123456")).toBeNull();
  });

  it("never produces a disguised script or redirect URL", () => {
    const parsed = parseWhatsAppShareLink("http://wa.me/254712345678");
    expect(parsed?.url.startsWith("https://wa.me/")).toBe(true);
  });
});

describe("businessShareLinksLimits", () => {
  it("exposes bounded lengths for pre-validation", () => {
    expect(businessShareLinksLimits.publicNoteMaximumLength).toBeGreaterThan(0);
    expect(businessShareLinksLimits.whatsappUrlMaximumLength).toBeGreaterThan(0);
  });
});
