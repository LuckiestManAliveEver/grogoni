// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../apps/web/src/api-helpers", () => ({ fetchFreshJson: mocks.get, postJson: mocks.post }));
import MessagingConnectionsPanel from "../apps/web/src/MessagingConnectionsPanel";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("business messaging connection setup", () => {
  it("creates a customer-scoped verification link without sending and leaves unavailable OAuth disabled", async () => {
    mocks.get.mockImplementation(async (path: string) =>
      path.endsWith("/channels/readiness")
        ? { providers: [{ provider: "telegram", configured: true, authorized: true }] }
        : path.endsWith("/mailboxes/providers")
          ? { providers: [{ provider: "gmail", displayName: "Gmail", configured: false }] }
          : [{ id: "customer-1", name: "Customer One" }]
    );
    mocks.post.mockResolvedValue({
      linkUrl: "https://t.me/fixture_bot?start=one-time",
      token: "one-time",
      expiresAt: new Date(Date.now() + 900_000).toISOString()
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(createElement(MessagingConnectionsPanel, { businessId: "shop-1" }))
      );
      const customer = container.querySelector("select")!;
      await act(async () => {
        customer.value = "customer-1";
        customer.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const connect = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Create customer verification link"
      )!;
      await act(async () => connect.click());
      expect(mocks.post).toHaveBeenCalledTimes(1);
      expect(mocks.post).toHaveBeenCalledWith(
        "/businesses/shop-1/customers/customer-1/channel-link-grants",
        { provider: "telegram" }
      );
      expect([...container.querySelectorAll("input")].map((input) => input.value)).toContain(
        "link one-time"
      );
      expect(container.textContent).toContain("They must send the message from their own account");
      const gmail = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Connect Gmail"
      )!;
      expect(gmail.disabled).toBe(true);
      expect(
        mocks.post.mock.calls.some(([path]) => String(path).includes("channel-messages"))
      ).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
