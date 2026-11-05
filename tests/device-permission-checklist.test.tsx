// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DeviceMessagingPage from "../apps/web/src/DeviceMessagingPage";
import {
  applySuggestion,
  buildContactIndex,
  contactDestination,
  contactKey,
  contactLabel,
  parseDevicePhonebook,
  replyDestination,
  suggestContacts
} from "../apps/web/src/device-contacts";
import {
  deviceMessagingAdapter,
  type DeviceMessagingAdapter
} from "../apps/web/src/device-messaging";
import {
  checklistProgress,
  devicePermissionCopy,
  parseDevicePermissionChecklist,
  type DevicePermissionChecklist,
  type DevicePermissionStatus
} from "../apps/web/src/device-permissions";
import contractJson from "../contracts/device-permission-checklist.json";

const contract = contractJson as {
  statuses: string[];
  items: { id: string; required: boolean }[];
  notAsked: Record<string, string>;
};

function checklist(
  statuses: Partial<Record<string, DevicePermissionStatus>> = {},
  completed = false
): DevicePermissionChecklist {
  return {
    version: 2,
    completed,
    items: contract.items.map((item) => ({
      ...item,
      status: statuses[item.id] ?? "not_requested"
    }))
  };
}
const capabilities = {
  available: true,
  roleGranted: true,
  ready: true,
  subscriptionId: 1,
  syncEnabled: false,
  businessId: null,
  accountId: null
};

describe("device permission checklist contract", () => {
  it("has wording for exactly the ids Android reports, and only Messages is required", () => {
    expect(Object.keys(devicePermissionCopy)).toEqual(contract.items.map((item) => item.id));
    expect(contract.statuses).toEqual([
      "granted",
      "not_requested",
      "denied",
      "blocked",
      "unavailable"
    ]);
    expect(contract.items.filter((item) => item.required).map((item) => item.id)).toEqual(["sms"]);
  });

  it("explains every declared permission it does not ask for", () => {
    for (const [permission, reason] of Object.entries(contract.notAsked)) {
      expect(permission).toMatch(/^android\.permission\.[A-Z_]+$/);
      expect(reason.length).toBeGreaterThan(10);
    }
    // Play rejects declared permissions with no use, so unused ones leave the manifest, not get excuses.
    expect(Object.keys(contract.notAsked)).not.toContain("android.permission.CALL_PHONE");
    expect(Object.keys(contract.notAsked)).not.toContain("android.permission.READ_MEDIA_IMAGES");
  });

  it("copy contains no em dashes", () => {
    for (const copy of Object.values(devicePermissionCopy))
      expect(`${copy.title} ${copy.detail}`).not.toMatch(/\u2014/);
  });

  it("rejects payloads that are not a checklist so older hosts and test doubles fall through", () => {
    expect(parseDevicePermissionChecklist({ messages: [], hasMore: false })).toBeNull();
    expect(parseDevicePermissionChecklist(null)).toBeNull();
    expect(parseDevicePermissionChecklist({ completed: false, items: [] })).toBeNull();
    expect(
      parseDevicePermissionChecklist({
        completed: false,
        items: [
          { id: "contacts", required: false, status: "granted" },
          { id: "teleport", required: true, status: "granted" },
          { id: "camera", required: false, status: "maybe" }
        ]
      })?.items.map((item) => item.id)
    ).toEqual(["contacts"]);
  });

  it("counts progress without unsupported items", () => {
    const progress = checklistProgress(
      checklist({ sms: "unavailable", contacts: "granted", camera: "blocked", location: "denied" })
    );
    expect(progress).toEqual({ granted: 1, total: 4, requiredMissing: 0, askable: 2 });
    expect(checklistProgress(checklist()).requiredMissing).toBe(1);
  });
});

describe("phonebook matching", () => {
  const phonebook = {
    country: "KE",
    contacts: [
      { name: "Amina Otieno", phone: "+254 712 345 678" },
      { name: "Duplicate", phone: "0712345678" },
      { name: "Bank", phone: "40404" }
    ]
  };
  const index = buildContactIndex(phonebook);
  const label = (address: string, country: string | null = "KE") =>
    contactLabel(address, index, country);
  it("matches local and international formats of the same number", () => {
    expect(contactKey("+254 712-345-678", "KE")).toBe(contactKey("0712345678", "KE"));
    expect(label("0712345678")).toBe("Amina Otieno (0712345678)");
    expect(label("+254712345678")).toBe("Amina Otieno (+254712345678)");
  });
  it("never gives a neighbouring country's number the contact's name", () => {
    // Same 9-digit subscriber number in Uganda and Tanzania: a different person.
    expect(label("+256712345678")).toBe("+256712345678");
    expect(label("+255712345678")).toBe("+255712345678");
    // On a Ugandan SIM, local numbers are Ugandan: an incoming 0712... matches the contact saved
    // locally as 0712345678 (+256), never the Kenyan +254 contact.
    const ugandan = buildContactIndex({ ...phonebook, country: "UG" });
    expect(contactLabel("0712345678", ugandan, "UG")).toBe("Duplicate (0712345678)");
    expect(contactLabel("+256712345678", ugandan, "UG")).toBe("Duplicate (+256712345678)");
    expect(contactLabel("+254712345678", ugandan, "UG")).toBe("Amina Otieno (+254712345678)");
  });
  it("matches short codes exactly and leaves unknown and alphanumeric senders alone", () => {
    expect(label("40404")).toBe("Bank (40404)");
    expect(label("404")).toBe("404");
    expect(label("MPESA")).toBe("MPESA");
    expect(label("+15551234567")).toBe("+15551234567");
  });
  it("replies to E.164 when the country is known and leaves everything else alone", () => {
    expect(replyDestination("0712345678", "KE")).toBe("+254712345678");
    expect(replyDestination("+256712345678", "KE")).toBe("+256712345678");
    expect(replyDestination("0712345678", null)).toBe("0712345678");
    expect(replyDestination("40404", "KE")).toBe("40404");
    expect(replyDestination("MPESA", "KE")).toBe("MPESA");
  });
  it("does not flood suggestions on a stray digit", () => {
    expect(suggestContacts(phonebook.contacts, "0-", "KE")).toEqual([]);
    expect(suggestContacts(phonebook.contacts, "07", "KE").map((c) => c.name)).toEqual([
      "Duplicate"
    ]);
  });
  it("keeps an invalid + number apart from a short code with the same digits", () => {
    expect(contactKey("+40404", "KE")).not.toBe(contactKey("40404", "KE"));
  });
  it("does not guess a country for local numbers when none is known", () => {
    const unknown = buildContactIndex({ ...phonebook, country: null });
    // The same saved text still matches, but it is never read as a Kenyan number.
    expect(contactLabel("0712345678", unknown, null)).toBe("Duplicate (0712345678)");
    expect(contactLabel("+254712345678", unknown, null)).toBe("Amina Otieno (+254712345678)");
    expect(contactKey("0712345678", null)).not.toBe(contactKey("+254712345678", null));
  });
  it("trusts the number Android saved over today's SIM after a SIM swap", () => {
    const swapped = buildContactIndex({
      country: "UG",
      contacts: [{ name: "Amina", phone: "0712345678", normalized: "+254712345678" }]
    });
    expect(contactLabel("+256712345678", swapped, "UG")).toBe("+256712345678");
    expect(contactLabel("+254712345678", swapped, "UG")).toBe("Amina (+254712345678)");
  });
  it("treats an unsupported country as unknown instead of reading numbers as Kenyan", () => {
    expect(parseDevicePhonebook({ contacts: [], country: "ZZ" }).country).toBeNull();
  });
  it("never gives a sender ID the name saved for the digits inside it", () => {
    expect(label("KCB40404")).toBe("KCB40404");
    expect(label("Promo 40404")).toBe("Promo 40404");
  });
  it("suggests by name or digits for the recipient being typed", () => {
    const { contacts, country } = phonebook;
    const names = (input: string) => suggestContacts(contacts, input, country).map((c) => c.name);
    expect(names("a")).toEqual([]);
    expect(names("AMI")).toEqual(["Amina Otieno"]);
    expect(names("+254712, ban")).toEqual(["Bank"]);
    // Both saved forms of one number are one suggestion, found from either form.
    expect(names("dupl")).toEqual(["Duplicate"]);
    expect(names("0712")).toEqual(["Amina Otieno"]);
    expect(names("+25471")).toEqual(["Amina Otieno"]);
    expect(applySuggestion("ami", "+254712345678")).toBe("+254712345678");
    expect(applySuggestion("+15551234567, ban", "40404")).toBe("+15551234567, 40404");
  });
  it("sends to the saved identity, never a local form Android would read in the visited country", () => {
    const local = { name: "Amina", phone: "0712345678", normalized: "+254712345678" };
    expect(contactDestination(local, "UG")).toBe("+254712345678");
    expect(contactDestination({ name: "A", phone: "0712345678" }, "KE")).toBe("+254712345678");
    expect(contactDestination({ name: "A", phone: "0712345678" }, null)).toBe("0712345678");
    expect(contactDestination({ name: "Bank", phone: "40404" }, "KE")).toBe("40404");
    // Unknown country: not offered at all, while international numbers and short codes still are.
    const unknown = [
      { name: "Wanjiku Local", phone: "0712000111" },
      { name: "Wanjiku Intl", phone: "+254712000222" },
      { name: "Wanjiku Bank", phone: "40404" }
    ];
    expect(suggestContacts(unknown, "wanjiku", null).map((c) => c.name)).toEqual([
      "Wanjiku Intl",
      "Wanjiku Bank"
    ]);
  });
  it("accepts only well-formed contacts and countries from the host", () => {
    expect(parseDevicePhonebook({ messages: [] })).toEqual({ contacts: [], country: null });
    expect(
      parseDevicePhonebook({
        country: "ke",
        contacts: [{ name: "A", phone: "123" }, { name: "B" }, { name: "C", phone: "none" }, null]
      })
    ).toEqual({ contacts: [{ name: "A", phone: "123" }], country: "KE" });
    expect(parseDevicePhonebook({ contacts: [], country: "Kenya" }).country).toBeNull();
  });
});

describe("device messenger layout", () => {
  // styles.css sets body { overflow: hidden } for the app shell. Without its own scroll container
  // the checklist's lower items and Continue button were unreachable on a 720x1280 phone.
  it("scrolls inside the standalone device route", () => {
    const css = readFileSync(join(process.cwd(), "apps/web/src/device-messaging.css"), "utf8");
    const block = /\.device-messenger \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/overflow-y:\s*auto/);
    expect(block).toMatch(/height:\s*100dvh/);
    // Older Android WebViews ignore dvh; the vh fallback must come first.
    expect(block.indexOf("height: 100vh")).toBeGreaterThan(-1);
    expect(block.indexOf("height: 100vh")).toBeLessThan(block.indexOf("height: 100dvh"));
  });
});

describe("first-run device permission checklist", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState(null, "", "/device-messages");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (node) => node.textContent === label || node.getAttribute("aria-label") === label
    );
  const item = (id: string) => container.querySelector<HTMLElement>(`[data-permission="${id}"]`)!;
  const compose = () => container.querySelector('[aria-label="Compose carrier message"]');
  function host(
    state: { current: DevicePermissionChecklist },
    overrides: Record<string, unknown> = {}
  ) {
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method in overrides) {
        const value = overrides[method];
        if (value instanceof Error) throw value;
        return typeof value === "function" ? (value as (p: unknown) => unknown)(params) : value;
      }
      if (method === "permissionChecklist") return state.current;
      if (method === "completePermissionChecklist")
        return (state.current = { ...state.current, completed: true });
      if (method === "capabilities") return capabilities;
      if (method === "listContacts") return { contacts: [] };
      return { messages: [], pending: [], hasMore: false };
    });
    return { call, adapter: { call } as DeviceMessagingAdapter };
  }
  async function render(adapter: DeviceMessagingAdapter) {
    await act(async () => root.render(<DeviceMessagingPage adapter={adapter} />));
  }

  it("prompts a new install with every messenger feature, including the phonebook, before the inbox", async () => {
    const { adapter } = host({ current: checklist() });
    await render(adapter);
    expect(container.textContent).toContain("Set up Grogoni on this phone");
    expect(compose()).toBeNull();
    for (const id of contract.items.map((entry) => entry.id))
      expect(item(id).textContent).toContain(devicePermissionCopy[id]!.title);
    expect(item("contacts").textContent).toContain("Phonebook");
    expect(item("sms").textContent).toContain("Needed for messages");
    expect(item("contacts").textContent).toContain("Optional");
    // The tag is not part of the heading's accessible name.
    expect(item("contacts").querySelector("h3")!.textContent).toBe("Phonebook");
    expect(container.textContent).toContain("0 of 5 allowed");
  });

  it("asks Android for one item when the user taps Allow and shows the result", async () => {
    const state = { current: checklist() };
    const { call, adapter } = host(state, {
      requestPermissionGroup: (params: { id: string }) =>
        (state.current = checklist({ [params.id]: "granted" }))
    });
    await render(adapter);
    await act(async () => button("Allow Phonebook")!.click());
    expect(call).toHaveBeenCalledWith(
      "requestPermissionGroup",
      { id: "contacts" },
      { timeoutMs: 900_000 }
    );
    expect(item("contacts").dataset.status).toBe("granted");
    expect(item("contacts").textContent).toContain("Allowed");
    expect(button("Allow Phonebook")).toBeUndefined();
    expect(container.textContent).toContain("1 of 5 allowed");
  });

  it("gives Allow all a dialog-length timeout and offers a plain Continue once Messages is granted", async () => {
    const state = { current: checklist() };
    const { call, adapter } = host(state, {
      requestAllPermissions: () =>
        (state.current = checklist({
          sms: "granted",
          contacts: "granted",
          notifications: "granted",
          camera: "granted",
          location: "denied"
        }))
    });
    await render(adapter);
    await act(async () => button("Allow all")!.click());
    expect(call).toHaveBeenCalledWith("requestAllPermissions", undefined, { timeoutMs: 900_000 });
    expect(button("Continue")).toBeDefined();
    expect(button("Continue with limited access")).toBeUndefined();
    expect(item("location").textContent).toContain("You declined this");
    expect(button("Allow Location")).toBeDefined();
  });

  it("sends permanently refused items to Android settings instead of a dead Allow button", async () => {
    const state = { current: checklist({ contacts: "blocked", sms: "unavailable" }) };
    const { call, adapter } = host(state);
    await render(adapter);
    expect(button("Allow Phonebook")).toBeUndefined();
    expect(item("sms").textContent).toContain("Not supported on this phone");
    expect(button("Allow Messages (SMS and MMS)")).toBeUndefined();
    await act(async () => button("Open settings for Phonebook")!.click());
    expect(call).toHaveBeenCalledWith("openPermissionSettings", { id: "contacts" }, {});
  });

  it("offers Settings next to Allow for a declined item, since Android can refuse silently", async () => {
    const { call, adapter } = host({
      current: checklist({ sms: "denied", camera: "not_requested" })
    });
    await render(adapter);
    expect(button("Allow Messages (SMS and MMS)")).toBeDefined();
    expect(button("Open settings for Camera")).toBeUndefined();
    await act(async () => button("Open settings for Messages (SMS and MMS)")!.click());
    expect(call).toHaveBeenCalledWith("openPermissionSettings", { id: "sms" }, {});
  });

  it("ignores a second tap while Android is answering the first", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const { call, adapter } = host(
      { current: checklist() },
      { requestPermissionGroup: () => new Promise((resolve) => (finish = resolve)) }
    );
    await render(adapter);
    await act(async () => {
      button("Allow Camera")!.click();
      button("Allow Location")!.click();
    });
    expect(call.mock.calls.filter(([method]) => method === "requestPermissionGroup")).toHaveLength(
      1
    );
    await act(async () => finish(checklist({ camera: "granted" })));
    expect(item("camera").dataset.status).toBe("granted");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("picks up grants made in Android settings without a tap", async () => {
    vi.useFakeTimers();
    const state = { current: checklist({ contacts: "blocked" }) };
    const { adapter } = host(state);
    await render(adapter);
    state.current = checklist({ contacts: "granted" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(item("contacts").dataset.status).toBe("granted");
  });

  it("never traps the user: Continue with limited access opens the inbox and is remembered", async () => {
    const state = { current: checklist() };
    const { call, adapter } = host(state);
    await render(adapter);
    expect(container.textContent).toContain("Without Messages, Grogoni cannot read or send texts");
    await act(async () => button("Continue with limited access")!.click());
    expect(call).toHaveBeenCalledWith("completePermissionChecklist", undefined, {});
    expect(compose()).not.toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    await render(adapter);
    expect(container.textContent).not.toContain("Set up Grogoni on this phone");
  });

  it("lets Continue through while an Android request is still open", async () => {
    const { call, adapter } = host(
      { current: checklist() },
      { requestAllPermissions: () => new Promise(() => undefined) }
    );
    await render(adapter);
    await act(async () => button("Allow all")!.click());
    await act(async () => button("Continue with limited access")!.click());
    expect(call).toHaveBeenCalledWith("completePermissionChecklist", undefined, {});
    expect(compose()).not.toBeNull();
  });

  it("keeps Review app permissions reachable on a phone without carrier messaging", async () => {
    const { adapter } = host(
      { current: checklist({ sms: "unavailable" }, true) },
      { capabilities: { ...capabilities, available: false } }
    );
    await render(adapter);
    await act(async () => button("Review app permissions")!.click());
    expect(container.textContent).toContain("Set up Grogoni on this phone");
  });

  it("reloads the phonebook when the user comes back to the app", async () => {
    const { call, adapter } = host({ current: checklist({}, true) });
    await render(adapter);
    const before = call.mock.calls.filter(([method]) => method === "listContacts").length;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(call.mock.calls.filter(([method]) => method === "listContacts").length).toBe(before + 1);
  });

  it("still opens the inbox when Android cannot record completion", async () => {
    const { adapter } = host(
      { current: checklist() },
      {
        completePermissionChecklist: new Error("The device adapter did not start. Reopen the app.")
      }
    );
    await render(adapter);
    await act(async () => button("Continue with limited access")!.click());
    expect(compose()).not.toBeNull();
  });

  it("keeps the checklist open and announces a failed Android request", async () => {
    const { adapter } = host(
      { current: checklist() },
      { requestPermissionGroup: new Error("A permission request is already open.") }
    );
    await render(adapter);
    await act(async () => button("Allow Camera")!.click());
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(
      "A permission request is already open."
    );
    expect(container.textContent).toContain("Set up Grogoni on this phone");
  });

  it("can be reopened from messenger settings after onboarding", async () => {
    const state = { current: checklist({ contacts: "granted" }, true) };
    const { adapter } = host(state);
    await render(adapter);
    expect(container.textContent).not.toContain("Set up Grogoni on this phone");
    await act(async () => button("Settings")!.click());
    await act(async () => button("Review app permissions")!.click());
    expect(container.textContent).toContain("Set up Grogoni on this phone");
    expect(item("contacts").dataset.status).toBe("granted");
  });

  it("opens the inbox directly when the host has no checklist or the bridge fails", async () => {
    await render(deviceMessagingAdapter);
    expect(container.textContent).not.toContain("Set up Grogoni on this phone");
    expect(container.textContent).toContain("Your browser cannot read");

    act(() => root.unmount());
    root = createRoot(container);
    const { adapter } = host(
      { current: checklist() },
      { permissionChecklist: new Error("bridge down") }
    );
    await render(adapter);
    expect(compose()).not.toBeNull();
  });

  it("shows phonebook names and suggests recipients once the phonebook is allowed", async () => {
    const { call, adapter } = host(
      { current: checklist({ contacts: "granted" }, true) },
      {
        listContacts: {
          country: "KE",
          contacts: [
            { name: "Amina Otieno", phone: "+254712345678" },
            { name: "Bank", phone: "40404" }
          ]
        },
        listSms: {
          messages: [
            {
              id: 1,
              address: "0712345678",
              body: "Hello",
              date: 1_800_000_000_000,
              type: 1,
              read: false
            }
          ],
          pending: [],
          hasMore: false
        }
      }
    );
    await render(adapter);
    await act(async () => Promise.resolve());
    expect(call).toHaveBeenCalledWith("listContacts");
    expect(container.querySelector(".device-message strong")!.textContent).toBe(
      "Amina Otieno (0712345678)"
    );
    const to = container.querySelector<HTMLInputElement>('input[autocomplete="tel"]')!;
    const type = (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(to, value);
        to.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await type("ami");
    const suggestion = container.querySelector<HTMLButtonElement>(
      ".device-contact-suggestions button"
    )!;
    expect(suggestion.textContent).toBe("Amina Otieno +254712345678");
    await act(async () => suggestion.click());
    expect(to.value).toBe("+254712345678");
    expect(container.querySelector(".device-contact-suggestions")).toBeNull();
  });

  it("texts the contact's saved E.164 number after tapping a local-format suggestion", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { call, adapter } = host(
      { current: checklist({}, true) },
      {
        listContacts: {
          country: "KE",
          contacts: [{ name: "Amina", phone: "0712345678", normalized: "+254712345678" }]
        }
      }
    );
    await render(adapter);
    await act(async () => Promise.resolve());
    const to = container.querySelector<HTMLInputElement>('input[autocomplete="tel"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(to, "ami");
      to.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".device-contact-suggestions button")!.click()
    );
    const body = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        body,
        "Hi"
      );
      body.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Send SMS via SIM")!.click());
    expect(call).toHaveBeenCalledWith(
      "sendSms",
      expect.objectContaining({ recipients: ["+254712345678"] })
    );
  });

  it("brings the composer back into view on Reply, inside the page's own scroller", async () => {
    const { adapter } = host(
      { current: checklist({}, true) },
      {
        listSms: {
          messages: [{ id: 1, address: "0712345678", body: "Hi", date: 1, type: 1, read: false }],
          pending: [],
          hasMore: false
        }
      }
    );
    const scrollTo = vi.fn();
    (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo = scrollTo;
    await render(adapter);
    await act(async () => container.querySelector<HTMLButtonElement>(".device-message")!.click());
    await act(async () => button("Reply")!.click());
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(scrollTo.mock.contexts[0]).toBe(container.querySelector(".device-messenger"));
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  });

  it("replies to the identity the label shows, not a local form read in the visited country", async () => {
    const { adapter } = host(
      { current: checklist({}, true) },
      {
        listContacts: { country: "KE", contacts: [{ name: "Amina", phone: "+254712345678" }] },
        listSms: {
          messages: [{ id: 1, address: "0712345678", body: "Hi", date: 1, type: 1, read: false }],
          pending: [],
          hasMore: false
        }
      }
    );
    await render(adapter);
    await act(async () => Promise.resolve());
    await act(async () => container.querySelector<HTMLButtonElement>(".device-message")!.click());
    await act(async () => button("Reply")!.click());
    expect(container.querySelector<HTMLInputElement>('input[autocomplete="tel"]')!.value).toBe(
      "+254712345678"
    );
  });

  it("shows plain numbers without phonebook access", async () => {
    const { adapter } = host(
      { current: checklist({}, true) },
      {
        listContacts: new Error("Allow Phonebook access first."),
        listSms: {
          messages: [{ id: 1, address: "0712345678", body: "Hi", date: 1, type: 1, read: false }],
          pending: [],
          hasMore: false
        }
      }
    );
    await render(adapter);
    expect(container.querySelector(".device-message strong")!.textContent).toBe("0712345678");
    expect(container.querySelector(".device-contact-suggestions")).toBeNull();
    expect(container.textContent).not.toContain("Allow Phonebook access first.");
  });
});
