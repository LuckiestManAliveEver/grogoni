// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postJson = vi.fn();
const getJson = vi.fn();
const fetchFreshJson = vi.fn();

vi.mock("../apps/web/src/api-helpers", () => ({
  postJson: (...args: unknown[]) => postJson(...args),
  getJson: (...args: unknown[]) => getJson(...args),
  fetchFreshJson: (...args: unknown[]) => fetchFreshJson(...args),
  deleteJson: vi.fn()
}));

const { useNetworkState } = await import("../apps/web/src/hooks/useNetworkState");
const { readDevicePhonebook } = await import("../apps/web/src/phonebook-device-cache");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Hook = ReturnType<typeof useNetworkState>;
let container: HTMLDivElement;
let root: Root;
let hook: Hook;
const resets: Array<() => void> = [];
const setStatusMessage = vi.fn();

function Probe(props: { business: { id: string } | null }) {
  hook = useNetworkState({
    business: props.business as never,
    getCustomers: () => [],
    loadCustomers: async () => undefined,
    setStatusMessage,
    registerReset: (_key, fn) => resets.push(fn),
    registerRefresh: () => undefined
  });
  return null;
}

beforeEach(() => {
  localStorage.clear();
  postJson.mockReset();
  getJson.mockReset();
  fetchFreshJson.mockReset();
  setStatusMessage.mockReset();
  resets.length = 0;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("useNetworkState phonebook", () => {
  it("pairs picked contacts with their synced nodes on the device, and forgets them on logout", async () => {
    act(() => root.render(<Probe business={{ id: "shop" }} />));
    postJson.mockResolvedValue({
      ownerUserId: "owner",
      generatedAt: "2026-09-26T00:00:00.000Z",
      nodes: [],
      edges: [],
      sources: [],
      routes: [],
      syncedContactNodeIds: ["n-1", "n-2"]
    });

    await act(async () => {
      await hook.syncSelectedNetworkPhoneContacts([
        { name: ["Wanjiru"], tel: ["0722 000 101", "0733 000 202"] },
        { name: ["Otieno"], email: ["o@example.com"] }
      ]);
    });

    expect(postJson).toHaveBeenCalledWith("/network/sync/contacts", {
      sourceName: "Phone Contacts",
      mode: "merge",
      defaultCountry: expect.stringMatching(/^[A-Z]{2}$/),
      contacts: [
        expect.objectContaining({ name: "Wanjiru", phones: ["0722 000 101", "0733 000 202"] }),
        expect.objectContaining({ name: "Otieno", emails: ["o@example.com"] })
      ]
    });
    expect(readDevicePhonebook("owner")).toEqual([
      { name: "Wanjiru", phone: "0722 000 101", email: null, nodeId: "n-1" },
      { name: "Otieno", phone: null, email: "o@example.com", nodeId: "n-2" }
    ]);
    expect(hook.devicePhonebook).toHaveLength(2);

    act(() => resets.forEach((reset) => reset()));
    expect(readDevicePhonebook("owner")).toEqual([]);
  });

  it("offers the share sheet instead of sending invites when there is no shop", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, share });
    act(() => root.render(<Probe business={null} />));

    let outcome: Awaited<ReturnType<Hook["inviteNetworkContacts"]>> | undefined;
    await act(async () => {
      outcome = await hook.inviteNetworkContacts([
        { name: "Frank", phone: "0722000101", email: null }
      ]);
    });

    expect(outcome).toEqual({ invited: 0, alreadyOnGrogoni: 0, invalid: 0, shared: true });
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ title: "Grogoni" }));
    expect(postJson).not.toHaveBeenCalled();

    // Cancelling the share sheet is not "shared".
    share.mockRejectedValueOnce(new DOMException("cancelled", "AbortError"));
    await act(async () => {
      outcome = await hook.inviteNetworkContacts([
        { name: "Frank", phone: "0722000101", email: null }
      ]);
    });
    expect(outcome?.shared).toBe(false);
  });

  it("forgets the device copy when the phonebook is disconnected, but not for other sources", async () => {
    const deleteJson = (await import("../apps/web/src/api-helpers")).deleteJson as ReturnType<
      typeof vi.fn
    >;
    const graph = (sources: Array<{ id: string; sourcePlatform: string }>) => ({
      ownerUserId: "owner",
      generatedAt: "2026-09-26T00:00:00.000Z",
      nodes: [],
      edges: [],
      sources: sources.map((source) => ({ ...source, status: "active" })),
      routes: [],
      syncedContactNodeIds: ["n-1"]
    });
    act(() => root.render(<Probe business={{ id: "shop" }} />));
    postJson.mockResolvedValue(
      graph([
        { id: "phone-src", sourcePlatform: "phone" },
        { id: "google-src", sourcePlatform: "google" }
      ])
    );
    await act(async () => {
      await hook.syncSelectedNetworkPhoneContacts([{ name: ["Wanjiru"], tel: ["0722000101"] }]);
    });
    expect(readDevicePhonebook("owner")).toHaveLength(1);

    deleteJson.mockResolvedValue(graph([{ id: "phone-src", sourcePlatform: "phone" }]));
    await act(async () => hook.disconnectNetworkSource("google-src"));
    expect(readDevicePhonebook("owner")).toHaveLength(1);

    deleteJson.mockResolvedValue(graph([]));
    await act(async () => hook.disconnectNetworkSource("phone-src"));
    expect(readDevicePhonebook("owner")).toEqual([]);
    expect(hook.devicePhonebook).toEqual([]);
  });
  it("adds customers to the network with merge, never replacing the picked phonebook", async () => {
    const customers = [{ id: "c1", name: "Mama Njeri", phone: "0722000101", email: null }];
    function CustomerProbe() {
      hook = useNetworkState({
        business: { id: "shop" } as never,
        getCustomers: () => customers as never,
        loadCustomers: async () => undefined,
        setStatusMessage,
        registerReset: () => undefined,
        registerRefresh: () => undefined
      });
      return null;
    }
    act(() => root.render(<CustomerProbe />));
    postJson.mockResolvedValue({
      ownerUserId: "owner",
      nodes: [],
      edges: [],
      sources: [],
      routes: []
    });
    await act(async () => hook.syncPhoneNetwork());
    expect(postJson).toHaveBeenCalledWith(
      "/network/sync/contacts",
      expect.objectContaining({
        mode: "merge",
        defaultCountry: expect.stringMatching(/^[A-Z]{2}$/)
      })
    );
  });

  it("reloads the graph after an invite finds people already on Grogoni, and when a request is answered elsewhere", async () => {
    act(() => root.render(<Probe business={{ id: "shop" }} />));
    postJson.mockResolvedValue({ invites: [], alreadyOnGrogoniCount: 1, invalidCount: 0 });
    getJson.mockResolvedValue([]);
    fetchFreshJson.mockReset();
    fetchFreshJson.mockResolvedValue({
      ownerUserId: "owner",
      nodes: [],
      edges: [],
      sources: [],
      routes: []
    });

    await act(async () => {
      await hook.inviteNetworkContacts([{ name: "Bob", phone: "0711000002", email: null }]);
    });
    expect(fetchFreshJson).toHaveBeenCalledWith("/network");

    fetchFreshJson.mockClear();
    await act(async () => window.dispatchEvent(new Event("grogoni:network-changed")));
    expect(fetchFreshJson).toHaveBeenCalledWith("/network");
  });
  it("tells the shell prompt when a request is answered in the card", async () => {
    const deleteJson = (await import("../apps/web/src/api-helpers")).deleteJson as ReturnType<
      typeof vi.fn
    >;
    act(() => root.render(<Probe business={{ id: "shop" }} />));
    postJson.mockResolvedValue({ connection: null });
    fetchFreshJson.mockResolvedValue({
      ownerUserId: "owner",
      nodes: [],
      edges: [],
      sources: [],
      routes: []
    });
    const heard = vi.fn();
    window.addEventListener("grogoni:network-changed", heard);

    await act(async () => {
      await hook.runNetworkConnectionAction({ type: "respond", connectionId: "c1", accept: false });
    });
    expect(heard).toHaveBeenCalledTimes(1);
    // The hook ignores its own event, so it reloads once, not twice.
    expect(fetchFreshJson.mock.calls.filter(([path]) => path === "/network")).toHaveLength(1);

    deleteJson.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await hook.runNetworkConnectionAction({ type: "remove", connectionId: "c1" });
    });
    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener("grogoni:network-changed", heard);
  });
  it("reports a failed invite in the status line and rethrows it for the card", async () => {
    act(() => root.render(<Probe business={{ id: "shop" }} />));
    postJson.mockRejectedValue(new Error("Network down"));
    let caught: unknown;
    await act(async () => {
      try {
        await hook.inviteNetworkContacts([{ name: "Dan", phone: "0722000101", email: null }]);
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBeInstanceOf(Error);
    expect(setStatusMessage).toHaveBeenCalledWith(expect.stringContaining("Network down"));
  });
});
