// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SupplierOfferPanel from "../apps/web/src/SupplierOfferPanel";
import { parseOfferFixed } from "../apps/web/src/supplier-offer-values";

const api = vi.hoisted(() => ({ fetchFreshJson: vi.fn(), postJson: vi.fn() }));
vi.mock("../apps/web/src/api-helpers", () => api);
describe("exact supplier offer review", () => {
  let host: HTMLDivElement;
  let root: Root;
  let proposed: Record<string, unknown>;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    proposed = {};
    api.fetchFreshJson.mockImplementation(async (path: string) =>
      path.endsWith("/products")
        ? [{ id: "rice", businessId: "business", name: "Rice", unit: "kg" }]
        : { offers: [], truncated: false }
    );
    api.postJson.mockImplementation(async (_path: string, body: Record<string, unknown>) => {
      proposed = JSON.parse(String(body.message).slice("#procurement.quote.record ".length));
      return {
        session: { id: "runtime", businessId: "business" },
        turn: {
          status: "needs_confirmation",
          plan: {
            toolName: "procurement.quote.record",
            input: proposed,
            confirmationToken: "token"
          }
        }
      };
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  async function render() {
    await act(async () => {
      root.render(
        <SupplierOfferPanel
          businessId="business"
          suppliers={[{ id: "supplier", name: "Jane Wholesale" }]}
        />
      );
    });
  }
  async function fill(label: string, value: string) {
    const wrapper = [...host.querySelectorAll("label")].find((item) =>
      item.textContent?.startsWith(label)
    );
    const control = wrapper?.querySelector("input, select") as HTMLInputElement | HTMLSelectElement;
    expect(control).toBeTruthy();
    await act(async () => {
      const prototype =
        control.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
      control.dispatchEvent(
        new Event(control.tagName === "SELECT" ? "change" : "input", { bubbles: true })
      );
    });
  }
  async function prepare() {
    await render();
    await fill("Product", "rice");
    await fill("Supplier", "supplier");
    await fill("Unit price", "120.50");
    await fill("Available quantity", "25.125");
    await fill("Lead time", "1");
    await fill("Offer expires", "2099-10-15T12:00");
    await act(async () => {
      host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click();
    });
    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }
  async function click(label: string) {
    await act(async () => {
      [...host.querySelectorAll("button")].find((button) => button.textContent === label)!.click();
    });
  }
  it("uses canonical JSON capability input and freezes the exact reviewed values", async () => {
    await prepare();
    expect(proposed).toMatchObject({
      productId: "rice",
      supplierId: "supplier",
      unit: "kg",
      currency: "KES",
      unitPriceMinor: 12050,
      availableQuantityMilli: 25125,
      minQuantityMilli: 1000,
      incrementMilli: 1000,
      priceIncludesCharges: true
    });
    expect(host.querySelector("fieldset")!.disabled).toBe(true);
    expect(host.textContent).toContain("Confirm supplier offer");
    expect(host.textContent).toContain("Jane Wholesale");
  });
  it("rejects through the durable exact-scope endpoint before clearing review", async () => {
    await prepare();
    api.postJson.mockResolvedValueOnce({ status: "REJECTED" });
    await click("Reject");
    expect(api.postJson).toHaveBeenLastCalledWith("/businesses/business/runtime/approvals/reject", {
      runtimeSessionId: "runtime",
      confirmationToken: "token"
    });
    expect(host.textContent).toContain("Offer rejected");
    expect(host.querySelector("fieldset")!.disabled).toBe(false);
  });
  it("does not call an unverified completed response a recorded offer", async () => {
    await prepare();
    api.postJson.mockResolvedValueOnce({ turn: { status: "completed" } });
    await click("Confirm offer");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Supplier offer recorded");
  });
  it("reports recording only after matching independently read committed values", async () => {
    await prepare();
    api.postJson.mockResolvedValueOnce({ turn: { status: "completed" } });
    api.fetchFreshJson.mockResolvedValueOnce({
      offers: [{ ...proposed, productName: "Rice", supplierName: "Jane Wholesale" }],
      truncated: false
    });
    await click("Confirm offer");
    expect(host.textContent).toContain("Supplier offer recorded");
    expect(host.textContent).toContain("No purchase order was submitted");
  });
  it("rejects argument substitution before exposing confirmation", async () => {
    api.postJson.mockImplementationOnce(async (_path: string, body: Record<string, unknown>) => {
      const quote = JSON.parse(String(body.message).slice("#procurement.quote.record ".length));
      return {
        session: { id: "runtime", businessId: "business" },
        turn: {
          status: "needs_confirmation",
          plan: {
            toolName: "procurement.quote.record",
            input: { ...quote, unitPriceMinor: 1 },
            confirmationToken: "token"
          }
        }
      };
    });
    await prepare();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Confirm supplier offer");
  });
  it("converts decimal inputs exactly without exponent or excess precision", () => {
    expect(parseOfferFixed("0.01", 2, "Price")).toBe(1);
    expect(parseOfferFixed("2.125", 3, "Quantity")).toBe(2125);
    for (const value of ["1e3", "-1", "1.001", "", "9007199254740992"])
      expect(() => parseOfferFixed(value, 2, "Price")).toThrow();
  });
});
