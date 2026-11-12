import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readLinkedDocument } from "./document-reader.js";

describe("bounded reuse of the existing PDF extractor", () => {
  it("extracts an approved PDF without executing or rendering its contents", async () => {
    const bytes = readFileSync(
      new URL("../../../../../tests/fixtures/mock-product-catalogue.pdf", import.meta.url)
    );
    const pending = readLinkedDocument({
      bytes,
      filename: "catalogue.pdf",
      mimeType: "application/pdf"
    });
    await expect(
      readLinkedDocument({ bytes, filename: "second.pdf", mimeType: "application/pdf" })
    ).rejects.toThrow("capacity");
    const text = await pending;
    expect(text.trim().length).toBeGreaterThan(10);
    expect(text.length).toBeLessThanOrEqual(12000);
  }, 70000);
  it("rejects unsupported, oversized, invalid and cancelled inputs", async () => {
    await expect(
      readLinkedDocument({
        bytes: Buffer.from("bad"),
        filename: "bad.pdf",
        mimeType: "application/pdf"
      })
    ).rejects.toThrow("unavailable");
    await expect(
      readLinkedDocument({
        bytes: Buffer.alloc(5 * 1024 * 1024 + 1),
        filename: "big.pdf",
        mimeType: "application/pdf"
      })
    ).rejects.toThrow("Unsupported");
    await expect(
      readLinkedDocument({
        bytes: Buffer.from("text"),
        filename: "text.exe",
        mimeType: "application/x-executable"
      })
    ).rejects.toThrow("Unsupported");
    const controller = new AbortController();
    controller.abort();
    await expect(
      readLinkedDocument(
        { bytes: Buffer.from("%PDF-1.7"), filename: "cancel.pdf", mimeType: "application/pdf" },
        controller.signal
      )
    ).rejects.toThrow();
  }, 20000);
});
