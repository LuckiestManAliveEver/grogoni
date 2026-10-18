// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ReceiptOCRJobSummary } from "@grogoni/shared-types";
import { DeliveryReceiptReviewPanel } from "../apps/web/src/DeliveryReceiptReviewPanel";
import {
  buildReceiptStructuredExtraction,
  parseReceiptText
} from "../services/api/src/cp2/domains/suppliers/shared";

it("confirms the saved contact matches from the chat review card and requests stock receipt", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const job = {
    id: "delivery",
    sourceFileName: "delivery.png",
    status: "REVIEW_REQUIRED",
    updatedAt: "2026-10-18T00:00:00Z",
    fullText: "Delivery",
    matchedSupplierId: "old",
    matchedSalesAgentId: null,
    salesAgentName: null,
    structuredExtraction: buildReceiptStructuredExtraction(parseReceiptText(""))
  } as ReceiptOCRJobSummary;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      requests.push({ path, body });
      return Response.json(
        init?.method === "PATCH"
          ? { ...job, matchedSupplierId: "reviewed", updatedAt: "2026-10-18T00:01:00Z" }
          : init?.method === "POST"
            ? { id: "receipt", createdAt: "2026-10-18T00:02:00Z" }
            : [job]
      );
    })
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DeliveryReceiptReviewPanel businessId="shop" />));
    expect(container.querySelector("form")).not.toBeNull();
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    const confirm = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Confirm and save"
    )!;
    expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());
    expect(requests.find((r) => r.path.endsWith("/confirm"))?.body).toMatchObject({
      supplierId: "reviewed",
      createSupplier: false,
      receiveInventory: true
    });
    expect(container.textContent).toContain("Records linked by this receipt");
    expect(container.textContent).not.toContain("Confirm and save");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
