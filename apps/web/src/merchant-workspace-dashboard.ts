import type { InvoiceSummary, ProductSummary } from "./grogoni-application-shared";

/**
 * Pure, deterministic data shaping for the merchant workspace dashboard (audit A27, docs/audits/
 * grogoni-home-2026-09-17/audit.md). The reference's single-screen dashboard ("Orders today",
 * "Revenue today", "Pending", recent orders, catalogue) has no backend equivalent that is already
 * scoped to "today" - only all-time aggregates (BusinessReportSummary) exist. Rather than add a
 * new backend aggregation for a single UI screen, this derives "today" client-side from the real
 * per-invoice timestamps the app already fetches, so every number here is real, just computed
 * differently than the all-time report.
 */

export function isSameLocalDay(isoTimestamp: string, reference: Date): boolean {
  return new Date(isoTimestamp).toDateString() === reference.toDateString();
}

export function ordersToday(invoices: InvoiceSummary[], now: Date = new Date()): number {
  return invoices.filter((invoice) => isSameLocalDay(invoice.createdAt, now)).length;
}

/** Only confirmed invoices count as revenue - a draft is not yet a sale. */
export function revenueToday(invoices: InvoiceSummary[], now: Date = new Date()): number {
  return invoices
    .filter(
      (invoice) =>
        invoice.status === "confirmed" &&
        isSameLocalDay(invoice.confirmedAt ?? invoice.createdAt, now)
    )
    .reduce((total, invoice) => total + invoice.total, 0);
}

/** "Pending" here means not yet confirmed - the one order state this app's InvoiceStatus
 * ("draft" | "confirmed") can actually distinguish, without needing separate payment-status data
 * the dashboard doesn't otherwise fetch. */
export function pendingOrderCount(invoices: InvoiceSummary[]): number {
  return invoices.filter((invoice) => invoice.status === "draft").length;
}

export interface RecentOrderRow {
  id: string;
  invoiceNumber: string;
  customerName: string;
  itemSummary: string;
  total: number;
}

export function recentOrders(invoices: InvoiceSummary[], limit = 3): RecentOrderRow[] {
  return [...invoices]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)
    .map((invoice) => ({
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      customerName: invoice.customerName ?? "Guest customer",
      itemSummary: summarizeInvoiceItems(invoice.items),
      total: invoice.total
    }));
}

function summarizeInvoiceItems(items: InvoiceSummary["items"]): string {
  if (items.length === 0) return "No items";
  const [first, ...rest] = items;
  const firstText = `${first!.quantity}${first!.productName ? ` ${first!.productName}` : ""}`;
  return rest.length === 0 ? firstText : `${firstText} +${rest.length} more`;
}

export type CatalogueStockStatus = "out-of-stock" | "low-stock" | "available";

export function catalogueStockStatus(quantity: number): CatalogueStockStatus {
  if (quantity <= 0) return "out-of-stock";
  // Matches the real threshold services/api/src/cp2/store.ts uses for
  // InventoryReportSummary.lowStockCount - not an arbitrary client-side number.
  if (quantity <= 2) return "low-stock";
  return "available";
}

export function catalogueStockLabel(quantity: number): string {
  const status = catalogueStockStatus(quantity);
  if (status === "out-of-stock") return "Out of stock";
  if (status === "low-stock") return `Low stock — ${quantity} left`;
  return "Available";
}

const stockUrgency: Record<CatalogueStockStatus, number> = {
  "out-of-stock": 0,
  "low-stock": 1,
  available: 2
};

/** Surfaces the products most worth a merchant's attention first (out of stock, then low stock),
 * rather than an arbitrary or purely chronological slice. */
export function catalogueForDashboard(products: ProductSummary[], limit = 3): ProductSummary[] {
  return [...products]
    .sort(
      (a, b) =>
        stockUrgency[catalogueStockStatus(a.quantity)] -
        stockUrgency[catalogueStockStatus(b.quantity)]
    )
    .slice(0, limit);
}
