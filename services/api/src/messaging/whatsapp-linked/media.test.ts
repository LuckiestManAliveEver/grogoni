import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateLinkedMedia, type LinkedMedia } from "./media.js";

function descriptor(bytes: Buffer, mimeType: string, type: LinkedMedia["type"]): LinkedMedia {
  return {
    type,
    mimeType,
    filename: "untrusted.exe",
    size: bytes.length,
    directPath: "/mms/test.enc",
    key: Buffer.alloc(32).toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("base64")
  };
}
describe("bounded WhatsApp media policy", () => {
  it("accepts a PDF as an untrusted document with a safe filename", () => {
    const bytes = Buffer.from("%PDF-1.7\nexample");
    expect(
      validateLinkedMedia(descriptor(bytes, "application/pdf", "document"), bytes)
    ).toMatchObject({ filename: "untrusted.pdf", kind: "pdf", category: "document" });
  });
  it("retains Ogg audio for the existing attachment fallback without claiming a transcript", () => {
    const bytes = Buffer.from("OggS\0example");
    expect(
      validateLinkedMedia(descriptor(bytes, "audio/ogg; codecs=opus", "audio"), bytes)
    ).toMatchObject({ filename: "untrusted.ogg", kind: "file", category: "audio" });
  });
  it("rejects payload tampering, executable/html disguises and mismatched types", () => {
    const bytes = Buffer.from("%PDF-1.7\nexample");
    expect(() =>
      validateLinkedMedia(
        descriptor(bytes, "application/pdf", "document"),
        Buffer.alloc(bytes.length)
      )
    ).toThrow("checksum");
    const html = Buffer.from("<script>alert(1)</script>");
    expect(() =>
      validateLinkedMedia(descriptor(html, "application/pdf", "document"), html)
    ).toThrow("format");
    expect(() => validateLinkedMedia(descriptor(bytes, "application/pdf", "image"), bytes)).toThrow(
      "type"
    );
  });
  it("bounds image dimensions before an image decoder or browser sees the file", () => {
    const png = Buffer.alloc(32);
    Buffer.from("89504e470d0a1a0a", "hex").copy(png);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    expect(validateLinkedMedia(descriptor(png, "image/png", "image"), png).kind).toBe("image");
    png.writeUInt32BE(100_000, 16);
    expect(() => validateLinkedMedia(descriptor(png, "image/png", "image"), png)).toThrow(
      "megapixel"
    );
  });
});
