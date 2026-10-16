// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PurchaseOrderPanel from "../apps/web/src/PurchaseOrderPanel";
import type { PurchaseOrderReview } from "../packages/shared-types/src/purchase-orders";

const api = vi.hoisted(() => ({ fetchFreshJson: vi.fn(), postJson: vi.fn() }));
vi.mock("../apps/web/src/api-helpers", () => api);
describe("purchase order exact review", () => {
  let host: HTMLDivElement;
  let root: Root;
  let data: PurchaseOrderReview;
  let proposed: Record<string, unknown>;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    data = {
      recipients: [{ supplierId: "supplier", businessId: "receiver", name: "Supplier" }],
      emailMailboxIds: [],
      drafts: [
        {
          id: "draft",
          businessId: "business",
          supplierId: "supplier",
          currency: "KES",
          totalMinor: 12000,
          digest: "a".repeat(64),
          items: [{ productId: "Beans", quantityMilli: 2000, totalMinor: 12000, unit: "kg" }]
        }
      ],
      incoming: [],
      outgoing: [],
      whatsappAvailable: false
    };
    api.fetchFreshJson.mockImplementation(async (path: string) =>
      path.endsWith("/mailboxes") ? { mailboxes: [] } : structuredClone(data)
    );
    api.postJson.mockImplementation(async (_path: string, body: Record<string, unknown>) => {
      const message = String(body.message);
      const separator = message.indexOf(" ");
      proposed = JSON.parse(message.slice(separator + 1));
      return {
        session: { id: "runtime", businessId: "business" },
        turn: {
          status: "needs_confirmation",
          plan: {
            toolName: message.slice(1, separator),
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
  async function render(businessId = "business") {
    await act(async () =>
      root.render(
        <PurchaseOrderPanel
          key={businessId}
          businessId={businessId}
          suppliers={[
            {
              id: "supplier",
              name: "Supplier",
              email: "supplier@example.test",
              phone: "+254700000001"
            }
          ]}
        />
      )
    );
  }
  async function fill(label: string, value: string) {
    const element = [...host.querySelectorAll("label")].find((item) => item.textContent === label)!;
    const control = document.getElementById(element.htmlFor) as
      HTMLInputElement | HTMLSelectElement;
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
    await fill("Prepared draft", "draft");
    await fill("Linked supplier business ID", "receiver");
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    );
  }
  async function click(text: string) {
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent === text)!;
    expect(button).toBeTruthy();
    await act(async () => button.click());
  }

  it("shows unavailable external channels and reviews exact draft, channel and recipient before confirmation", async () => {
    await render();
    expect(
      [...host.querySelectorAll("option")]
        .filter((option) => ["email", "whatsapp"].includes(option.value))
        .every((option) => option.disabled)
    ).toBe(true);
    await prepare();
    expect(proposed).toEqual({
      draftId: "draft",
      draftDigest: "a".repeat(64),
      channel: "grogoni",
      recipient: "receiver"
    });
    expect(api.postJson).toHaveBeenCalledTimes(1);
    expect(
      host.querySelector('[aria-label="Review purchase order approval"]')?.textContent
    ).toContain("receiver");
    expect(host.textContent).toContain("120.00");
  });
  it("rejects approval without sending a confirmation turn", async () => {
    await render();
    await prepare();
    api.postJson.mockResolvedValueOnce({ status: "REJECTED" });
    await click("Reject approval");
    expect(api.postJson).toHaveBeenLastCalledWith(
      expect.stringContaining("/runtime/approvals/reject"),
      { runtimeSessionId: "runtime", confirmationToken: "token" }
    );
    expect(host.querySelector('[aria-label="Review purchase order approval"]')).toBeNull();
  });
  it("refuses a changed recipient in the server's proposed approval", async () => {
    await render();
    api.postJson.mockResolvedValueOnce({
      session: { id: "runtime", businessId: "business" },
      turn: {
        status: "needs_confirmation",
        plan: {
          toolName: "procurement.submit",
          input: {
            draftId: "draft",
            draftDigest: "a".repeat(64),
            channel: "grogoni",
            recipient: "attacker"
          },
          confirmationToken: "token"
        }
      }
    });
    await prepare();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("exact order");
    expect(host.querySelector('[aria-label="Review purchase order approval"]')).toBeNull();
  });
  it("does not report a completed turn as a verified committed submission", async () => {
    await render();
    await prepare();
    api.postJson.mockResolvedValueOnce({ turn: { status: "completed" } });
    await click("Approve");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("committed order result");
    expect(api.fetchFreshJson).toHaveBeenLastCalledWith(
      expect.stringContaining("/runtime/procurement/orders")
    );
  });
  it("clears old approvals when changing businesses", async () => {
    await render();
    await prepare();
    await render("other-business");
    expect(host.querySelector('[aria-label="Review purchase order approval"]')).toBeNull();
    expect(api.postJson).toHaveBeenCalledTimes(1);
  });
  it("shows supplier acceptance separately from uncertain external delivery", async () => {
    data.outgoing = [
      {
        order_id: "unknown-order",
        business_id: "business",
        draft_id: "draft",
        channel: "email",
        recipient: "supplier@example.test",
        revision: 1,
        status: "DELIVERY_UNKNOWN",
        snapshot: data.drafts[0]!
      }
    ];
    data.incoming = [
      {
        order_id: "incoming-order",
        business_id: "buyer",
        channel: "grogoni",
        revision: 0,
        status: "SUBMITTED_IN_APP",
        snapshot: data.drafts[0]!
      }
    ];
    await render();
    expect(host.textContent).toContain("Delivery unknown; do not resend");
    await click("Review acceptance");
    expect(proposed).toEqual({ orderId: "incoming-order", revision: 0, decision: "ACCEPTED" });
  });
});
