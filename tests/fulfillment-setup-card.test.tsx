// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CorridorSummary, DispatchPolicySummary, VehicleSummary } from "@grogoni/shared-types";

const getJson = vi.fn();
const postJson = vi.fn();
const patchJson = vi.fn();

vi.mock("../apps/web/src/api-helpers", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
  fetchFreshJson: (...args: unknown[]) => getJson(...args),
  postJson: (...args: unknown[]) => postJson(...args),
  patchJson: (...args: unknown[]) => patchJson(...args)
}));

const { default: FulfillmentSetupCard } = await import("../apps/web/src/FulfillmentSetupCard");
const { invalidateApiCacheForMutation } = await import("../apps/web/src/api-request-cache");
const { ApiRequestError } = await import("../apps/web/src/lib/api");
const { fulfillmentCopy } = await import("../apps/web/src/fulfillment-copy");
const { parseRoutePoints, appendRoutePoint } = await import("../apps/web/src/corridor-route-input");

const base = "/businesses/shop-a/fulfillment";
const at = new Date(0).toISOString();
const en = fulfillmentCopy("en");

const policy: DispatchPolicySummary = {
  id: "policy-row-2",
  policyId: "policy-1",
  businessId: "shop-a",
  version: 2,
  name: "Default",
  isBusinessDefault: true,
  targetLoadGrams: "6000000",
  minimumDispatchLoadGrams: "4500500",
  maxDiversionMeters: 2000,
  cutoffLocalTime: "18:00",
  maxWaitHours: 72,
  fulfillmentLeadDays: 1,
  underThresholdFallback: ["REQUIRE_DISPATCH_APPROVAL"],
  overflowStrategy: "NEXT_MANIFEST",
  active: true,
  createdBy: "owner",
  createdAt: at
};

const vehicle: VehicleSummary = {
  id: "truck-7",
  businessId: "shop-a",
  name: "7-tonne truck",
  registration: "KBX 123A",
  capacityGrams: "7000000",
  active: true,
  createdBy: "owner",
  createdAt: at,
  updatedAt: at
};

const corridor = {
  id: "corridor-x",
  businessId: "shop-a",
  name: "Thika Road",
  originLabel: "Depot",
  destinationLabel: "Thika",
  distanceMeters: 42_300,
  geometryVersion: 3,
  active: true
} as CorridorSummary;

/** Mocks the four setup reads for an empty business, or the given state. */
function serve(state: {
  timezone?: string | null;
  policy?: DispatchPolicySummary | null;
  vehicles?: VehicleSummary[];
  corridors?: CorridorSummary[];
  canManage?: boolean;
}) {
  getJson.mockImplementation(async (path: string) => {
    const business = /^\/businesses\/([^/]+)\/fulfillment\//u.exec(path)?.[1];
    if (path.endsWith("/fulfillment/settings"))
      return {
        businessId: business,
        timezone: state.timezone ?? null,
        viewerCanManage: state.canManage ?? true
      };
    if (path.endsWith("/fulfillment/default-policy")) return { policy: state.policy ?? null };
    if (path.endsWith("/fulfillment/vehicles?include=inactive")) return state.vehicles ?? [];
    if (path.endsWith("/fulfillment/corridors?include=inactive")) return state.corridors ?? [];
    throw new Error(`unexpected GET ${path}`);
  });
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

function field(host: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement {
  const found = [...host.querySelectorAll("label")].find((item) =>
    (item.textContent ?? "").startsWith(label)
  );
  const control = found?.querySelector("input, textarea");
  if (control === null || control === undefined) throw new Error(`No field "${label}"`);
  return control as HTMLInputElement | HTMLTextAreaElement;
}

async function type(host: HTMLElement, label: string, value: string) {
  const control = field(host, label);
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
  if (found === undefined) throw new Error(`No button "${label}"`);
  return found;
}

async function submit(host: HTMLElement, formLabel: string) {
  const form = host.querySelector(`form[aria-label="${formLabel}"]`);
  if (form === null) throw new Error(`No form "${formLabel}"`);
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}

describe("owner fulfillment setup card", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    getJson.mockReset();
    postJson.mockReset();
    patchJson.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function render(businessId = "shop-a") {
    await act(async () => {
      root = createRoot(host);
      root.render(<FulfillmentSetupCard businessId={businessId} />);
    });
    await flush();
  }

  /** A promise the test settles by hand, to hold a save "in flight". */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("starts an unconfigured business empty: no values invented, nothing saved on its own", async () => {
    serve({});
    await render();
    expect(host.textContent).toContain(en.setupProgress(0, 4));
    for (const label of [en.targetLoad, en.maxDiversion, en.maxWait, en.leadDays, en.capacity]) {
      expect(field(host, label).value).toBe("");
    }
    expect(field(host, en.timezone).value).toBe("");
    expect(postJson).not.toHaveBeenCalled();
    expect(patchJson).not.toHaveBeenCalled();
  });

  it("saves the business's own timezone", async () => {
    serve({});
    patchJson.mockResolvedValue({
      businessId: "shop-a",
      timezone: "Africa/Kampala",
      viewerCanManage: true
    });
    await render();
    await type(host, en.timezone, "Africa/Kampala");
    await submit(host, en.timezone);
    expect(patchJson).toHaveBeenCalledWith(`${base}/settings`, {
      timezone: "Africa/Kampala",
      expectedTimezone: null
    });
    expect(host.textContent).toContain(en.setupProgress(1, 4));
  });

  it("creates the first dispatch policy as the default, with exact grams from typed kilograms", async () => {
    serve({});
    postJson.mockResolvedValue({ ...policy, version: 1 });
    await render();
    await type(host, en.policyName, "Default");
    await type(host, en.targetLoad, "6,000");
    await type(host, en.minimumLoad, "4500.5");
    await type(host, en.maxDiversion, "2000");
    await type(host, en.cutoff, "18:00");
    await type(host, en.maxWait, "72");
    await type(host, en.leadDays, "1");
    await submit(host, en.policy);
    expect(postJson).toHaveBeenCalledWith(
      `${base}/policies`,
      {
        name: "Default",
        targetLoadGrams: "6000000",
        minimumDispatchLoadGrams: "4500500",
        maxDiversionMeters: 2000,
        cutoffLocalTime: "18:00",
        maxWaitHours: 72,
        fulfillmentLeadDays: 1,
        underThresholdFallback: [],
        overflowStrategy: "NEXT_MANIFEST",
        makeBusinessDefault: true,
        // "There was no default when I started": refused if someone created one meanwhile.
        expectedDefaultPolicyId: null
      },
      { idempotencyKey: expect.any(String) }
    );
  });

  it("revises an existing default policy instead of creating a second one", async () => {
    serve({ timezone: "Africa/Nairobi", policy });
    postJson.mockResolvedValue({ ...policy, version: 3, targetLoadGrams: "6500000" });
    await render();
    expect(field(host, en.targetLoad).value).toBe("6000");
    expect(field(host, en.minimumLoad).value).toBe("4500.5");
    await type(host, en.targetLoad, "6500");
    await submit(host, en.policy);
    expect(postJson).toHaveBeenCalledWith(
      `${base}/policies/policy-1/revisions`,
      expect.objectContaining({
        targetLoadGrams: "6500000",
        underThresholdFallback: ["REQUIRE_DISPATCH_APPROVAL"]
      }),
      { idempotencyKey: expect.any(String) }
    );
    expect(host.textContent).toContain(en.policyVersion(3));
  });

  it("refuses kilograms it cannot convert exactly, without calling the server", async () => {
    serve({});
    await render();
    await type(host, en.policyName, "Default");
    await type(host, en.targetLoad, "6000.1234");
    await submit(host, en.policy);
    expect(postJson).not.toHaveBeenCalled();
    expect(host.textContent).toContain(en.invalidKg(en.targetLoad));
  });

  it("adds a vehicle, and a retry after a failed request reuses the same idempotency key", async () => {
    serve({});
    postJson.mockRejectedValueOnce(new Error("Network dropped")).mockResolvedValueOnce(vehicle);
    await render();
    await type(host, en.vehicleName, "7-tonne truck");
    await type(host, en.capacity, "7000");
    await submit(host, en.vehicles);
    await submit(host, en.vehicles);
    expect(postJson).toHaveBeenCalledTimes(2);
    const [first, second] = postJson.mock.calls;
    expect(first?.[1]).toEqual({
      name: "7-tonne truck",
      registration: null,
      capacityGrams: "7000000"
    });
    expect(second?.[2]).toEqual(first?.[2]);
    expect(host.textContent).toContain("7-tonne truck (KBX 123A) · 7,000 kg");
    expect(host.textContent).toContain(en.setupProgress(1, 4));
  });

  it("retires and reactivates vehicles and corridors", async () => {
    serve({ vehicles: [vehicle], corridors: [corridor] });
    patchJson.mockImplementation(async (path: string, body: { active: boolean }) =>
      path.includes("/vehicles/") ? { ...vehicle, ...body } : { ...corridor, ...body }
    );
    await render();
    expect(host.textContent).toContain(en.corridorLength("42.3", 3));
    const retire = [...host.querySelectorAll("button")].filter(
      (item) => item.textContent === en.retire
    );
    expect(retire).toHaveLength(2);
    await act(async () => retire[0]?.click());
    await flush();
    expect(patchJson).toHaveBeenCalledWith(`${base}/vehicles/truck-7`, { active: false });
    expect(host.textContent).toContain(en.retired);
  });

  it("adds a corridor, swapping typed latitude/longitude into GeoJSON order", async () => {
    serve({});
    postJson.mockResolvedValue(corridor);
    await render();
    await type(host, en.corridorName, "Thika Road");
    await type(host, en.origin, "Depot");
    await type(host, en.destination, "Thika");
    await type(host, en.routePoints, "-1.2921, 36.8219\n-1.0333, 37.0693");
    await submit(host, en.corridors);
    expect(postJson).toHaveBeenCalledWith(
      `${base}/corridors`,
      {
        name: "Thika Road",
        originLabel: "Depot",
        destinationLabel: "Thika",
        routeGeometry: {
          type: "LineString",
          coordinates: [
            [36.8219, -1.2921],
            [37.0693, -1.0333]
          ]
        }
      },
      { idempotencyKey: expect.any(String) }
    );
  });

  it("explains a malformed route line and sends nothing", async () => {
    serve({});
    await render();
    await type(host, en.corridorName, "Thika Road");
    await type(host, en.origin, "Depot");
    await type(host, en.destination, "Thika");
    await type(host, en.routePoints, "-1.2921, 36.8219\nnear the petrol station");
    await submit(host, en.corridors);
    expect(postJson).not.toHaveBeenCalled();
    expect(host.textContent).toContain(en.routeError("format", 2));
  });

  it("shows a non-owner the settings read-only, with no controls that would be refused", async () => {
    serve({
      timezone: "Africa/Nairobi",
      policy,
      vehicles: [vehicle],
      corridors: [corridor],
      canManage: false
    });
    await render();
    expect(host.textContent).toContain(en.ownerOnly);
    expect(field(host, en.targetLoad).value).toBe("6000");
    expect(field(host, en.timezone).value).toBe("Africa/Nairobi");
    for (const formLabel of [en.timezone, en.policy]) {
      expect(
        host.querySelector(`form[aria-label="${formLabel}"] fieldset`)?.hasAttribute("disabled")
      ).toBe(true);
    }
    const labels = [...host.querySelectorAll("button")].map((item) => item.textContent);
    for (const hidden of [en.save, en.savePolicy, en.addVehicle, en.addCorridor, en.retire]) {
      expect(labels).not.toContain(hidden);
    }
    expect(host.textContent).toContain("7-tonne truck (KBX 123A) · 7,000 kg");
  });

  it("keeps the owner's unsaved edits when something else on the page changes", async () => {
    serve({ timezone: "Africa/Nairobi", policy });
    await render();
    await type(host, en.targetLoad, "6500");
    await type(host, en.timezone, "Africa/Kampala");
    const readsBefore = getJson.mock.calls.length;
    // A real mutation elsewhere under this business's fulfillment path (a manifest created in the
    // dispatch card) goes through the real mutation bus and makes this card refetch.
    await act(async () => {
      await invalidateApiCacheForMutation(`${base}/manifests`);
    });
    await flush();
    expect(getJson.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(field(host, en.targetLoad).value).toBe("6500");
    expect(field(host, en.timezone).value).toBe("Africa/Kampala");
  });

  it("refreshes an untouched policy form when the policy changes elsewhere", async () => {
    serve({ policy });
    await render();
    serve({ policy: { ...policy, version: 3, targetLoadGrams: "7000000" } });
    await act(async () => {
      await invalidateApiCacheForMutation(`${base}/policies`);
    });
    await flush();
    expect(field(host, en.targetLoad).value).toBe("7000");
    expect(host.textContent).toContain(en.policyVersion(3));
  });

  it("uses a fresh idempotency key when the payload changes, the same key when it does not", async () => {
    serve({});
    postJson
      .mockRejectedValueOnce(new Error("Network dropped"))
      .mockRejectedValueOnce(new Error("Network dropped"))
      .mockResolvedValueOnce(vehicle);
    await render();
    await type(host, en.vehicleName, "7-tonne truck");
    await type(host, en.capacity, "7000");
    await submit(host, en.vehicles);
    await type(host, en.capacity, "7500");
    await submit(host, en.vehicles);
    await submit(host, en.vehicles);
    const keys = postJson.mock.calls.map(
      (call) => (call[2] as { idempotencyKey: string }).idempotencyKey
    );
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[1]);
  });

  it("reloads and explains when the server says the key was used for different details", async () => {
    serve({});
    postJson.mockRejectedValueOnce(
      new ApiRequestError(409, "Idempotency key reused.", { code: "idempotency_key_reused" })
    );
    await render();
    const readsBefore = getJson.mock.calls.length;
    await type(host, en.vehicleName, "Van");
    await type(host, en.capacity, "1500");
    await submit(host, en.vehicles);
    expect(host.textContent).toContain(en.changedElsewhere);
    expect(getJson.mock.calls.length).toBeGreaterThan(readsBefore);
  });

  it("offers a retry when setup fails to load", async () => {
    getJson.mockRejectedValue(new Error("Network dropped"));
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Network dropped");
    serve({});
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((item) => item.textContent === en.retryLoad)
        ?.click();
    });
    await flush();
    expect(host.textContent).toContain(en.setupProgress(0, 4));
  });

  it("echoes typed kilograms and names bad whole numbers", async () => {
    serve({});
    await render();
    await type(host, en.targetLoad, "6,000");
    expect(host.textContent).toContain(en.kgEcho("6,000 kg"));
    await type(host, en.policyName, "Default");
    await type(host, en.maxDiversion, "2.5");
    await type(host, en.cutoff, "18:00");
    await submit(host, en.policy);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.wholeNumber(en.maxDiversion));
    expect(postJson).not.toHaveBeenCalled();
  });

  it("locks the fields while a save is in flight, so nothing typed meanwhile is overwritten", async () => {
    serve({ timezone: "Africa/Nairobi", policy });
    const save = deferred<DispatchPolicySummary>();
    postJson.mockReturnValueOnce(save.promise);
    await render();
    await type(host, en.targetLoad, "6500");
    await submit(host, en.policy);
    expect(field(host, en.maxWait).matches(":disabled")).toBe(true);
    expect(field(host, en.targetLoad).matches(":disabled")).toBe(true);
    await act(async () => save.resolve({ ...policy, version: 3, targetLoadGrams: "6500000" }));
    await flush();
    expect(field(host, en.maxWait).matches(":disabled")).toBe(false);
    expect(field(host, en.targetLoad).value).toBe("6500");

    const tzSave = deferred<unknown>();
    patchJson.mockReturnValueOnce(tzSave.promise);
    await type(host, en.timezone, "Africa/Kampala");
    await submit(host, en.timezone);
    expect(field(host, en.timezone).matches(":disabled")).toBe(true);
    await act(async () =>
      tzSave.resolve({ businessId: "shop-a", timezone: "Africa/Kampala", viewerCanManage: true })
    );
    await flush();

    const vehicleSave = deferred<VehicleSummary>();
    postJson.mockReturnValueOnce(vehicleSave.promise);
    await type(host, en.vehicleName, "Van");
    await type(host, en.capacity, "1500");
    await submit(host, en.vehicles);
    expect(field(host, en.capacity).matches(":disabled")).toBe(true);
    await act(async () => vehicleSave.resolve(vehicle));
    await flush();
    expect(field(host, en.capacity).matches(":disabled")).toBe(false);
  });

  it("keeps a policy revision retry on the same key across a refresh", async () => {
    serve({ timezone: "Africa/Nairobi", policy });
    postJson.mockRejectedValueOnce(new Error("Network dropped"));
    postJson.mockResolvedValueOnce({ ...policy, version: 3, targetLoadGrams: "6500000" });
    await render();
    await type(host, en.targetLoad, "6500");
    await submit(host, en.policy);
    // The lost request did land: a refresh now shows version 3, but the owner's draft is kept.
    serve({ timezone: "Africa/Nairobi", policy: { ...policy, id: "policy-row-3", version: 3 } });
    await act(async () => {
      await invalidateApiCacheForMutation(`${base}/policies`);
    });
    await flush();
    expect(field(host, en.targetLoad).value).toBe("6500");
    await submit(host, en.policy);
    const keys = postJson.mock.calls.map(
      (call) => (call[2] as { idempotencyKey: string }).idempotencyKey
    );
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(postJson.mock.calls[1]?.[0]).toBe(`${base}/policies/policy-1/revisions`);
  });

  it("starts fresh when the open business changes, so a draft never crosses businesses", async () => {
    serve({ timezone: "Africa/Nairobi", policy });
    await render("shop-a");
    await type(host, en.targetLoad, "6500");
    await type(host, en.timezone, "Africa/Kampala");
    serve({});
    await act(async () => root.render(<FulfillmentSetupCard businessId="shop-b" />));
    await flush();
    expect(getJson).toHaveBeenCalledWith("/businesses/shop-b/fulfillment/settings");
    expect(field(host, en.targetLoad).value).toBe("");
    expect(field(host, en.timezone).value).toBe("");
    expect(host.textContent).toContain(en.setupProgress(0, 4));
  });

  it("shows nothing to roles that cannot read delivery setup at all", async () => {
    getJson.mockRejectedValue(new ApiRequestError(403, "Permission denied for this business."));
    await render();
    expect(host.querySelector(".fulfillment-setup-card")).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("sends the version the draft was based on, even after a refresh shows a newer one", async () => {
    serve({ timezone: "Africa/Nairobi", policy });
    postJson.mockResolvedValue({ ...policy, version: 4 });
    await render();
    await type(host, en.targetLoad, "6500");
    serve({ timezone: "Africa/Nairobi", policy: { ...policy, id: "policy-row-3", version: 3 } });
    await act(async () => {
      await invalidateApiCacheForMutation(`${base}/policies`);
    });
    await flush();
    await submit(host, en.policy);
    expect(postJson).toHaveBeenCalledWith(
      `${base}/policies/policy-1/revisions`,
      expect.objectContaining({
        targetLoadGrams: "6500000",
        expectedVersion: 2,
        expectedDefaultPolicyId: "policy-1"
      }),
      { idempotencyKey: expect.any(String) }
    );
  });

  it("shows the newer rules instead of overwriting them when someone else saved first", async () => {
    serve({ timezone: "Africa/Nairobi", policy });
    postJson.mockRejectedValueOnce(
      new ApiRequestError(409, "changed", { code: "dispatch_policy_version_conflict" })
    );
    await render();
    await type(host, en.targetLoad, "6500");
    // An agent revised the rules to 9,000 kg over MCP while the owner was typing.
    serve({
      timezone: "Africa/Nairobi",
      policy: { ...policy, id: "policy-row-3", version: 3, targetLoadGrams: "9000000" }
    });
    await submit(host, en.policy);
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.changedSinceOpened);
    expect(field(host, en.targetLoad).value).toBe("9000");
    expect(host.textContent).toContain(en.policyVersion(3));
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it("sends the timezone it was based on and shows the newer one on conflict", async () => {
    serve({ timezone: "Africa/Nairobi" });
    patchJson.mockRejectedValueOnce(
      new ApiRequestError(409, "changed", { code: "timezone_changed" })
    );
    await render();
    await type(host, en.timezone, "Africa/Kampala");
    serve({ timezone: "Africa/Dar_es_Salaam" });
    await submit(host, en.timezone);
    await flush();
    expect(patchJson).toHaveBeenCalledWith(`${base}/settings`, {
      timezone: "Africa/Kampala",
      expectedTimezone: "Africa/Nairobi"
    });
    expect(field(host, en.timezone).value).toBe("Africa/Dar_es_Salaam");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.changedSinceOpened);
  });

  it("retries a lost first create as the same create, not a second version", async () => {
    serve({});
    postJson
      .mockRejectedValueOnce(new Error("Network dropped"))
      .mockResolvedValueOnce({ ...policy, version: 1 });
    await render();
    await type(host, en.policyName, "Default");
    await type(host, en.targetLoad, "6000");
    await type(host, en.maxDiversion, "2000");
    await type(host, en.cutoff, "18:00");
    await type(host, en.maxWait, "72");
    await type(host, en.leadDays, "1");
    await submit(host, en.policy);
    // The create did commit; a refresh now shows the policy it made.
    serve({ policy: { ...policy, version: 1 } });
    await act(async () => {
      await invalidateApiCacheForMutation(`${base}/vehicles`);
    });
    await flush();
    await submit(host, en.policy);
    const [first, second] = postJson.mock.calls;
    expect(second?.[0]).toBe(`${base}/policies`);
    expect(second?.[2]).toEqual(first?.[2]);
  });

  it("will not save a corridor while a GPS point is still arriving", async () => {
    serve({});
    let deliver!: (position: GeolocationPosition) => void;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (success: (position: GeolocationPosition) => void) => {
          deliver = success;
        }
      }
    });
    await render();
    await type(host, en.corridorName, "Thika Road");
    await type(host, en.origin, "Depot");
    await type(host, en.destination, "Thika");
    await type(host, en.routePoints, "-1.2921, 36.8219");
    await act(async () => button(host, en.addGpsPoint).click());
    expect(button(host, en.addCorridor).disabled).toBe(true);
    await submit(host, en.corridors);
    expect(postJson).not.toHaveBeenCalled();
    await act(async () =>
      deliver({ coords: { latitude: -1.0333, longitude: 37.0693 } } as GeolocationPosition)
    );
    await flush();
    expect(field(host, en.routePoints).value).toBe("-1.2921, 36.8219\n-1.033300, 37.069300");
    expect(button(host, en.addCorridor).disabled).toBe(false);
  });

  it("says so when a refresh fails after the card has loaded", async () => {
    serve({ timezone: "Africa/Nairobi", policy });
    await render();
    getJson.mockRejectedValue(new Error("Network dropped"));
    await act(async () => {
      await invalidateApiCacheForMutation(`${base}/manifests`);
    });
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.refreshFailed);
    expect(field(host, en.targetLoad).value).toBe("6000");
  });

  it("reads what it edits uncached, never through the shared stale-while-revalidate cache", () => {
    const source = readFileSync("apps/web/src/FulfillmentSetupCard.tsx", "utf8");
    expect(source).toContain("fetchFreshJson");
    expect(source).not.toMatch(/\bgetJson\b/u);
  });

  it("revises the policy the draft was based on, asserting it is still the default", async () => {
    serve({ timezone: "Africa/Nairobi", policy });
    postJson.mockRejectedValueOnce(
      new ApiRequestError(409, "changed", { code: "default_policy_changed" })
    );
    await render();
    await type(host, en.targetLoad, "6500");
    // An agent created policy B over MCP and made it the default; a refresh shows it.
    const other = { ...policy, id: "row-b1", policyId: "policy-b", version: 2, name: "Busy" };
    serve({ timezone: "Africa/Nairobi", policy: other });
    await act(async () => {
      await invalidateApiCacheForMutation(`${base}/policies`);
    });
    await flush();
    await submit(host, en.policy);
    // Never "policy-b": the owner's draft is about policy-1, and the server refuses it because
    // policy-1 is no longer the default.
    expect(postJson).toHaveBeenCalledWith(
      `${base}/policies/policy-1/revisions`,
      expect.objectContaining({ expectedVersion: 2, expectedDefaultPolicyId: "policy-1" }),
      { idempotencyKey: expect.any(String) }
    );
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.changedSinceOpened);
    expect(field(host, en.policyName).value).toBe("Busy");
  });

  it("locks the form while a conflict reload is in flight", async () => {
    serve({ timezone: "Africa/Nairobi", policy });
    postJson.mockRejectedValueOnce(
      new ApiRequestError(409, "changed", { code: "dispatch_policy_version_conflict" })
    );
    await render();
    await type(host, en.targetLoad, "6500");
    const pendingReload = deferred<unknown>();
    getJson.mockImplementation(() => pendingReload.promise);
    await submit(host, en.policy);
    expect(field(host, en.targetLoad).matches(":disabled")).toBe(true);
    expect(field(host, en.timezone).matches(":disabled")).toBe(true);
    serve({ timezone: "Africa/Nairobi", policy: { ...policy, version: 3 } });
    await act(async () => pendingReload.resolve(undefined));
    // The in-flight Promise.all rejects on the undefined settings; a fresh reload follows.
    await act(async () => {
      await invalidateApiCacheForMutation(`${base}/policies`);
    });
    await flush();
    expect(field(host, en.targetLoad).matches(":disabled")).toBe(false);
  });

  it("stays locked and explained when the reload after a conflict fails", async () => {
    serve({ timezone: "Africa/Nairobi", policy });
    postJson.mockRejectedValueOnce(
      new ApiRequestError(409, "changed", { code: "dispatch_policy_version_conflict" })
    );
    await render();
    await type(host, en.targetLoad, "6500");
    getJson.mockRejectedValue(new Error("Network dropped"));
    await submit(host, en.policy);
    await flush();
    // The form still shows the rejected draft, so it must not look saveable or clean.
    expect(field(host, en.targetLoad).matches(":disabled")).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      `${en.changedSinceOpened} ${en.refreshFailed}`
    );
    serve({
      timezone: "Africa/Nairobi",
      policy: { ...policy, version: 3, targetLoadGrams: "9000000" }
    });
    await act(async () => button(host, en.retryLoad).click());
    await flush();
    expect(field(host, en.targetLoad).matches(":disabled")).toBe(false);
    expect(field(host, en.targetLoad).value).toBe("9000");
  });

  it("clears the refresh warning once a refresh succeeds, and offers a retry", async () => {
    serve({ timezone: "Africa/Nairobi", policy });
    await render();
    getJson.mockRejectedValue(new Error("Network dropped"));
    await act(async () => {
      await invalidateApiCacheForMutation(`${base}/manifests`);
    });
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.refreshFailed);
    serve({ timezone: "Africa/Nairobi", policy });
    await act(async () => button(host, en.retryLoad).click());
    await flush();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("has Swahili copy for every new string", () => {
    const sw = fulfillmentCopy("sw");
    expect(Object.keys(sw).sort()).toEqual(Object.keys(en).sort());
    expect(sw.setupHeading).not.toBe(en.setupHeading);
    expect(sw.fallback.TRY_SMALLER_VEHICLE).not.toBe(en.fallback.TRY_SMALLER_VEHICLE);
  });
});

describe("corridor route input", () => {
  it("parses latitude, longitude lines into [longitude, latitude] pairs", () => {
    expect(parseRoutePoints(" -1.3, 36.8 \n\n-1.2 36.8\n-1.1;36.9")).toEqual({
      ok: true,
      geometry: {
        type: "LineString",
        coordinates: [
          [36.8, -1.3],
          [36.8, -1.2],
          [36.9, -1.1]
        ]
      }
    });
  });

  it("names the failing line and the reason", () => {
    expect(parseRoutePoints("-1.3, 36.8")).toEqual({ ok: false, line: null, reason: "too_few" });
    expect(parseRoutePoints("")).toEqual({ ok: false, line: null, reason: "too_few" });
    expect(parseRoutePoints("-1.3, 36.8\n91, 36.8")).toEqual({
      ok: false,
      line: 2,
      reason: "range"
    });
    expect(parseRoutePoints("-1.3, 36.8\n-1.2, 181")).toEqual({
      ok: false,
      line: 2,
      reason: "range"
    });
    expect(parseRoutePoints("-1.3, 36.8\nThika")).toEqual({ ok: false, line: 2, reason: "format" });
    expect(parseRoutePoints("-1.3, 36.8, 5\n-1.2, 36.8")).toEqual({
      ok: false,
      line: 1,
      reason: "format"
    });
  });

  it("appends a GPS point as a new line", () => {
    expect(appendRoutePoint("", -1.2921, 36.8219)).toBe("-1.292100, 36.821900");
    expect(appendRoutePoint("-1.3, 36.8\n", -1.2, 36.8)).toBe("-1.3, 36.8\n-1.200000, 36.800000");
  });
});
