import { describe, expect, it } from "vitest";
import { checkCurrentOcrContracts } from "../scripts/check-current-ocr-contracts.mjs";

describe("current OCR documentation and provenance guard", () => {
  it("rejects a retired worker deployment setting in the active environment example", async () => {
    const violations = await checkCurrentOcrContracts({
      read: async (path: string) =>
        path === ".env.example" ? "OCR_WORKER_URL=http://retired.invalid" : ""
    });
    expect(violations).toContain(".env.example: retired operational reference OCR_WORKER_URL");
  });

  it("rejects fabricated worker defaults in the active receipt domain", async () => {
    const violations = await checkCurrentOcrContracts({
      read: async (path: string) =>
        path.endsWith("suppliers/shared.ts")
          ? 'export function readReceiptOCRConfig() { return "paddleocr-2.8.1"; }'
          : ""
    });
    expect(violations).toContain(
      "services/api/src/cp2/domains/suppliers/shared.ts: retired OCR default readReceiptOCRConfig"
    );
  });

  it("allows historical engine compatibility without reading historical audits as current instructions", async () => {
    const reads: string[] = [];
    const violations = await checkCurrentOcrContracts({
      read: async (path: string) => {
        reads.push(path);
        return 'Historical engine type: "paddleocr" | "tesseract" | "provided_text"';
      }
    });
    expect(violations).toEqual([]);
    expect(reads).not.toContain("docs/architecture/resource-isolation-audit.md");
  });
});
