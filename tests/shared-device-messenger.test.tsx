// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DeviceMessagingPage from "../apps/web/src/DeviceMessagingPage";
import {
  deviceMessagingAdapter,
  type DeviceMessagingAdapter
} from "../apps/web/src/device-messaging";

const capabilities = {
  available: true,
  roleGranted: true,
  ready: true,
  subscriptionId: 1,
  syncEnabled: false,
  businessId: null,
  accountId: null
};
const message = (id: number, text = `Message ${id}`) => ({
  id,
  address: "+15551234567",
  body: text,
  date: 1_800_000_000_000 - id,
  type: 1,
  read: false
});
describe("shared carrier-message interface", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState(null, "", "/device-messages");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  const settle = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === text)!;
  function adapterWith(call: ReturnType<typeof vi.fn>): DeviceMessagingAdapter {
    return { call } as DeviceMessagingAdapter;
  }

  it("does not invent carrier capability in an ordinary browser", async () => {
    await act(async () => root.render(<DeviceMessagingPage adapter={deviceMessagingAdapter} />));
    expect(container.textContent).toContain("Your browser cannot read");
    expect(container.querySelector('a[href="/install"]')).not.toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("passes the SIM shown in the send confirmation to the native adapter", async () => {
    window.history.replaceState(null, "", "/device-messages?to=12345&body=STOP");
    const call = vi.fn(async (method: string) =>
      method === "capabilities" ? capabilities : { messages: [], pending: [], hasMore: false }
    );
    await act(async () => root.render(<DeviceMessagingPage adapter={adapterWith(call)} />));
    await act(async () => button("Send SMS via SIM").click());
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("SIM 1"));
    expect(call).toHaveBeenCalledWith(
      "sendSms",
      expect.objectContaining({ recipients: ["12345"], text: "STOP", subscriptionId: 1 })
    );
  });

  it("reads through the device adapter and never uploads an incoming message automatically", async () => {
    const call = vi.fn(async (method: string) =>
      method === "capabilities"
        ? capabilities
        : { messages: [message(1, "Private OTP 123456")], pending: [], hasMore: false }
    );
    await act(async () => root.render(<DeviceMessagingPage adapter={adapterWith(call)} />));
    expect(container.textContent).toContain("Private OTP 123456");
    // Reading checklist state and the on-device phonebook are the only extra calls; nothing is uploaded.
    expect(call.mock.calls.map(([method]) => method).sort()).toEqual([
      "capabilities",
      "listContacts",
      "listSms",
      "permissionChecklist"
    ]);
    await act(async () => container.querySelector<HTMLButtonElement>(".device-message")!.click());
    expect(call).toHaveBeenCalledWith("markRead", { id: 1 });
    vi.mocked(window.confirm).mockReturnValue(false);
    await act(async () => button("Share with business").click());
    expect(call.mock.calls.some(([method]) => method === "shareSms")).toBe(false);
    vi.mocked(window.confirm).mockReturnValue(true);
    await act(async () => button("Share with business").click());
    expect(call).toHaveBeenCalledWith("shareSms", { id: 1 });
  });

  it("reaches older history and preserves it when refreshing the first page", async () => {
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "capabilities") return capabilities;
      return {
        messages: params?.before
          ? [message(101, "Older message")]
          : Array.from({ length: 100 }, (_, index) => message(index + 1)),
        pending: [],
        hasMore: !params?.before
      };
    });
    await act(async () => root.render(<DeviceMessagingPage adapter={adapterWith(call)} />));
    await act(async () => button("Load older messages").click());
    expect(container.querySelectorAll(".device-message")).toHaveLength(101);
    await act(async () => button("Refresh messages").click());
    expect(container.textContent).toContain("Older message");
    expect(container.querySelectorAll(".device-message")).toHaveLength(101);
  });

  it("requires confirmation before asking Android to download an MMS", async () => {
    window.history.replaceState(null, "", "/device-messages?channel=mms");
    const call = vi.fn(async (method: string) =>
      method === "capabilities"
        ? capabilities
        : {
            messages: [
              {
                id: 9,
                date: 1_800_000_000_000,
                type: 130,
                box: 1,
                subscriptionId: 2,
                addresses: ["+15551234567"]
              }
            ],
            hasMore: false
          }
    );
    await act(async () => root.render(<DeviceMessagingPage adapter={adapterWith(call)} />));
    vi.mocked(window.confirm).mockReturnValue(false);
    await act(async () => container.querySelector<HTMLButtonElement>(".device-message")!.click());
    expect(call.mock.calls.some(([method]) => method === "downloadMms")).toBe(false);
    vi.mocked(window.confirm).mockReturnValue(true);
    await act(async () => container.querySelector<HTMLButtonElement>(".device-message")!.click());
    expect(call).toHaveBeenCalledWith("downloadMms", { id: 9, subscriptionId: 2 });
    await settle();
  });
});
