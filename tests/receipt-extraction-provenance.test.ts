import { describe, expect, it, vi } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";

function fixture() {
  const store = createCp2Store();
  const owner = store.signupWithPhonePin({ destination: "+254712346791", pin: "3927" });
  const business = store.createBusiness({
    sessionId: owner.session.id,
    name: "Receipt provenance shop",
    language: "en"
  }).business;
  const input = {
    sessionId: owner.session.id,
    businessId: business.id,
    sourceFileName: "receipt.txt",
    contentType: "text/plain",
    extractedText: "Supplier: Acacia\nRice,2,100,200\nTotal: 200"
  };
  return { store, input };
}

describe("receipt extraction provenance after OCR worker retirement", () => {
  it("never fabricates an engine or confidence from retired worker settings", () => {
    vi.stubEnv("OCR_ENGINE_PRIMARY", "paddleocr");
    vi.stubEnv("OCR_ENGINE_VERSION", "paddleocr-2.8.1");
    vi.stubEnv("OCR_MODEL_VERSION", "balanced-cpu");
    vi.stubEnv("OCR_PROFILE", "accurate");
    vi.stubEnv("OCR_LANGUAGE_HINTS", "en,sw");
    try {
      const { store, input } = fixture();
      const job = store.createReceiptOCRJob(input);
      expect(job).toMatchObject({
        engine: "provided_text",
        engineVersion: "not-applicable",
        modelVersion: "not-applicable",
        averageConfidence: 0,
        profile: "balanced",
        fallbackUsed: false,
        languageHints: []
      });
      expect(job.blocks.length).toBeGreaterThan(0);
      expect(job.blocks.every((block) => block.confidence === 0)).toBe(true);
      expect(job.items[0]).toMatchObject({ name: "Rice", quantity: 2, unitPrice: 100, total: 200 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("preserves supplied browser-engine evidence instead of overwriting it with text defaults", () => {
    const { store, input } = fixture();
    const extraction = {
      engine: "tesseract" as const,
      engineVersion: "7.0.0",
      modelVersion: "eng-4.0.0_best_int",
      profile: "mobile" as const,
      fallbackUsed: false,
      blocks: [
        { id: "block-1", page: 1, text: input.extractedText, confidence: 0.87, boundingBox: null }
      ],
      fullText: input.extractedText,
      averageConfidence: 0.87,
      warnings: []
    };
    const job = store.createReceiptOCRJob({ ...input, extraction });
    expect(job).toMatchObject({ ...extraction, languageHints: ["eng"] });
  });

  it("does not turn saved corrections into fabricated 100-percent OCR confidence", () => {
    const { store, input } = fixture();
    const job = store.createReceiptOCRJob({
      ...input,
      extraction: {
        engine: "tesseract",
        engineVersion: "7.0.0",
        modelVersion: "eng-4.0.0_best_int",
        profile: "mobile",
        fallbackUsed: false,
        fullText: input.extractedText,
        averageConfidence: 0.87,
        warnings: [],
        blocks: [
          { id: "ocr-1", page: 1, text: input.extractedText, confidence: 0.87, boundingBox: null }
        ]
      }
    });
    const fieldsOnly = store.correctReceiptOCRJob({
      ...input,
      ocrJobId: job.id,
      structuredExtraction: job.structuredExtraction
    });
    expect(fieldsOnly).toMatchObject({
      engine: "tesseract",
      averageConfidence: 0.87,
      blocks: job.blocks
    });
    const changed = store.correctReceiptOCRJob({
      ...input,
      ocrJobId: job.id,
      extractedText: input.extractedText.replace("Rice", "Wheat")
    });
    expect(changed).toMatchObject({
      engine: "provided_text",
      engineVersion: "not-applicable",
      modelVersion: "not-applicable",
      averageConfidence: 0,
      languageHints: [],
      fallbackUsed: false
    });
    expect(changed.blocks.every((block) => block.confidence === 0)).toBe(true);
  });

  it("restores existing PaddleOCR records without relabeling historical evidence", () => {
    const { store, input } = fixture();
    const job = store.createReceiptOCRJob(input);
    const snapshot = store.snapshot();
    const saved = snapshot.receiptOCRJobs.find((record) => record.id === job.id)!;
    Object.assign(saved, {
      engine: "paddleocr",
      engineVersion: "paddleocr-2.8.1",
      modelVersion: "balanced-cpu",
      averageConfidence: 0.9
    });
    const restored = createCp2Store();
    restored.hydrateSnapshot(snapshot);
    expect(restored.listReceiptOCRJobs(input)[0]).toMatchObject({
      engine: "paddleocr",
      engineVersion: "paddleocr-2.8.1",
      modelVersion: "balanced-cpu",
      averageConfidence: 0.9
    });
  });
});
