import type { InvoiceSummary, ProductSummary } from "./grogoni-application-shared";
import { formatMoney } from "./formatters";
import {
  catalogueForDashboard,
  catalogueStockLabel,
  catalogueStockStatus,
  ordersToday,
  pendingOrderCount,
  recentOrders,
  revenueToday
} from "./merchant-workspace-dashboard";

export interface MerchantWorkspaceDashboardProps {
  businessName: string;
  invoices: InvoiceSummary[];
  products: ProductSummary[];
  onBack: () => void;
  onOpenInvoices: () => void;
  onOpenCatalogue: () => void;
}

/**
 * Audit A27 ("Merchant workspace"): the reference is a single screen combining today's
 * operational numbers, recent orders, and catalogue - production's workspace is a modal hub of
 * 18 separate cards with no combined view. This adds that combined view as one more entry point
 * alongside the existing hub (see ContextualBusinessCards' "Business workspace" card), not a
 * replacement for it - every other card and the all-time ReportsSurface stay reachable exactly as
 * before.
 */
export function MerchantWorkspaceDashboard({
  businessName,
  invoices,
  products,
  onBack,
  onOpenInvoices,
  onOpenCatalogue
}: MerchantWorkspaceDashboardProps) {
  const now = new Date();
  const orders = ordersToday(invoices, now);
  const revenue = revenueToday(invoices, now);
  const pending = pendingOrderCount(invoices);
  const recent = recentOrders(invoices);
  const catalogue = catalogueForDashboard(products);

  return (
    <div className="merchant-dashboard">
      <button type="button" className="merchant-dashboard-back" onClick={onBack} aria-label="Back">
        <span aria-hidden="true">←</span>
      </button>
      <header className="merchant-dashboard-heading">
        <h2>{businessName}</h2>
        <p>Business workspace</p>
      </header>

      <div className="merchant-dashboard-stats" aria-label="Today's activity">
        <div className="merchant-dashboard-stat">
          <strong>{orders}</strong>
          <span>Orders today</span>
        </div>
        <div className="merchant-dashboard-stat">
          <strong>{formatMoney(revenue)}</strong>
          <span>Revenue today</span>
        </div>
        <div className="merchant-dashboard-stat">
          <strong>{pending}</strong>
          <span>Pending</span>
        </div>
      </div>

      <section className="merchant-dashboard-section" aria-label="Recent orders">
        <div className="merchant-dashboard-section-heading">
          <h3>Recent orders</h3>
          <button type="button" onClick={onOpenInvoices}>
            See all
          </button>
        </div>
        {recent.length === 0 ? (
          <p className="merchant-dashboard-empty">No orders yet.</p>
        ) : (
          <ul className="merchant-dashboard-list">
            {recent.map((order) => (
              <li key={order.id}>
                <div>
                  <strong>{order.invoiceNumber}</strong>
                  <span>
                    {order.customerName} · {order.itemSummary}
                  </span>
                </div>
                <strong>{formatMoney(order.total)}</strong>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="merchant-dashboard-section" aria-label="Catalogue">
        <div className="merchant-dashboard-section-heading">
          <h3>Catalogue</h3>
          <button type="button" onClick={onOpenCatalogue}>
            See all
          </button>
        </div>
        {catalogue.length === 0 ? (
          <p className="merchant-dashboard-empty">No products yet.</p>
        ) : (
          <ul className="merchant-dashboard-list">
            {catalogue.map((product) => (
              <li key={product.id}>
                <div>
                  <strong>
                    {product.name}, {product.unit}
                  </strong>
                  <span
                    data-stock-status={catalogueStockStatus(product.quantity)}
                    className="merchant-dashboard-stock"
                  >
                    {catalogueStockLabel(product.quantity)}
                  </span>
                </div>
                <strong>
                  {product.sellingPrice === null
                    ? "No price set"
                    : formatMoney(product.sellingPrice)}
                </strong>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
