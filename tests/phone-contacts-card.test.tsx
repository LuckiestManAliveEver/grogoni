// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkConnectionSummary } from "@grogoni/shared-types";

import { PhoneContactsCard } from "../apps/web/src/PhoneContactsCard";
import {
  clearDevicePhonebooks,
  readDevicePhonebook,
  writeDevicePhonebook
} from "../apps/web/src/phonebook-device-cache";
import type { NetworkGraphSummary } from "../apps/web/src/grogoni-application-shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = "2026-09-26T00:00:00.000Z";
const request: NetworkConnectionSummary = {
  id: "c-eve",
  status: "pending",
  direction: "incoming",
  counterpartUserId: "u-eve",
  counterpartDisplayName: "Eve",
  counterpartBusinessName: "Eve Grocers",
  counterpartGrogoniId: null,
  nodeId: null,
  createdAt: at,
  updatedAt: at,
  respondedAt: null
};

const graph: NetworkGraphSummary = {
  ownerUserId: "owner",
  generatedAt: at,
  nodes: [
    {
      id: "n-bob",
      displayName: "Bob",
      degree: 1,
      sourceId: "s",
      sourceType: "phone_contact",
      sourcePlatform: "phone",
      grogoniUserId: "u-bob",
      visibilityStatus: "direct",
      consentStatus: "pending"
    },
    {
      id: "n-frank",
      displayName: "Frank",
      degree: 1,
      sourceId: "s",
      sourceType: "phone_contact",
      sourcePlatform: "phone",
      grogoniUserId: null,
      visibilityStatus: "direct",
      consentStatus: "pending"
    }
  ],
  edges: [],
  sources: [],
  routes: [],
  connections: [request]
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderCard(overrides: Partial<Parameters<typeof PhoneContactsCard>[0]> = {}) {
  const props = {
    graph,
    connected: true,
    deviceContacts: [
      { name: "Bob", phone: "+254711000002", email: null, nodeId: "n-bob" },
      { name: "Frank", phone: "+254722000101", email: null, nodeId: "n-frank" }
    ],
    invites: [],
    onBack: vi.fn(),
    onSync: vi.fn().mockResolvedValue(graph),
    onDisconnect: vi.fn(),
    onConnectionAction: vi
      .fn()
      .mockResolvedValue({ ok: true, message: "Connection request sent to Bob." }),
    onInvite: vi
      .fn()
      .mockResolvedValue({ invited: 1, alreadyOnGrogoni: 0, invalid: 0, shared: false }),
    ...overrides
  };
  act(() => root.render(<PhoneContactsCard {...props} />));
  return props;
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (found === undefined) throw new Error(`No button "${label}" in: ${container.textContent}`);
  return found;
}

describe("PhoneContactsCard", () => {
  it("shows requests, Grogoni contacts with Connect, and invites only non-users", async () => {
    const props = renderCard();

    expect(container.querySelector('[aria-label="Connection requests"]')?.textContent).toContain(
      "Eve Grocers"
    );
    const onGrogoni = container.querySelector('[aria-label="On Grogoni"]')?.textContent ?? "";
    expect(onGrogoni).toContain("Bob");
    const invite = container.querySelector('[aria-label="Invite to Grogoni"]')?.textContent ?? "";
    expect(invite).toContain("Frank");
    expect(invite).not.toContain("Bob");

    await act(async () => button("Connect").click());
    expect(props.onConnectionAction).toHaveBeenCalledWith({ type: "request", nodeId: "n-bob" });
    expect(container.textContent).toContain("Connection request sent to Bob.");

    await act(async () => button("Accept").click());
    expect(props.onConnectionAction).toHaveBeenCalledWith({
      type: "respond",
      connectionId: "c-eve",
      accept: true
    });
  });

  it("invites the selected contacts with their device numbers", async () => {
    const props = renderCard();

    expect(button("Invite").disabled).toBe(true);
    await act(async () => button("Select all").click());
    await act(async () => button("Invite (1)").click());
    expect(props.onInvite).toHaveBeenCalledWith([
      { name: "Frank", phone: "+254722000101", email: null, nodeId: "n-frank" }
    ]);
    expect(container.textContent).toContain("1 invite sent.");
  });

  it("offers Cancel on a sent request and Remove on a connection", async () => {
    const connections: NetworkConnectionSummary[] = [
      { ...request, id: "c-bob", direction: "outgoing", counterpartUserId: "u-bob" },
      {
        ...request,
        id: "c-gina",
        status: "accepted",
        counterpartUserId: "u-gina",
        counterpartDisplayName: "Gina"
      }
    ];
    const props = renderCard({ graph: { ...graph, connections } });

    expect(container.querySelector('[aria-label="On Grogoni"]')?.textContent).toContain(
      "Request sent"
    );
    await act(async () => button("Cancel").click());
    expect(props.onConnectionAction).toHaveBeenCalledWith({
      type: "remove",
      connectionId: "c-bob"
    });
    await act(async () => button("Remove").click());
    expect(props.onConnectionAction).toHaveBeenCalledWith({
      type: "remove",
      connectionId: "c-gina"
    });
    expect(container.querySelector('[aria-label="Connection requests"]')).toBeNull();
  });

  it("reports the invite outcome, including people already on Grogoni and failures", async () => {
    const props = renderCard({
      onInvite: vi
        .fn()
        .mockResolvedValue({ invited: 0, alreadyOnGrogoni: 1, invalid: 0, shared: false })
    });
    await act(async () => button("Select all").click());
    await act(async () => button("Invite (1)").click());
    expect(container.textContent).toContain("Nobody to invite. 1 is already on Grogoni");

    (props.onInvite as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("x"));
    await act(async () => button("Select all").click());
    await act(async () => button("Invite (1)").click());
    expect(container.textContent).toContain("Invites could not be sent. Try again.");
  });

  it("says when only part of a large phonebook was synced", async () => {
    const picker = vi
      .fn()
      .mockResolvedValue([
        { name: ["A"], tel: ["0722000001"] },
        { name: ["B"], tel: ["0722000002"] },
        {}
      ]);
    vi.stubGlobal("navigator", { ...navigator, contacts: { select: picker } });
    renderCard({
      onSync: vi.fn().mockResolvedValue({ ...graph, syncedContactNodeIds: ["n-a"] })
    });
    await act(async () => button("Add or update contacts").click());
    expect(container.textContent).toContain("Synced 1 of 2 contacts");
    vi.unstubAllGlobals();
  });

  it("offers a contacts file import when the browser has no contact picker", async () => {
    const props = renderCard({ connected: false, deviceContacts: [], graph: null });

    expect(container.textContent).not.toContain("Sync contacts");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    // jsdom's File has no text(); the card only reads the file through it.
    const file = { text: async () => "BEGIN:VCARD\nFN:Wanjiru\nTEL:+254722000555\nEND:VCARD\n" };
    Object.defineProperty(input, "files", { value: [file] });
    await act(async () => {
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(props.onSync).toHaveBeenCalledWith([
      { name: ["Wanjiru"], tel: ["+254722000555"], email: [] }
    ]);
  });
});

describe("device phonebook cache", () => {
  it("keeps contacts per user, drops malformed rows, and clears on logout", () => {
    writeDevicePhonebook("u1", [{ name: "A", phone: "1", email: null, nodeId: null }]);
    writeDevicePhonebook("u2", [{ name: "B", phone: "2", email: null, nodeId: "n" }]);
    localStorage.setItem("grogoni.phonebook.v1:u3", JSON.stringify([{ name: 5 }, "junk"]));
    localStorage.setItem("unrelated", "keep");

    expect(readDevicePhonebook("u1").map((entry) => entry.name)).toEqual(["A"]);
    expect(readDevicePhonebook("u3")).toEqual([]);

    clearDevicePhonebooks();
    expect(readDevicePhonebook("u1")).toEqual([]);
    expect(readDevicePhonebook("u2")).toEqual([]);
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });

  it("degrades to an empty list when storage throws", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readDevicePhonebook("u1")).toEqual([]);
    getItem.mockRestore();
  });
});
