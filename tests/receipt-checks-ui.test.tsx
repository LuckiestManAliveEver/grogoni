// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReceiptChecksSummary, ReceiptOCRJobSummary } from "../packages/shared-types/src";
import { ReceiptChecksPanel, receiptReadyToConfirm } from "../apps/web/src/ReceiptChecksPanel";
import { ReceiptFieldsForm } from "../apps/web/src/ReceiptFieldsForm";
import {
  buildReceiptStructuredExtraction,
  parseReceiptText
} from "../services/api/src/cp2/domains/suppliers/shared";

// The review screen shows what confirmation will check: the document type, why it cannot post,
// and each mismatch to correct or tick as checked against the paper.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
let host: HTMLDivElement;
afterEach(() => host?.remove());

const mismatch: ReceiptChecksSummary = {
  documentType: "purchase_receipt",
  recordPurchase: true,
  receiveStock: true,
  refusal: null,
  arithmeticIssues: [
    {
      code: "line_total_mismatch",
      field: "products.0.lineTotal",
      expected: 1900,
      printed: 1800,
      message: "Sugar 2kg: 5 × 380 is 1900, but the line says 1800."
    }
  ]
};

describe("receipt checks panel", () => {
  it("lists a mismatch with a tick, and confirm waits for the tick", async () => {
    host = document.createElement("div");
    document.body.append(host);
    const onAcknowledge = vi.fn();
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <ReceiptChecksPanel
          checks={mismatch}
          acknowledged={new Set()}
          onAcknowledge={onAcknowledge}
        />
      )
    );
    expect(host.textContent).toContain("Purchase receipt");
    expect(host.textContent).toContain("5 × 380 is 1900, but the line says 1800");
    act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(onAcknowledge).toHaveBeenCalledWith("products.0.lineTotal", true);
    expect(receiptReadyToConfirm(mismatch, new Set())).toBe(false);
    expect(receiptReadyToConfirm(mismatch, new Set(["products.0.lineTotal"]))).toBe(true);
    act(() => root.unmount());
  });

  it("says why a quotation cannot be saved, and never lets it confirm", async () => {
    host = document.createElement("div");
    document.body.append(host);
    const quotation: ReceiptChecksSummary = {
      documentType: "quotation",
      recordPurchase: false,
      receiveStock: false,
      refusal:
        "A quotation or pro-forma is an offer: it cannot be saved as a purchase or move stock.",
      arithmeticIssues: []
    };
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <ReceiptChecksPanel
          checks={quotation}
          acknowledged={new Set()}
          onAcknowledge={() => undefined}
        />
      )
    );
    expect(host.textContent).toContain("Quotation · cannot be saved as a purchase");
    expect(host.textContent).toContain("it cannot be saved as a purchase or move stock");
    expect(receiptReadyToConfirm(quotation, new Set())).toBe(false);
    // A draft from before the checks existed confirms as it did.
    expect(receiptReadyToConfirm(undefined, new Set())).toBe(true);
    act(() => root.unmount());
  });
});

describe("receipt fields form", () => {
  it("offers the document type as a choice and marks a computed line total", async () => {
    host = document.createElement("div");
    document.body.append(host);
    const fields = buildReceiptStructuredExtraction(parseReceiptText("Sugar, 5, 380"));
    fields.receipt.documentType = "purchase_receipt";
    const job = {
      id: "job-1",
      status: "REVIEW_REQUIRED",
      sourceFileName: "scan.png",
      structuredExtraction: fields
    } as unknown as ReceiptOCRJobSummary;
    const onSave = vi.fn(async () => undefined);
    const root = createRoot(host);
    await act(async () => root.render(<ReceiptFieldsForm job={job} onSave={onSave} />));
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Document type"]')!;
    expect(select.value).toBe("purchase_receipt");
    // documentType is the picker, never a free-text box among the receipt fields.
    expect(host.querySelector('input[aria-label="receipt documentType"]')).toBeNull();
    expect(host.textContent).toContain("(calculated, not printed)");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
        select,
        "invoice"
      );
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => host.querySelector("form")!.requestSubmit());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ receipt: expect.objectContaining({ documentType: "invoice" }) })
    );
    act(() => root.unmount());
  });
});
