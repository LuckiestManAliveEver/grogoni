// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../apps/web/src/app-shell";
import {
  appendExtractedDocumentContent,
  extractChatAttachment,
  type AttachmentExtractionDependencies
} from "../apps/web/src/chat-message-plumbing";

const photoBytes = "maize flour 2kg KES 240";
const photo: ChatAttachment = {
  id: "photo-1",
  name: "receipt.jpg",
  type: "image/jpeg",
  size: photoBytes.length,
  category: "image",
  dataUrl: `data:image/jpeg;base64,${Buffer.from(photoBytes).toString("base64")}`
} as ChatAttachment;
const sheet: ChatAttachment = {
  id: "sheet-1",
  name: "stock.csv",
  type: "text/csv",
  size: 12,
  category: "document",
  dataUrl: `data:text/csv;base64,${Buffer.from("item,qty\nrice,4").toString("base64")}`
} as ChatAttachment;

function dependencies(overrides: Partial<AttachmentExtractionDependencies> = {}) {
  return {
    runLocalOcr: vi.fn(async () => ({
      fullText: "MAIZE FLOUR 2KG 240",
      averageConfidence: 0.91,
      warnings: []
    })),
    postJson: vi.fn(async () => ({
      fileName: "stock.csv",
      contentType: "text/csv",
      text: "item,qty\nrice,4",
      format: "spreadsheet",
      warnings: [],
      sizeBytes: 15,
      checksum: "abc"
    })),
    ...overrides
  } satisfies AttachmentExtractionDependencies;
}

describe("chat attachment extraction", () => {
  it("reads photos on the device and never calls the retired server OCR route", async () => {
    const deps = dependencies();
    const result = await extractChatAttachment(photo, "shop-1", deps);

    expect(deps.runLocalOcr).toHaveBeenCalledWith({
      fileName: "receipt.jpg",
      contentType: "image/jpeg",
      contentBase64: Buffer.from(photoBytes).toString("base64")
    });
    expect(deps.postJson).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      text: "MAIZE FLOUR 2KG 240",
      format: "ocr",
      engine: "tesseract",
      averageConfidence: 0.91,
      sizeBytes: photoBytes.length,
      checksum: createHash("sha256").update(photoBytes).digest("hex")
    });
  });

  it("sends documents to the extract route only", async () => {
    const deps = dependencies();
    await extractChatAttachment(sheet, "shop-1", deps);
    expect(deps.postJson).toHaveBeenCalledTimes(1);
    expect(deps.postJson).toHaveBeenCalledWith(
      "/businesses/shop-1/documents/extract",
      expect.objectContaining({ fileName: "stock.csv" })
    );
    expect(deps.runLocalOcr).not.toHaveBeenCalled();
  });

  it("does not fall back to a server OCR route when a scanned PDF has no text layer", async () => {
    const deps = dependencies({
      postJson: vi.fn(async () => {
        throw new Error("No text layer.");
      })
    });
    const pdf = { ...sheet, name: "scan.pdf", type: "application/pdf" } as ChatAttachment;
    await expect(extractChatAttachment(pdf, "shop-1", deps)).rejects.toThrow("No text layer.");
    expect(deps.postJson).toHaveBeenCalledTimes(1);
  });

  it("treats a photo with no text as a normal result, without warning the person", async () => {
    const deps = dependencies({
      runLocalOcr: vi.fn(async () => ({ fullText: "  \n", averageConfidence: 0, warnings: [] }))
    });
    const result = await extractChatAttachment(photo, "shop-1", deps);
    expect(result).toMatchObject({
      text: "(no readable text in this photo)",
      warnings: ["no_readable_text"]
    });
    const onUnreadable = vi.fn();
    const message = await appendExtractedDocumentContent("Price this", [photo], "shop-1", {
      dependencies: deps,
      onUnreadable
    });
    expect(onUnreadable).not.toHaveBeenCalled();
    expect(message).toContain("(no readable text in this photo)");
  });

  it("keeps the turn alive when one attachment cannot be read", async () => {
    const deps = dependencies({
      runLocalOcr: vi.fn(async () => {
        throw new Error(
          "The on-device scanner is not installed on this device. Enable it from Settings."
        );
      })
    });

    const onUnreadable = vi.fn();
    const message = await appendExtractedDocumentContent(
      "What is in these?",
      [photo, sheet],
      "shop-1",
      { dependencies: deps, onUnreadable }
    );
    expect(onUnreadable).toHaveBeenCalledWith([
      {
        name: "receipt.jpg",
        reason: "The on-device scanner is not installed on this device. Enable it from Settings."
      }
    ]);

    expect(message).toContain("What is in these?");
    expect(message).toContain('[document-extraction file="receipt.jpg" status="unreadable"]');
    expect(message).toContain("The on-device scanner is not installed on this device.");
    expect(message).toContain('[document-extraction file="stock.csv" format="spreadsheet"]');
    expect(message).toContain("rice,4");
  });
});
