import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const card = readFileSync("apps/web/src/PurchaseSaleRecordsCard.tsx", "utf8");
const supplierSurface = readFileSync("apps/web/src/SupplierSurface.tsx", "utf8");
const ownerWorkspace = readFileSync("apps/web/src/OwnerWorkspace.tsx", "utf8");
const routes = readFileSync("services/api/src/cp2/domains/commercial-records/routes.ts", "utf8");

describe("purchase and sale records card (permanent surface, no chat wiring)", () => {
  it("is a self-contained card that fetches and mutates its own data from businessId alone", () => {
    expect(card).toContain(
      "export default function PurchaseSaleRecordsCard(props: { businessId: string })"
    );
    expect(card).toContain('import { getJson, postJson } from "./api-helpers"');
    expect(card).toContain('import { useAsyncActions } from "./hooks/useAsyncActions"');
    expect(card).toContain(
      'import { useApiMutationRevision } from "./hooks/useApiMutationRevision"'
    );
    expect(card).toContain('import { getUserFacingErrorMessage } from "./user-facing-error"');
  });

  it("wires the exact purchase and sale endpoints the backend exposes", () => {
    expect(card).toContain("const purchasesPath = `/businesses/${props.businessId}/purchases`");
    expect(card).toContain("const salesPath = `/businesses/${props.businessId}/sales`");
    expect(card).toContain("postJson<PurchaseRecordSummary>(purchasesPath");
    expect(card).toContain("postJson<SaleRecordSummary>(salesPath");
    expect(card).toContain("getJson<PurchaseRecordSummary[]>(`${purchasesPath}/history`)");
    expect(card).toContain("getJson<SaleRecordSummary[]>(`${salesPath}/history`)");

    expect(routes).toContain('"/businesses/:businessId/purchases"');
    expect(routes).toContain('"/businesses/:businessId/purchases/history"');
    expect(routes).toContain('"/businesses/:businessId/sales"');
    expect(routes).toContain('"/businesses/:businessId/sales/history"');
  });

  it("imports the shipped PurchaseRecordSummary/SaleRecordSummary types instead of redefining them", () => {
    expect(card).toContain(
      'import type { PurchaseRecordSummary, SaleRecordSummary } from "@grogoni/shared-types"'
    );
  });

  it("is mounted permanently inside the suppliers ShellView (SupplierSurface), not a chat-invoked card", () => {
    expect(supplierSurface).toContain(
      'import PurchaseSaleRecordsCard from "./PurchaseSaleRecordsCard"'
    );
    expect(supplierSurface).toContain("<PurchaseSaleRecordsCard businessId={props.businessId} />");
    expect(supplierSurface).toContain("businessId: string;");
  });

  it("receives businessId from OwnerWorkspace's suppliers case, the only change made there", () => {
    expect(ownerWorkspace).toContain("<SupplierSurface\n          businessId={businessId}");
  });

  it("does not add any new chat/NLU capability wiring for purchases or sales", () => {
    const registry = readFileSync("apps/web/src/generated-surface-registry.tsx", "utf8");
    const chatRuntime = readFileSync("apps/web/src/hooks/useChatRuntimeState.ts", "utf8");
    expect(registry).not.toContain("PurchaseSaleRecordsCard");
    expect(chatRuntime).not.toContain("PurchaseSaleRecordsCard");
    expect(chatRuntime).not.toContain("purchase.record");
    expect(chatRuntime).not.toContain("sale.record");
  });
});
