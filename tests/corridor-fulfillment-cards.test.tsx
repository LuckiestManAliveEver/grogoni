// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ActivePoolsSummary,
  CorridorMatchResultSummary,
  ManifestSummary,
  ShopLocationStatusSummary,
  VehicleSummary
} from "@grogoni/shared-types";

const getJson = vi.fn();
const postJson = vi.fn();
const putJson = vi.fn();

vi.mock("../apps/web/src/api-helpers", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
  fetchFreshJson: (...args: unknown[]) => getJson(...args),
  postJson: (...args: unknown[]) => postJson(...args),
  putJson: (...args: unknown[]) => putJson(...args)
}));

const { default: CorridorDispatchCard } = await import("../apps/web/src/CorridorDispatchCard");
const { default: DriverManifestsCard } = await import("../apps/web/src/DriverManifestsCard");
const { ApiRequestError } = await import("../apps/web/src/lib/api");
const { default: ShopLocationCard } = await import("../apps/web/src/ShopLocationCard");
const { fulfillmentCopy, formatDurationSeconds } = await import("../apps/web/src/fulfillment-copy");

const base = "/businesses/shop-a/fulfillment";
const at = new Date(0).toISOString();

const pools: ActivePoolsSummary = {
  businessId: "shop-a",
  timezone: "Africa/Nairobi",
  generatedAt: at,
  pools: [
    {
      corridorId: "corridor-x",
      corridorName: "Corridor X",
      corridorActive: true,
      geometryVersion: 2,
      policy: { policyId: "policy-1", version: 1, cutoffLocalTime: "18:00", maxWaitHours: 72 },
      eligibleOrderCount: 3,
      eligibleTotalWeightGrams: "6000000",
      allocatableWeightGrams: "5100000",
      targetLoadGrams: "6000000",
      minimumDispatchLoadGrams: null,
      percentFilled: 85,
      oldestWaitingOrderConfirmedAt: at,
      oldestWaitingOrderAgeSeconds: 7_200,
      nextCutoffAt: at,
      timeUntilCutoffSeconds: 5_400,
      readiness: "ACCUMULATING",
      needsResolution: true,
      unresolvedWeightCount: 1,
      unresolvedLocationCount: 0,
      staleResolutionCount: 1
    } as ActivePoolsSummary["pools"][number]
  ],
  unassigned: {
    orderCount: 2,
    unresolvedLocationCount: 1,
    noCorridorCount: 1,
    unresolvedWeightCount: 0,
    pendingIntakeCount: 0,
    orphanedCount: 0
  }
};

const vehicle: VehicleSummary = {
  id: "truck-7",
  businessId: "shop-a",
  name: "7-tonne truck",
  registration: null,
  capacityGrams: "7000000",
  active: true,
  createdBy: "owner",
  createdAt: at,
  updatedAt: at
};

function manifest(status: ManifestSummary["status"]): ManifestSummary {
  return {
    id: "manifest-1",
    businessId: "shop-a",
    corridorId: "corridor-x",
    corridorGeometryVersion: 2,
    policyId: "policy-1",
    policyVersion: 1,
    vehicleId: "truck-7",
    vehicleCapacityGrams: "7000000",
    status,
    totalWeightGrams: "900000",
    plannedDepartureAt: null,
    closedAt: null,
    completedAt: null,
    createdBy: "owner",
    createdAt: at,
    updatedAt: at,
    driverUserId: null,
    driverName: null,
    stops: [
      {
        id: "stop-1",
        manifestId: "manifest-1",
        invoiceId: "invoice-a",
        fulfillmentOrderId: "order-a",
        customerId: "shop-1",
        customerName: "Shop A",
        sequence: 1,
        distanceAlongMeters: 5_000,
        diversionMeters: 110,
        latitude: -1.25,
        longitude: 36.801,
        orderWeightGrams: "900000",
        items: [{ productName: "Cooking oil", quantity: 2 }],
        payOnDeliveryAmount: 1250,
        allocationActive: true,
        deliveryStatus: "PENDING",
        deliveryNote: null,
        releaseReason: null,
        deliveryRecordedAt: null
      }
    ]
  };
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
  if (found === undefined) throw new Error(`No button "${label}"`);
  return found;
}

describe("corridor fulfillment cards", () => {
  const en = fulfillmentCopy("en");
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
    putJson.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function render(node: React.ReactNode) {
    await act(async () => {
      root = createRoot(host);
      root.render(node);
    });
    await flush();
  }

  it("shows server-computed readiness, exact kilograms and never-hidden unassigned orders", async () => {
    getJson.mockImplementation(async (path: string) =>
      path.endsWith("/pools") ? pools : path.endsWith("/vehicles") ? [vehicle] : []
    );
    await render(<CorridorDispatchCard businessId="shop-a" />);
    const text = host.textContent ?? "";
    expect(text).toContain("Corridor X · Filling");
    expect(text).toContain("6,000 kg of 6,000 kg · 3 orders");
    expect(text).toContain(en.staleCount(1));
    expect(text).toContain(en.unknownWeightCount(1));
    expect(text).toContain(en.cutoffIn("1h 30m"));
    expect(text).toContain(`${en.unassigned} · 2 orders`);
    expect(host.querySelector("progress")?.getAttribute("value")).toBe("85");
  });

  it("creates a manifest only on the dispatcher's explicit action and reports what did not fit", async () => {
    getJson.mockImplementation(async (path: string) =>
      path.endsWith("/pools") ? pools : path.endsWith("/vehicles") ? [vehicle] : []
    );
    postJson.mockResolvedValue({
      manifest: manifest("OPEN"),
      allocatedInvoiceIds: ["invoice-a"],
      skippedInvoiceIds: ["invoice-b"],
      requiresPlanningInvoiceIds: []
    });
    await render(<CorridorDispatchCard businessId="shop-a" />);
    expect(postJson).not.toHaveBeenCalled();
    await act(async () => button(host, en.createManifest).click());
    await flush();
    expect(postJson).toHaveBeenCalledWith(`${base}/manifests`, {
      corridorId: "corridor-x",
      vehicleId: "truck-7"
    });
    expect(host.textContent).toContain(en.created(1, 1, 0));
    expect(host.textContent).toContain("1. Shop A · 900 kg · Pending");
  });

  it("requires a reason before recording a failed delivery on a closed manifest", async () => {
    getJson.mockImplementation(async (path: string) =>
      path.endsWith("/pools") ? pools : path.endsWith("/manifests") ? [manifest("CLOSED")] : []
    );
    const failed = manifest("COMPLETED");
    failed.stops[0] = {
      ...failed.stops[0]!,
      allocationActive: false,
      deliveryStatus: "FAILED",
      releaseReason: "DELIVERY_FAILED"
    };
    postJson.mockResolvedValue(failed);
    await render(<CorridorDispatchCard businessId="shop-a" />);
    await act(async () => button(host, en.failed).click());
    await flush();
    expect(postJson).not.toHaveBeenCalled();
    expect(host.textContent).toContain(en.noteRequired);

    const note = host.querySelector<HTMLInputElement>(`input[aria-label="${en.note}"]`)!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(note, "Shop closed");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(host, en.failed).click());
    await flush();
    expect(postJson).toHaveBeenCalledWith(`${base}/manifests/manifest-1/stops/stop-1/delivery`, {
      outcome: "FAILED",
      note: "Shop closed"
    });
    expect(host.textContent).toContain(en.released);
  });

  it("captures the device GPS fix for a shop and shows the server's corridor decision", async () => {
    const unresolved: ShopLocationStatusSummary = {
      businessId: "shop-a",
      customerId: "shop-1",
      locationStatus: "UNRESOLVED",
      coordinatesRedacted: false,
      current: null
    } as ShopLocationStatusSummary;
    const saved = {
      ...unresolved,
      locationStatus: "RESOLVED",
      current: {
        id: "loc-1",
        businessId: "shop-a",
        customerId: "shop-1",
        latitude: -1.25,
        longitude: 36.801,
        accuracyMeters: 8,
        capturedAt: at,
        capturedBy: "agent",
        supersededAt: null
      }
    } as ShopLocationStatusSummary;
    const match: CorridorMatchResultSummary = {
      status: "RESOLVED",
      shopLocationId: "loc-1",
      selected: {
        corridorId: "corridor-x",
        corridorName: "Corridor X",
        geometryVersion: 1,
        diversionMeters: 111.2,
        distanceAlongMeters: 5_000,
        segmentIndex: 0,
        maxDiversionMeters: 2_000
      },
      alternatives: [],
      reason: "SINGLE_MATCH" as never
    };
    let located = false;
    getJson.mockImplementation(async (path: string) =>
      path.endsWith("/corridor-match")
        ? located
          ? match
          : { status: "UNRESOLVED", shopLocationId: null, reason: "NO_LOCATION", nearest: null }
        : unresolved
    );
    putJson.mockImplementation(async () => {
      located = true;
      return saved;
    });
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (success: PositionCallback) =>
          success({
            coords: { latitude: -1.25, longitude: 36.801, accuracy: 8 }
          } as GeolocationPosition)
      }
    });

    await render(<ShopLocationCard businessId="shop-a" customerId="shop-1" />);
    expect(host.textContent).toContain(en.noLocation);
    expect(host.textContent).toContain(en.noCorridor);
    await act(async () => button(host, en.capture).click());
    await flush();
    expect(putJson).toHaveBeenCalledWith(`${base}/shops/shop-1/location`, {
      latitude: -1.25,
      longitude: 36.801,
      accuracyMeters: 8
    });
    expect(host.textContent).toContain(en.savedLocation);
    expect(host.textContent).toContain(en.onCorridor("Corridor X", 111.2));
    expect(host.textContent).toContain(en.accuracy(8));
  });

  it("assigns a manifest to a driver from the dispatch card", async () => {
    getJson.mockImplementation(async (path: string) =>
      path.endsWith("/pools")
        ? pools
        : path.endsWith("/vehicles")
          ? [vehicle]
          : path.endsWith("/manifests")
            ? [manifest("OPEN")]
            : path.endsWith("/drivers")
              ? [{ userId: "driver-1", displayName: "Otieno", role: "driver" }]
              : []
    );
    postJson.mockResolvedValue({
      ...manifest("OPEN"),
      driverUserId: "driver-1",
      driverName: "Otieno"
    });
    await render(<CorridorDispatchCard businessId="shop-a" />);
    const select = [...host.querySelectorAll("label")]
      .find((label) => (label.textContent ?? "").startsWith(en.assignDriver))
      ?.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
        select,
        "driver-1"
      );
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(postJson).toHaveBeenCalledWith(`${base}/manifests/manifest-1/driver`, {
      driverUserId: "driver-1"
    });
  });

  it("shows who is assigned, read-only, to someone who cannot assign drivers", async () => {
    getJson.mockImplementation(async (path: string) => {
      if (path.endsWith("/drivers")) throw new ApiRequestError(403, "Permission denied.");
      if (path.endsWith("/pools")) return pools;
      if (path.endsWith("/vehicles")) return [vehicle];
      if (path.endsWith("/manifests")) {
        return [{ ...manifest("OPEN"), driverUserId: "driver-1", driverName: "Otieno" }];
      }
      return [];
    });
    await render(<CorridorDispatchCard businessId="shop-a" />);
    expect(host.textContent).toContain(`${en.driver}: Otieno`);
    expect(host.textContent).not.toContain(en.driverLeft);
    expect(
      [...host.querySelectorAll("label")].some((label) =>
        (label.textContent ?? "").startsWith(en.assignDriver)
      )
    ).toBe(false);
  });

  it("tells a dispatcher when the drivers list fails, instead of silently hiding assignment", async () => {
    getJson.mockImplementation(async (path: string) => {
      if (path.endsWith("/drivers")) throw new ApiRequestError(500, "Server error.");
      if (path.endsWith("/pools")) return pools;
      if (path.endsWith("/vehicles")) return [vehicle];
      if (path.endsWith("/manifests")) return [manifest("OPEN")];
      return [];
    });
    await render(<CorridorDispatchCard businessId="shop-a" />);
    expect(host.textContent).toContain(en.driversUnavailable);
    // Retry reloads, and once the list loads the dispatcher can assign again.
    getJson.mockImplementation(async (path: string) => {
      if (path.endsWith("/drivers"))
        return [{ userId: "d1", displayName: "Otieno", role: "driver" }];
      if (path.endsWith("/pools")) return pools;
      if (path.endsWith("/vehicles")) return [vehicle];
      if (path.endsWith("/manifests")) return [manifest("OPEN")];
      return [];
    });
    await act(async () => button(host, en.retry).click());
    await flush();
    expect(host.textContent).not.toContain(en.driversUnavailable);
    expect(
      [...host.querySelectorAll("label")].some((label) =>
        (label.textContent ?? "").startsWith(en.assignDriver)
      )
    ).toBe(true);
  });

  it("shows nothing, not an error, to roles that cannot dispatch", async () => {
    getJson.mockRejectedValue(new ApiRequestError(403, "Permission denied."));
    await render(<CorridorDispatchCard businessId="shop-a" />);
    expect(host.textContent).toBe("");
  });

  it("gives a driver only their own trips, with road-ordered stops, Start route and outcomes", async () => {
    getJson.mockImplementation(async (path: string) =>
      path.endsWith("/my-manifests")
        ? [{ ...manifest("CLOSED"), driverUserId: "me", driverName: "Me" }]
        : []
    );
    postJson.mockResolvedValue({ ...manifest("DEPARTED"), driverUserId: "me", driverName: "Me" });
    await render(<DriverManifestsCard businessId="shop-a" showEmptyState={true} />);
    expect(host.textContent).toContain(en.myDeliveries);
    expect(host.textContent).toContain("1. Shop A");
    expect(host.querySelector('a[href*="google.com/maps"]')).not.toBeNull();
    await act(async () => button(host, en.depart).click());
    await flush();
    expect(postJson).toHaveBeenCalledWith(`${base}/manifests/manifest-1/depart`, {});
    // A failed stop needs a reason before anything is sent.
    postJson.mockClear();
    await act(async () => button(host, en.failed).click());
    expect(postJson).not.toHaveBeenCalled();
    expect(host.textContent).toContain(en.noteRequired);
    await act(async () => button(host, en.delivered).click());
    await flush();
    expect(postJson).toHaveBeenCalledWith(`${base}/manifests/manifest-1/stops/stop-1/delivery`, {
      outcome: "DELIVERED"
    });
  });

  it("shows a driver with no trips an empty state, and others nothing", async () => {
    getJson.mockResolvedValue([]);
    await render(<DriverManifestsCard businessId="shop-a" showEmptyState={true} />);
    expect(host.textContent).toContain(en.noAssignedTrips);
    act(() => root.unmount());
    await render(<DriverManifestsCard businessId="shop-a" showEmptyState={false} />);
    expect(host.textContent).toBe("");
    act(() => root.unmount());
    getJson.mockRejectedValue(
      new ApiRequestError(403, "Permission denied.", { code: "permission_denied" })
    );
    await render(<DriverManifestsCard businessId="shop-a" showEmptyState={false} />);
    expect(host.textContent).toBe("");
  });

  it("tells a removed driver they lost access instead of showing no trips", async () => {
    getJson.mockRejectedValue(
      new ApiRequestError(403, "You are no longer part of this shop.", {
        code: "membership_required"
      })
    );
    await render(<DriverManifestsCard businessId="shop-a" showEmptyState={true} />);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "no longer part of this shop"
    );
    expect(host.textContent).not.toContain(en.noAssignedTrips);
  });

  it("ships Swahili copy for every English string and mounts in the existing surfaces", () => {
    const sw = fulfillmentCopy("sw");
    expect(Object.keys(sw).sort()).toEqual(Object.keys(en).sort());
    expect(sw.readiness.DISPATCH_READY).not.toBe(en.readiness.DISPATCH_READY);
    expect(formatDurationSeconds(93_600)).toBe("1d 2h");
    expect(readFileSync("apps/web/src/LogisticsSurface.tsx", "utf8")).toContain(
      "<CorridorDispatchCard businessId={props.businessId} />"
    );
    expect(readFileSync("apps/web/src/CustomerSurface.tsx", "utf8")).toContain(
      "<ShopLocationCard businessId={props.businessId} customerId={props.form.id} />"
    );
  });
});
