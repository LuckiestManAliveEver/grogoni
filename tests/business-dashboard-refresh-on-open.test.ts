import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression coverage for audit A27/A28 ("Merchant workspace" / "Buyer-to-merchant update",
// docs/audits/grogoni-home-2026-09-17/audit.md): invoices' own refresh registration
// (useInvoicesState.ts's registerRefresh) only covers the dedicated pos/invoices/payments/
// logistics ShellViews, not the merchant workspace dashboard modal (which opens without changing
// the outer ShellView). Without an explicit refresh, a real order placed by a buyer elsewhere
// (now persisted correctly - see buy-checkout-real-message.test.tsx) would not show up in the
// dashboard until the merchant happened to visit one of those other views first.
const chatSurface = readFileSync("apps/web/src/ChatSurface.tsx", "utf8");
const contracts = readFileSync("apps/web/src/chat-surface-contracts.ts", "utf8");
const grogoniApplication = readFileSync("apps/web/src/GrogoniApplication.tsx", "utf8");

describe("merchant workspace dashboard refreshes invoices on open (audit A27/A28)", () => {
  it("declares onRefreshInvoices in the ChatSurface contract", () => {
    expect(contracts).toContain("onRefreshInvoices: () => void;");
  });

  it("calls onRefreshInvoices from a single shared open function, not ad hoc at each call site", () => {
    expect(chatSurface).toContain("function openBusinessDashboard() {");
    const fnStart = chatSurface.indexOf("function openBusinessDashboard() {");
    const fnBody = chatSurface.slice(fnStart, chatSurface.indexOf("}", fnStart));
    expect(fnBody).toContain('setWorkspaceCardView("businessDashboard")');
    expect(fnBody).toContain("onRefreshInvoices();");

    // The Shop Hub's "Today's dashboard" surface is the entry point; it routes through the shared
    // function instead of duplicating the open+refresh logic, and nothing else opens the view.
    const surfaceStart = chatSurface.indexOf("function openShopHubSurface(");
    expect(surfaceStart).toBeGreaterThan(-1);
    const surfaceBody = chatSurface.slice(
      surfaceStart,
      chatSurface.indexOf("\n  }\n", surfaceStart)
    );
    expect(surfaceBody).toMatch(
      /surface\.view === "businessDashboard"\) \{\s*openBusinessDashboard\(\);/u
    );
    expect(chatSurface.split('setWorkspaceCardView("businessDashboard")').length - 1).toBe(1);
  });

  it("wires onRefreshInvoices to the real loadInvoices for the current business, not a no-op", () => {
    const propStart = grogoniApplication.indexOf("onRefreshInvoices={() => {");
    expect(propStart).toBeGreaterThan(-1);
    const propBody = grogoniApplication.slice(
      propStart,
      grogoniApplication.indexOf("}}", propStart)
    );
    expect(propBody).toContain("business !== null");
    expect(propBody).toContain("loadInvoices(business.id)");
  });
});
