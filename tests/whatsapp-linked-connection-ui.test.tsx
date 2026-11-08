// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import WhatsAppLinkedConnection from "../apps/web/src/WhatsAppLinkedConnection";
const native = vi.hoisted(() => ({ installed: false, call: vi.fn() }));
const api = vi.hoisted(() => ({ fetchFreshJson: vi.fn(), postJson: vi.fn(), deleteJson: vi.fn() }));
vi.mock("../apps/web/src/api-helpers", () => api);
vi.mock("../apps/web/src/device-messaging", () => ({
  isNativeDeviceHost: () => native.installed,
  deviceMessagingAdapter: { call: native.call }
}));
vi.mock("../apps/web/src/user-facing-error", () => ({
  getUserFacingErrorMessage: () => "Connection failed"
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement;
const state = { enabled: true, state: "CONNECTED", pairingCode: null, expiresAt: null, scopes: [] };
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.useRealTimers();
  vi.resetAllMocks();
  native.installed = false;
});
async function render(startup = false) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<WhatsAppLinkedConnection businessId="business-1" startup={startup} />);
  });
}
describe("WhatsApp connection controls", () => {
  it("offers native startup connection without pairing until the owner acts", async () => {
    native.installed = true;
    native.call.mockResolvedValue({ available: true });
    api.fetchFreshJson.mockResolvedValue({ ...state, state: "DISCONNECTED" });
    await render(true);
    expect(native.call).toHaveBeenCalledWith("whatsappAvailability");
    expect(container.textContent).toContain("WhatsApp is available on this phone.");
    expect(container.querySelector('input[type="tel"]')).toBeNull();
    expect(api.postJson).not.toHaveBeenCalled();
    const connect = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect WhatsApp"
    )!;
    await act(async () => connect.click());
    expect(container.querySelector('input[type="tel"]')).not.toBeNull();
    expect(api.postJson).not.toHaveBeenCalled();
  });
  it("returns a newly approved native pairing to the compact conversation indicator", async () => {
    vi.useFakeTimers();
    native.installed = true;
    native.call.mockResolvedValue({ available: true });
    api.fetchFreshJson
      .mockResolvedValueOnce({ ...state, state: "PAIRING", pairingCode: "CODE1234" })
      .mockResolvedValue(state);
    await render(true);
    expect(container.textContent).toContain("CODE1234");
    await act(async () => vi.advanceTimersByTimeAsync(5001));
    expect(container.textContent).toContain("WhatsApp · Connected");
    expect(container.textContent).not.toContain("Advanced conversation approvals");
    expect(container.textContent).not.toContain("CODE1234");
  });
  it("uses only the explicitly selected native contact and requires a separate approval", async () => {
    native.installed = true;
    native.call.mockImplementation(async (method) =>
      method === "whatsappAvailability" ? { available: true } : { phone: "+254 711 111 111" }
    );
    api.fetchFreshJson.mockResolvedValue(state);
    api.postJson.mockResolvedValue(state);
    await render();
    const picker = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Choose a contact"
    )!;
    await act(async () => picker.click());
    expect(api.postJson).not.toHaveBeenCalled();
    const approve = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve conversation"
    )!;
    await act(async () => approve.click());
    expect(api.postJson).toHaveBeenCalledWith(
      "/businesses/business-1/channels/whatsapp-linked/scopes",
      { chat: "254711111111@s.whatsapp.net", approved: true, automation: false }
    );
  });
  it("uses authenticated DELETE and clears connection controls after credential deletion", async () => {
    api.fetchFreshJson.mockResolvedValue(state);
    api.deleteJson.mockResolvedValue({ ...state, state: "DISCONNECTED" });
    await render();
    const button = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Disconnect")
    )!;
    await act(async () => button.click());
    expect(api.deleteJson).toHaveBeenCalledWith("/businesses/business-1/channels/whatsapp-linked");
    expect(container.textContent).toContain("Disconnected");
    expect(container.textContent).toContain("Connect WhatsApp");
  });
  it("hides disabled controls and avoids perpetual status polling", async () => {
    vi.useFakeTimers();
    api.fetchFreshJson.mockResolvedValue({ ...state, enabled: false });
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(container.textContent).toBe("");
    expect(api.fetchFreshJson).toHaveBeenCalledTimes(1);
  });
  it("shows unavailable status and removes a stale code when refresh fails", async () => {
    vi.useFakeTimers();
    api.fetchFreshJson
      .mockResolvedValueOnce({ ...state, state: "PAIRING", pairingCode: "CODE1234" })
      .mockRejectedValue(new Error("offline"));
    await render();
    expect(container.textContent).toContain("CODE1234");
    await act(async () => vi.advanceTimersByTimeAsync(5001));
    expect(container.textContent).toContain("Connection status unavailable");
    expect(container.textContent).not.toContain("CODE1234");
  });
});

describe("WhatsApp business permission grants", () => {
  const contact = "254711111111@s.whatsapp.net";
  const group = "123456789@g.us";
  const choices = ["products.list", "product.create", "sales.history", "invoices.list"];
  const connected = (chat: string) => ({
    ...state,
    automationAvailable: true,
    scopes: [{ chat, conversationId: "conversation-1", automation: true }]
  });
  const buttons = () => [...container.querySelectorAll("button")];
  const button = (text: string) => buttons().find((item) => item.textContent === text);
  const toolBox = (label: string) =>
    [...container.querySelectorAll("fieldset label")]
      .find((item) => item.textContent?.startsWith(label))!
      .querySelector("input")!;
  const consentBox = () =>
    [...container.querySelectorAll("fieldset label")]
      .find((item) => item.textContent?.startsWith("I approve giving"))!
      .querySelector("input")!;
  async function openPermissions(chat = contact, granted: string[] = []) {
    api.fetchFreshJson.mockImplementation(async (url: string) =>
      url.endsWith("/tools")
        ? { choices, grants: [{ chat, grant: granted.length ? { tools: granted } : null }] }
        : connected(chat)
    );
    await render();
    await act(async () => button("Business permissions")!.click());
    expect(api.fetchFreshJson).toHaveBeenCalledWith(
      "/businesses/business-1/channels/whatsapp-linked/tools"
    );
  }

  it("requires explicit consent before granting and sends only the selected tools", async () => {
    api.postJson.mockResolvedValue({ id: "grant-1", enabled: true, tools: [] });
    await openPermissions();
    await act(async () => toolBox("Prepare new catalogue records").click());
    await act(async () => toolBox("Read sales history").click());
    const allow = button("Allow selected capabilities")!;
    expect(allow.disabled).toBe(true);
    await act(async () => allow.click());
    expect(api.postJson).not.toHaveBeenCalled();
    await act(async () => consentBox().click());
    expect(button("Allow selected capabilities")!.disabled).toBe(false);
    await act(async () => button("Allow selected capabilities")!.click());
    expect(api.postJson).toHaveBeenCalledTimes(1);
    expect(api.postJson).toHaveBeenCalledWith(
      "/businesses/business-1/channels/whatsapp-linked/tools",
      { chat: contact, tools: ["product.create", "sales.history"], consent: true }
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Business permissions saved."
    );
    expect(container.querySelector("fieldset")).toBeNull();
  });

  it("withdraws consent when the selection changes after approval", async () => {
    await openPermissions();
    await act(async () => toolBox("Prepare new catalogue records").click());
    await act(async () => consentBox().click());
    expect(button("Allow selected capabilities")!.disabled).toBe(false);
    await act(async () => toolBox("Read business invoices").click());
    expect(consentBox().checked).toBe(false);
    expect(button("Allow selected capabilities")!.disabled).toBe(true);
  });

  it("revokes every capability for the conversation", async () => {
    api.postJson.mockResolvedValue({ id: "grant-2", enabled: true, tools: [] });
    await openPermissions(contact, ["product.create", "sales.history"]);
    expect(toolBox("Prepare new catalogue records").checked).toBe(true);
    await act(async () => button("Remove all capabilities")!.click());
    expect(api.postJson).toHaveBeenCalledWith(
      "/businesses/business-1/channels/whatsapp-linked/tools",
      { chat: contact, tools: [], consent: true }
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Business permissions removed."
    );
  });

  it("offers no revoke button when nothing is granted", async () => {
    await openPermissions();
    expect(button("Remove all capabilities")).toBeUndefined();
  });

  it("shows the error and keeps the selection when saving fails", async () => {
    api.postJson.mockRejectedValue(new Error("403"));
    await openPermissions();
    await act(async () => toolBox("Prepare new catalogue records").click());
    await act(async () => consentBox().click());
    await act(async () => button("Allow selected capabilities")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection failed");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(toolBox("Prepare new catalogue records").checked).toBe(true);
  });

  it("shows the error when permissions cannot be loaded", async () => {
    api.fetchFreshJson.mockImplementation(async (url: string) => {
      if (url.endsWith("/tools")) throw new Error("offline");
      return connected(contact);
    });
    await render();
    await act(async () => button("Business permissions")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection failed");
    expect(container.querySelector("fieldset")).toBeNull();
  });

  it("warns that a read tool lets the contact see that data", async () => {
    await openPermissions();
    const fieldset = () => container.querySelector("fieldset")!.textContent!;
    // Each read capability states what it exposes, even before it is selected.
    expect(fieldset()).toContain("Read access: this WhatsApp contact can see your sales history.");
    expect(container.querySelector(".whatsapp-read-warning")).toBeNull();
    await act(async () => toolBox("Prepare new catalogue records").click());
    expect(container.querySelector(".whatsapp-read-warning")).toBeNull();
    await act(async () => toolBox("Read sales history").click());
    await act(async () => toolBox("Read business invoices").click());
    const warning = container.querySelector(".whatsapp-read-warning")!.textContent!;
    expect(warning).toContain("Warning:");
    expect(warning).toContain("this WhatsApp contact will be able to see your sales history");
    expect(warning).toContain("your invoices, including customer names and amounts");
    expect(warning).toContain("without asking you first");
  });

  it("names every group participant in the read warning for a group", async () => {
    await openPermissions(group);
    await act(async () => toolBox("Search catalogue and stock").click());
    const warning = container.querySelector(".whatsapp-read-warning")!.textContent!;
    expect(warning).toContain("everyone in this WhatsApp group will be able to see");
    expect(warning).toContain("your catalogue, prices and stock levels");
    expect(container.querySelector("fieldset")!.textContent).toContain(
      "and every participant in this group"
    );
  });
});
