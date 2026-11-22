// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ManifestStopSummary, ManifestSummary } from "@grogoni/shared-types";

const getJson = vi.fn();
const postJson = vi.fn();

vi.mock("../apps/web/src/api-helpers", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
  fetchFreshJson: (...args: unknown[]) => getJson(...args),
  postJson: (...args: unknown[]) => postJson(...args),
  putJson: vi.fn()
}));

const { counterpartShopId, kangaIdentity, shopInitials } =
  await import("../apps/web/src/kanga-identity");
const { currentManifestStopId, fulfillmentRoute, manifestStopState, manifestTripProgress } =
  await import("../apps/web/src/fulfillment-route");
const { fulfillmentCopy } = await import("../apps/web/src/fulfillment-copy");
const { shopSignCopy } = await import("../apps/web/src/shop-sign-copy");
const { ShopSign } = await import("../apps/web/src/ShopSign");
const { KangaAvatar } = await import("../apps/web/src/KangaAvatar");
const { FulfillmentRoute } = await import("../apps/web/src/FulfillmentRoute");
const { PoolLorryGauge } = await import("../apps/web/src/PoolLorryGauge");
const { default: DriverManifestsCard } = await import("../apps/web/src/DriverManifestsCard");

const en = fulfillmentCopy("en");
const sw = fulfillmentCopy("sw");
const at = new Date(0).toISOString();

function stop(
  id: string,
  sequence: number,
  deliveryStatus: ManifestStopSummary["deliveryStatus"],
  allocationActive = true
): ManifestStopSummary {
  return {
    id,
    manifestId: "manifest-1",
    invoiceId: `invoice-${id}`,
    fulfillmentOrderId: `order-${id}`,
    customerId: `customer-${id}`,
    customerName: `Shop ${id}`,
    sequence,
    distanceAlongMeters: sequence * 1_000,
    diversionMeters: 50,
    latitude: -1.25,
    longitude: 36.8,
    orderWeightGrams: "100000",
    items: [],
    payOnDeliveryAmount: null,
    allocationActive,
    deliveryStatus,
    deliveryNote: null,
    releaseReason: null,
    deliveryRecordedAt: null
  };
}

function manifest(
  status: ManifestSummary["status"],
  stops: ManifestStopSummary[]
): ManifestSummary {
  return {
    id: "manifest-1",
    businessId: "shop-a",
    corridorId: "corridor-x",
    corridorGeometryVersion: 1,
    policyId: "policy-1",
    policyVersion: 1,
    vehicleId: "truck-7",
    vehicleCapacityGrams: "7000000",
    status,
    totalWeightGrams: "300000",
    plannedDepartureAt: null,
    closedAt: null,
    completedAt: null,
    createdBy: "owner",
    createdAt: at,
    updatedAt: at,
    driverUserId: "me",
    driverName: "Me",
    stops
  };
}

describe("Design D5: kanga shop identity", () => {
  it("is deterministic per shop id and only uses the four motifs", () => {
    expect(kangaIdentity("shop-123")).toEqual(kangaIdentity("shop-123"));
    const motifs = new Set(
      Array.from({ length: 200 }, (_, index) => kangaIdentity(`shop-${index}`).motif)
    );
    expect([...motifs].sort()).toEqual(["almasi", "madoa", "mistari", "mshazari"]);
    for (let index = 0; index < 50; index += 1) {
      const identity = kangaIdentity(`business-${index}`);
      expect(identity.ink).toMatch(/^#[0-9a-f]{6}$/u);
      expect(identity.ground).toMatch(/^#[0-9a-f]{6}$/u);
      expect(identity.ink).not.toBe(identity.ground);
    }
  });

  it("takes up to two initials from the shop name", () => {
    expect(shopInitials("Mama Njeri's Duka")).toBe("MN");
    expect(shopInitials("  baraka  ")).toBe("B");
    expect(shopInitials("'Jirani' Kiosk")).toBe("JK");
    expect(shopInitials("")).toBe("?");
    expect(shopInitials("— ·")).toBe("?");
  });

  it("only picks the other side's shop in a BUSINESS conversation", () => {
    const business = { conversationType: "BUSINESS", activeShopId: "shop-b" } as const;
    expect(counterpartShopId(business, null)).toBe("shop-b");
    expect(counterpartShopId(business, "shop-a")).toBe("shop-b");
    // The shop's own staff see their customers on the other side, so no shop pattern.
    expect(counterpartShopId(business, "shop-b")).toBeNull();
    expect(counterpartShopId({ conversationType: "DIRECT", activeShopId: "shop-b" }, null)).toBe(
      null
    );
    expect(counterpartShopId({ conversationType: "BUSINESS", activeShopId: null }, null)).toBe(
      null
    );
    expect(counterpartShopId({ activeShopId: "shop-b" }, null)).toBeNull();
    expect(counterpartShopId(undefined, null)).toBeNull();
  });
});

describe("Design D2: matatu route model", () => {
  it("walks a delivery through received, ready, on the way and delivered", () => {
    const pending = fulfillmentRoute("pending", "delivery", en);
    expect(pending.stops.map((item) => item.label)).toEqual([
      "Received",
      "Ready",
      "On the way",
      "Delivered"
    ]);
    expect(pending.stops.map((item) => item.reached)).toEqual([true, false, false, false]);
    expect(pending.position).toBe(0);
    expect(pending.moving).toBe(false);

    const onTheWay = fulfillmentRoute("out_for_delivery", "delivery", en);
    expect(onTheWay.stops.map((item) => item.current)).toEqual([false, false, true, false]);
    expect(onTheWay.position).toBeCloseTo(2 / 3);
    expect(onTheWay.moving).toBe(true);
    expect(onTheWay.statusLabel).toBe("Out for delivery");

    const done = fulfillmentRoute("completed", "delivery", en);
    expect(done.stops.every((item) => item.reached)).toBe(true);
    expect(done.position).toBe(1);
  });

  it("gives pickups three stops ending in collected, and never a moving vehicle", () => {
    const ready = fulfillmentRoute("ready", "pickup", en);
    expect(ready.stops.map((item) => item.label)).toEqual(["Received", "Ready", "Collected"]);
    expect(ready.position).toBe(0.5);
    expect(ready.moving).toBe(false);
    expect(fulfillmentRoute("completed", "pickup", en).position).toBe(1);
  });

  it("shows a cancelled record with no invented progress", () => {
    const cancelled = fulfillmentRoute("cancelled", "delivery", en);
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.stops.some((item) => item.reached)).toBe(false);
    expect(cancelled.position).toBe(0);
    expect(cancelled.moving).toBe(false);
  });

  it("has Swahili labels for every stop and status", () => {
    expect(fulfillmentRoute("out_for_delivery", "delivery", sw).stops.map((s) => s.label)).toEqual([
      "Imepokelewa",
      "Tayari",
      "Njiani",
      "Imefika"
    ]);
    expect(fulfillmentRoute("completed", "pickup", sw).stops.at(-1)?.label).toBe("Imechukuliwa");
    expect(Object.keys(sw.fulfillmentStatus).sort()).toEqual(
      Object.keys(en.fulfillmentStatus).sort()
    );
  });
});

describe("Design D4: manifest route model", () => {
  it("puts the vehicle on the arrived stop, else the next pending one, only once departed", () => {
    const stops = [
      stop("a", 1, "DELIVERED"),
      stop("b", 2, "FAILED"),
      stop("c", 3, "PENDING"),
      stop("d", 4, "PENDING")
    ];
    expect(currentManifestStopId(manifest("CLOSED", stops))).toBeNull();
    expect(currentManifestStopId(manifest("DEPARTED", stops))).toBe("c");
    const arrived = [stop("a", 1, "PENDING"), stop("b", 2, "ARRIVED")];
    expect(currentManifestStopId(manifest("DEPARTED", arrived))).toBe("b");
    // Road order comes from sequence, not array order; released stops are skipped.
    const shuffled = [
      stop("late", 5, "PENDING"),
      stop("gone", 1, "PENDING", false),
      stop("x", 2, "PENDING")
    ];
    expect(currentManifestStopId(manifest("DEPARTED", shuffled))).toBe("x");
    expect(currentManifestStopId(manifest("DEPARTED", [stop("a", 1, "DELIVERED")]))).toBeNull();
  });

  it("counts final outcomes over the stops still on the trip", () => {
    const progress = manifestTripProgress(
      manifest("DEPARTED", [
        stop("a", 1, "DELIVERED"),
        stop("b", 2, "SKIPPED"),
        stop("c", 3, "ARRIVED"),
        stop("d", 4, "PENDING", false)
      ])
    );
    expect(progress).toEqual({ done: 2, total: 3 });
    expect(manifestStopState(stop("d", 4, "PENDING", false))).toBe("RELEASED");
    expect(manifestStopState(stop("a", 1, "FAILED"))).toBe("FAILED");
  });
});

describe("Design D components", () => {
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
    await act(async () => {
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });
  }

  it("shows a read-only shop sign to customers", async () => {
    const copy = shopSignCopy("en");
    await render(<ShopSign status="private" compact />);
    const sign = host.querySelector('[role="img"]');
    expect(sign?.getAttribute("aria-label")).toBe(copy.status(copy.meaning.private));
    expect(host.textContent).toBe("PRIVATE");
    expect(host.querySelector("button")).toBeNull();
  });

  it("lets the owner pick a status from all three, without a blind cycle", async () => {
    const copy = shopSignCopy("en");
    const onChange = vi.fn();
    await render(<ShopSign status="online" onChange={onChange} />);
    const sign = host.querySelector<HTMLButtonElement>(".shop-sign-button");
    expect(sign?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => sign?.click());
    expect(sign?.getAttribute("aria-expanded")).toBe("true");
    const choices = [...host.querySelectorAll<HTMLButtonElement>(".shop-sign-choice")];
    expect(choices.map((choice) => choice.textContent)).toEqual([
      `OPEN${copy.meaning.online}`,
      `PRIVATE${copy.meaning.private}`,
      `CLOSED${copy.meaning.offline}`
    ]);
    expect(choices[0]?.getAttribute("aria-pressed")).toBe("true");
    // Choosing the current status sends nothing.
    await act(async () => choices[0]?.click());
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => sign?.click());
    await act(async () =>
      host.querySelectorAll<HTMLButtonElement>(".shop-sign-choice")[2]?.click()
    );
    expect(onChange).toHaveBeenCalledWith("offline");
    expect(host.querySelector(".shop-sign-choices")).toBeNull();
  });

  it("has Swahili shop-sign plates", () => {
    expect(shopSignCopy("sw").plate).toEqual({
      online: "FUNGUA",
      private: "BINAFSI",
      offline: "IMEFUNGWA"
    });
  });

  it("draws a kanga avatar with the shop's initials, hidden from assistive technology", async () => {
    await render(<KangaAvatar className="conversation-avatar" shopId="shop-b" name="Mama Njeri" />);
    const avatar = host.querySelector(".kanga-avatar");
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(avatar?.getAttribute("data-kanga-motif")).toBe(kangaIdentity("shop-b").motif);
    expect(avatar?.textContent).toBe("MN");
    expect((avatar as HTMLElement | null)?.style.getPropertyValue("--kanga-ink")).toBe(
      kangaIdentity("shop-b").ink
    );
  });

  it("labels the delivery route with its status", async () => {
    await render(<FulfillmentRoute status="out_for_delivery" method="delivery" />);
    const route = host.querySelector(".fulfillment-route");
    expect(route?.getAttribute("role")).toBe("img");
    expect(route?.getAttribute("aria-label")).toBe(en.routeProgress("Out for delivery"));
    expect(route?.classList.contains("moving")).toBe(true);
    expect(host.querySelectorAll(".fulfillment-route-pin.reached")).toHaveLength(3);
  });

  it("keeps the pool load as a native progress value behind the lorry picture", async () => {
    await render(<PoolLorryGauge percentFilled={132} readiness="DISPATCH_READY" />);
    expect(host.querySelector("progress")?.getAttribute("value")).toBe("100");
    expect(host.querySelector(".pool-lorry")?.getAttribute("data-readiness")).toBe(
      "DISPATCH_READY"
    );
    expect(host.querySelector(".pool-lorry-picture")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("marks a departed driver trip's current stop and keeps the stop text intact", async () => {
    getJson.mockImplementation(async (path: string) =>
      path.endsWith("/my-manifests")
        ? [manifest("DEPARTED", [stop("a", 1, "DELIVERED"), stop("b", 2, "PENDING")])]
        : []
    );
    await render(<DriverManifestsCard businessId="shop-a" showEmptyState={true} />);
    const items = [...host.querySelectorAll(".manifest-route > li")];
    expect(items.map((item) => item.getAttribute("data-delivery-status"))).toEqual([
      "DELIVERED",
      "PENDING"
    ]);
    expect(items[1]?.getAttribute("aria-current")).toBe("step");
    expect(items[1]?.querySelector(".manifest-stop-marker.current svg")).not.toBeNull();
    expect(items[0]?.getAttribute("aria-current")).toBeNull();
    expect(host.textContent).toContain("2. Shop b · 100 kg · Pending");
    expect(host.querySelector(".manifest-trip-strip")?.getAttribute("aria-label")).toBe(
      en.tripProgress(1, 2)
    );
  });
});

describe("Design D wiring", () => {
  const chatSurface = readFileSync("apps/web/src/ChatSurface.tsx", "utf8");
  const listPanel = readFileSync("apps/web/src/ConversationListPanel.tsx", "utf8");

  it("shows the owner's sign only in their own shop's chats, through the existing presence update", () => {
    expect(chatSurface).toContain(
      "<ShopSign status={shopPresenceStatus} onChange={onStatusChange} />"
    );
    expect(chatSurface).toContain("selectedConversation.activeShopId === businessId;");
  });

  it("passes the viewer's own shop to the inbox so its customer chats keep person avatars", () => {
    expect(chatSurface).toContain("ownBusinessId: businessId,");
    expect(listPanel).toContain("counterpartShopId(props.conversation, props.ownBusinessId)");
  });
});
