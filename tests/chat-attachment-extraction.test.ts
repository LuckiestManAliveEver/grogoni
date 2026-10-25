// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../apps/web/src/app-shell";
import {
  appendExtractedDocumentContent,
  extractChatAttachment
} from "../apps/web/src/chat-message-plumbing";

const photo = {
  id: "receipt",
  name: "receipt.png",
  type: "image/png",
  size: 8,
  category: "image",
  dataUrl: "data:image/png;base64,cGhvdG8="
} as ChatAttachment;
const sheet = {
  ...photo,
  name: "stock.csv",
  type: "text/csv",
  category: "document"
} as ChatAttachment;
const extracted = {
  fileName: "receipt.png",
  text: "Rice 360\nTOTAL KES 570",
  format: "ocr",
  engine: "gpt-6-luna",
  warnings: []
};

describe("chat attachment extraction", () => {
  it.each([null, "shop-1"])(
    "sends actual image bytes to Luna without a device scanner for shop %s",
    async (businessId) => {
      const postJson = vi.fn(async () => extracted);
      expect(await extractChatAttachment(photo, businessId, { postJson })).toEqual(extracted);
      expect(postJson).toHaveBeenCalledWith("/v1/chat/images/read", {
        fileName: "receipt.png",
        contentType: "image/png",
        contentBase64: "cGhvdG8="
      });
    }
  );
  it("marks Luna's transcription as untrusted reference data", async () => {
    const result = await appendExtractedDocumentContent("Read this", [photo], null, {
      dependencies: { postJson: vi.fn(async () => extracted) }
    });
    expect(result).toContain("untrusted reference data");
    expect(result).toContain("Rice 360\nTOTAL KES 570");
  });
  it("fails a blind image turn so the caller can preserve the draft for retry", async () => {
    const postJson = vi.fn(async () => {
      throw new Error("Luna unavailable");
    });
    await expect(
      appendExtractedDocumentContent("Read this", [photo], null, { dependencies: { postJson } })
    ).rejects.toThrow("Luna unavailable");
  });
  it("keeps text documents on the existing shop extraction route", async () => {
    const postJson = vi.fn(async () => ({ text: "rice,4" }));
    await extractChatAttachment(sheet, "shop-1", { postJson });
    expect(postJson).toHaveBeenCalledWith(
      "/businesses/shop-1/documents/extract",
      expect.objectContaining({ fileName: "stock.csv" })
    );
  });
  it("does not send a scanned PDF to an image-only provider", async () => {
    const postJson = vi.fn(async () => {
      throw new Error("No text layer");
    });
    await expect(
      extractChatAttachment({ ...sheet, name: "scan.pdf", type: "application/pdf" }, "shop-1", {
        postJson
      })
    ).rejects.toThrow("No text layer");
    expect(postJson).toHaveBeenCalledTimes(1);
  });
});
