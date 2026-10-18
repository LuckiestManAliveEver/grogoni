// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  ReceiptOCRJobSummary,
  ReceiptStructuredExtractionSummary
} from "@grogoni/shared-types";
import { ReceiptFieldsForm } from "../apps/web/src/ReceiptFieldsForm";

it("keeps edited receipt fields unready until their corrections have saved", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const ready = vi.fn();
  let finish!: () => void;
  const save = vi.fn<(fields: ReceiptStructuredExtractionSummary) => Promise<void>>(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  const job = {
    id: "draft",
    sourceFileName: "delivery.png",
    status: "REVIEW_REQUIRED",
    structuredExtraction: {
      supplier: { supplierName: "Wholesaler", phoneNumber: "+254712345678" },
      salesAgent: { name: "Agent", phoneNumber: "+254722345678" },
      receipt: { total: 570 },
      products: []
    }
  } as unknown as ReceiptOCRJobSummary;
  try {
    await act(async () =>
      root.render(<ReceiptFieldsForm job={job} onSave={save} onReviewStateChange={ready} />)
    );
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="salesAgent phoneNumber"]'
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "+254733345678"
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(ready).toHaveBeenLastCalledWith(false);
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(save.mock.calls[0]![0].salesAgent.phoneNumber).toBe("+254733345678");
    expect(ready).not.toHaveBeenCalledWith(true);
    await act(async () => finish());
    expect(ready).toHaveBeenLastCalledWith(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
