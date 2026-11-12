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

  it("normalizes pasted phone numbers before approving a chat", async () => {
    native.installed = true;
    native.call.mockResolvedValue({ available: true });
    api.fetchFreshJson.mockResolvedValue(state);
    api.postJson.mockResolvedValue(state);
    await render();
    const input = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.startsWith("Contact number"))!
      .querySelector("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "+254 711 111 111");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
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
    expect(fieldset()).toContain(
      "Read access: this WhatsApp contact can see your whole business's sales history, for all customers, not only their own."
    );
    // The panel says plainly that reads are not limited to the asker's own records.
    expect(fieldset()).toContain(
      "Reading shows records for your whole business, for all customers, not only the records of the person asking."
    );
    expect(container.querySelector(".whatsapp-read-warning")).toBeNull();
    await act(async () => toolBox("Prepare new catalogue records").click());
    expect(container.querySelector(".whatsapp-read-warning")).toBeNull();
    await act(async () => toolBox("Read sales history").click());
    await act(async () => toolBox("Read business invoices").click());
    const warning = container.querySelector(".whatsapp-read-warning")!.textContent!;
    expect(warning).toContain("Warning:");
    expect(warning).toContain(
      "this WhatsApp contact will be able to see your whole business's sales history, for all customers"
    );
    expect(warning).toContain(
      "every invoice in your business, for all customers, with their names and amounts, not only their own"
    );
    expect(warning).toContain("without asking you first");
    expect(warning).toContain("This is your whole business's data, not just their own.");
  });

  it("names every group participant in the read warning for a group", async () => {
    await openPermissions(group);
    await act(async () => toolBox("Search catalogue and stock").click());
    const warning = container.querySelector(".whatsapp-read-warning")!.textContent!;
    expect(warning).toContain("everyone in this WhatsApp group will be able to see");
    expect(warning).toContain("your full catalogue, prices and stock levels");
    expect(container.querySelector("fieldset")!.textContent).toContain(
      "and every participant in this group"
    );
  });
});

describe("WhatsApp account controls", () => {
  const contact = "254711111111@s.whatsapp.net";
  const group = "123456789@g.us";
  const base = "/businesses/business-1/channels/whatsapp-linked";
  const connected = {
    ...state,
    scopes: [
      { chat: contact, conversationId: "conversation-1" },
      { chat: group, conversationId: "conversation-2" }
    ]
  };
  const chat = (overrides: Record<string, unknown> = {}) => ({
    chat: contact,
    group: false,
    optedOut: false,
    readReceipts: false,
    customer: { id: "guest-1", name: "whatsapp_linked customer 111111", linked: false },
    ...overrides
  });
  const accountWith = (chats: unknown[], ownerChange: unknown = null) => ({ ownerChange, chats });
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === text);
  function serve(account: unknown, connection: unknown = connected) {
    api.fetchFreshJson.mockImplementation(async (url: string) => {
      if (url === `${base}/account`) return account;
      if (url === "/businesses/business-1/customers")
        return [
          { id: "guest-1", name: "whatsapp_linked customer 111111", phone: null },
          { id: "customer-2", name: "Amina Wanjiru", phone: "254711111111" }
        ];
      return connection;
    });
  }

  it("tells the new owner WhatsApp was disconnected by the owner change, until dismissed", async () => {
    const notice =
      "WhatsApp was disconnected because the shop changed owner. Link WhatsApp again to keep receiving messages.";
    serve(accountWith([], { notice, detectedAt: "2026-11-09T00:00:00.000Z" }), {
      ...state,
      state: "DISCONNECTED"
    });
    api.postJson.mockResolvedValue(accountWith([]));
    await render();
    expect(container.querySelector(".whatsapp-owner-change")!.textContent).toContain(notice);
    expect(container.textContent).toContain("Their conversation history stays with them.");
    // The owner can link again right away.
    expect(button("Connect WhatsApp")).toBeDefined();
    await act(async () => button("Dismiss")!.click());
    expect(api.postJson).toHaveBeenCalledWith(`${base}/account/owner-change/acknowledge`, {});
    expect(container.querySelector(".whatsapp-owner-change")).toBeNull();
  });

  it("shows the notice in the compact startup indicator too", async () => {
    native.installed = true;
    native.call.mockResolvedValue({ available: true });
    serve(accountWith([], { notice: "", detectedAt: "2026-11-09T00:00:00.000Z" }), {
      ...state,
      state: "DISCONNECTED"
    });
    await render(true);
    expect(container.querySelector(".whatsapp-owner-change")!.textContent).toContain(
      "because the shop changed owner"
    );
  });

  it("links only the chosen existing customer and can unlink it", async () => {
    serve(accountWith([chat(), chat({ chat: group, group: true, customer: null })]));
    await render();
    expect(container.textContent).toContain("Customer record: whatsapp_linked customer 111111");
    // A group has no customer link control.
    expect(
      [...container.querySelectorAll("button")].filter(
        (item) => item.textContent === "Link to an existing customer"
      )
    ).toHaveLength(1);
    await act(async () => button("Link to an existing customer")!.click());
    const select = container.querySelector(".whatsapp-customer-link select") as HTMLSelectElement;
    // The current guest record is not offered; nothing is preselected or matched by name.
    expect([...select.options].map((option) => option.value)).toEqual(["", "customer-2"]);
    expect(select.value).toBe("");
    expect(button("Link customer")!.disabled).toBe(true);
    api.postJson.mockResolvedValueOnce(
      accountWith([chat({ customer: { id: "customer-2", name: "Amina Wanjiru", linked: true } })])
    );
    await act(async () => {
      select.value = "customer-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Link customer")!.click());
    expect(api.postJson).toHaveBeenLastCalledWith(`${base}/chats/customer`, {
      chat: contact,
      customerId: "customer-2"
    });
    expect(container.textContent).toContain("Customer record: Amina Wanjiru");
    expect(container.querySelector('[role="status"]')!.textContent).toBe(
      "WhatsApp contact linked to the customer record."
    );
    api.postJson.mockResolvedValueOnce(accountWith([chat()]));
    await act(async () => button("Unlink customer")!.click());
    expect(api.postJson).toHaveBeenLastCalledWith(`${base}/chats/customer`, {
      chat: contact,
      customerId: null
    });
    expect(button("Link to an existing customer")).toBeDefined();
  });

  it("turns read receipts on per chat and hides the control after STOP", async () => {
    serve(
      accountWith([chat(), chat({ chat: group, group: true, customer: null, optedOut: true })])
    );
    api.postJson.mockResolvedValueOnce(
      accountWith([
        chat({ readReceipts: true }),
        chat({ chat: group, group: true, optedOut: true })
      ])
    );
    await render();
    expect(container.textContent).toContain("Read receipts: off");
    expect(container.textContent).toContain("This contact sent STOP. No read receipts are sent.");
    expect(
      [...container.querySelectorAll("button")].filter(
        (item) => item.textContent === "Send read receipts"
      )
    ).toHaveLength(1);
    await act(async () => button("Send read receipts")!.click());
    expect(api.postJson).toHaveBeenLastCalledWith(`${base}/chats/read-receipts`, {
      chat: contact,
      enabled: true
    });
    expect(container.textContent).toContain("Read receipts: on");
    expect(button("Stop read receipts")).toBeDefined();
  });

  it("loads the controls of a chat as soon as it is approved", async () => {
    let chats: unknown[] = [];
    api.fetchFreshJson.mockImplementation(async (url: string) =>
      url === `${base}/account` ? accountWith(chats) : connected
    );
    await render();
    expect(container.querySelector(".whatsapp-chat-details")).toBeNull();
    chats = [chat()];
    api.postJson.mockResolvedValue(connected);
    const input = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.startsWith("Contact number"))!
      .querySelector("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "+254711111111");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Approve conversation")!.click());
    expect(container.querySelector(".whatsapp-chat-details")).not.toBeNull();
  });

  it("keeps the connection usable when the account view is unavailable", async () => {
    api.fetchFreshJson.mockImplementation(async (url: string) => {
      if (url === `${base}/account`) throw new Error("404");
      return connected;
    });
    await render();
    expect(container.textContent).toContain("WhatsApp · Connected");
    expect(container.querySelector(".whatsapp-chat-details")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("WhatsApp on this phone (Android app)", () => {
  const deviceStatus = {
    enabled: true,
    host: null,
    status: "unavailable",
    waiting: 0,
    uncertain: 0
  };
  const local = (overrides: Record<string, unknown> = {}) => ({
    available: true,
    enabled: false,
    running: false,
    node: "",
    blockedReason: "not_enabled",
    connection: null,
    ...overrides
  });
  function serve(server: unknown, device: unknown = deviceStatus) {
    api.fetchFreshJson.mockImplementation(async (url: string) => {
      if (url.endsWith("/device/status")) {
        if (device instanceof Error) throw device;
        return device;
      }
      if (url.endsWith("/account")) return { ownerChange: null, chats: [] };
      return server;
    });
  }
  function nativeStatus(status: () => unknown, failing?: string) {
    native.call.mockImplementation(async (method: string) => {
      if (method === "whatsappAvailability") return { available: true };
      if (method === "whatsappLocalStatus") return status();
      if (method === failing) throw new Error("bridge failed");
      return {};
    });
  }
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);
  const setValue = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("offers to run WhatsApp on the phone on a host without server sessions, after consent", async () => {
    native.installed = true;
    nativeStatus(() => local());
    serve({ ...state, enabled: false });
    await render();
    expect(container.textContent).toContain("WhatsApp on this phone");
    expect(container.textContent).not.toContain("Advanced conversation approvals");
    const run = button("Run WhatsApp on this phone")!;
    expect(run.disabled).toBe(true);
    const consent = container.querySelector<HTMLInputElement>(
      'section[aria-label="WhatsApp on this phone"] input[type="checkbox"]'
    )!;
    await act(async () => consent.click());
    expect(run.disabled).toBe(false);
    await act(async () => run.click());
    expect(native.call).toHaveBeenCalledWith(
      "whatsappLocalEnable",
      { enabled: true },
      { timeoutMs: 45_000 }
    );
    expect(api.postJson).not.toHaveBeenCalled();
  });

  it("gets a pairing code from the phone's worker and shows it", async () => {
    native.installed = true;
    let current = local({ enabled: true, running: true, connection: { state: "DISCONNECTED" } });
    nativeStatus(() => current);
    serve({ ...state, enabled: false });
    await render();
    const get = button("Get pairing code")!;
    expect(get.disabled).toBe(true);
    await setValue(
      container.querySelector<HTMLInputElement>('input[type="tel"]')!,
      "+254 711 000 999"
    );
    expect(get.disabled).toBe(false);
    current = local({
      enabled: true,
      running: true,
      connection: { state: "PAIRING", pairingCode: "PHONE123" }
    });
    await act(async () => get.click());
    expect(native.call).toHaveBeenCalledWith(
      "whatsappLocalConnect",
      { businessId: "business-1", phone: "254711000999" },
      { timeoutMs: 100_000 }
    );
    expect(container.textContent).toContain("PHONE123");
    expect(container.textContent).toContain("Waiting for you to approve the code in WhatsApp");
  });

  it("approves chats, shows waiting and uncertain replies, and unlinks", async () => {
    native.installed = true;
    nativeStatus(() =>
      local({
        enabled: true,
        running: true,
        connection: {
          state: "CONNECTED",
          scopes: [{ chat: "254711000555@s.whatsapp.net", conversationId: "c1" }]
        }
      })
    );
    serve(
      { ...state, enabled: false },
      { ...deviceStatus, host: "android", status: "available", waiting: 2, uncertain: 1 }
    );
    await render();
    expect(container.textContent).toContain("Connected on this phone");
    expect(container.textContent).toContain("2 replies are waiting to be sent from this phone.");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "1 reply may not have reached WhatsApp"
    );
    const input = container.querySelector<HTMLInputElement>('input[placeholder="+254…"]')!;
    await setValue(input, "+254 711 222 333");
    await act(async () => button("Approve conversation")!.click());
    expect(native.call).toHaveBeenCalledWith(
      "whatsappLocalApprove",
      { businessId: "business-1", chat: "254711222333@s.whatsapp.net" },
      { timeoutMs: 45_000 }
    );
    await act(async () => button("Remove approval")!.click());
    expect(native.call).toHaveBeenCalledWith(
      "whatsappLocalRevoke",
      { businessId: "business-1", chat: "254711000555@s.whatsapp.net" },
      { timeoutMs: 45_000 }
    );
    await act(async () => button("Unlink WhatsApp from this phone")!.click());
    expect(native.call).toHaveBeenCalledWith(
      "whatsappLocalDisconnect",
      { businessId: "business-1" },
      { timeoutMs: 45_000 }
    );
    expect(container.textContent).toContain(
      "WhatsApp unlinked and its keys erased from this phone."
    );
  });

  it("shows bridge errors and keeps the controls", async () => {
    native.installed = true;
    nativeStatus(
      () => local({ enabled: true, running: true, connection: { state: "CONNECTED", scopes: [] } }),
      "whatsappLocalDisconnect"
    );
    serve({ ...state, enabled: false }, { ...deviceStatus, host: "android", status: "available" });
    await render();
    await act(async () => button("Unlink WhatsApp from this phone")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection failed");
    expect(button("Stop running on this phone")).toBeDefined();
  });

  it("explains phones that cannot run it, and stays hidden where the host refuses phones", async () => {
    native.installed = true;
    nativeStatus(() => local({ available: false, blockedReason: "abi_unsupported" }));
    serve({ ...state, enabled: false });
    await render();
    expect(container.textContent).toContain(
      "This phone's processor cannot run the WhatsApp worker"
    );
    expect(button("Run WhatsApp on this phone")).toBeUndefined();
    await act(async () => root?.unmount());
    container.remove();
    nativeStatus(() => local());
    serve({ ...state, enabled: false }, new Error("404 whatsapp_device_worker_disabled"));
    await render();
    expect(container.textContent).not.toContain("WhatsApp on this phone");
  });

  it("does not offer a second session while the server hosts one, and never runs outside the app", async () => {
    native.installed = true;
    nativeStatus(() => local());
    serve(state);
    await render();
    expect(container.textContent).toContain("already linked on the Grogoni server");
    expect(button("Run WhatsApp on this phone")).toBeUndefined();
    expect(container.textContent).toContain("Advanced conversation approvals");
    await act(async () => root?.unmount());
    container.remove();
    native.installed = false;
    native.call.mockClear();
    serve({ ...state, enabled: false });
    await render();
    expect(native.call).not.toHaveBeenCalledWith("whatsappLocalStatus", expect.anything());
    expect(container.textContent).not.toContain("WhatsApp on this phone");
  });
});
