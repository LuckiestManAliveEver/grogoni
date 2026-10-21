import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import type {
  BuyFeedSummary,
  NetworkGraphSummary,
  ProductCaptureJobSummary,
  StatusBroadcastSummary,
  UnifiedCheckoutSummary
} from "../packages/shared-types/src";

const onePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZCr8AAAAASUVORK5CYII=";

describe("unified buy feed and checkout", () => {
  it("merges catalogue and contact results, ranks contacts at comparable relevance, and checks out across sources honestly", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });

    const seller = await createOwnerBusiness(app, "254700000701", "Farm Fresh");
    await postJson(
      app,
      `/businesses/${seller.business.id}/products`,
      { name: "Mangoes", unit: "kg", quantity: 20, buyingPrice: 100, sellingPrice: 200 },
      seller.cookie
    );

    const buyer = await createOwnerBusiness(app, "254700000702", "Buyer Co");

    // Seller syncs the buyer as a phone contact, then posts a status with a confirmed item.
    const sellerGraph = await postJson<NetworkGraphSummary>(
      app,
      "/network/sync/contacts",
      { contacts: [{ name: "Buyer Person", phone: "+254700000702" }] },
      seller.cookie
    );
    const buyerNode = sellerGraph.nodes.find((node) => node.displayName === "Buyer Person")!;
    const job = await postJson<ProductCaptureJobSummary>(
      app,
      `/businesses/${seller.business.id}/product-captures`,
      { fileName: "shelf.jpg", contentType: "image/png", contentBase64: onePixelPng },
      seller.cookie
    );
    await postJson(
      app,
      `/businesses/${seller.business.id}/product-captures/${job.id}/items/${job.items[0]!.id}/confirm`,
      { title: "Bananas", visiblePrice: 100 },
      seller.cookie
    );
    const status = await postJson<StatusBroadcastSummary>(
      app,
      `/businesses/${seller.business.id}/status-broadcasts`,
      { sourceCaptureJobId: job.id, recipientNodeIds: [buyerNode.id] },
      seller.cookie
    );

    // Buyer syncs the seller as their own phone contact, under a name only the buyer would use.
    await postJson<NetworkGraphSummary>(
      app,
      "/network/sync/contacts",
      { contacts: [{ name: "Farm Fresh Guy", phone: "+254700000701" }] },
      buyer.cookie
    );

    const browseFeed = await getJson<BuyFeedSummary>(app, "/buy/search?query=", buyer.cookie);
    expect(browseFeed.results.map((r) => r.title)).toEqual(
      expect.arrayContaining(["Mangoes", "Bananas"])
    );
    expect(browseFeed.marketplaceConnectorAvailable).toBe(false);

    const bananaFeed = await getJson<BuyFeedSummary>(app, "/buy/search?query=banana", buyer.cookie);
    expect(bananaFeed.results.map((r) => r.title)).toEqual(["Bananas"]);
    expect(bananaFeed.results[0]?.sourceKind).toBe("contact");
    // The buyer's own contact name for the seller, not the seller's name for the buyer.
    expect(bananaFeed.results[0]?.sourceLabel).toBe("Farm Fresh Guy");

    const mangoResult = browseFeed.results.find((r) => r.title === "Mangoes")!;
    const bananaResult = browseFeed.results.find((r) => r.title === "Bananas")!;
    expect(mangoResult.sourceLabel).toBe("Farm Fresh");

    // An unauthenticated/guest search only sees catalogue results - no fabricated contact data.
    const guestFeed = await getJson<BuyFeedSummary>(app, "/buy/search?query=", undefined);
    expect(guestFeed.results.every((r) => r.sourceKind !== "contact")).toBe(true);
    expect(guestFeed.results.some((r) => r.title === "Mangoes")).toBe(true);

    const checkout = await postJson<UnifiedCheckoutSummary>(
      app,
      "/buy/checkout",
      {
        items: [
          {
            sourceKind: "catalogue",
            sourceId: mangoResult.sourceId,
            sourceLabel: mangoResult.sourceLabel,
            title: "Mangoes",
            quantity: 2,
            agentId: mangoResult.agentId,
            productId: mangoResult.productId
          },
          {
            sourceKind: "contact",
            sourceId: bananaResult.sourceId,
            sourceLabel: bananaResult.sourceLabel,
            title: "Bananas",
            quantity: 3,
            statusBroadcastId: bananaResult.statusBroadcastId,
            productCaptureItemId: bananaResult.productCaptureItemId
          },
          {
            sourceKind: "catalogue",
            sourceId: mangoResult.sourceId,
            sourceLabel: mangoResult.sourceLabel,
            title: "Ghost item",
            quantity: 1,
            agentId: mangoResult.agentId,
            productId: "00000000-0000-0000-0000-000000000000"
          }
        ]
      },
      buyer.cookie
    );

    // One handoff per distinct source, not one per item - and the failed item is reported, not
    // silently dropped or allowed to cancel the rest of the checkout.
    expect(checkout.handoffs).toHaveLength(2);
    expect(checkout.failures).toEqual([
      expect.objectContaining({ title: "Ghost item", reason: "No longer available." })
    ]);
    const catalogueHandoff = checkout.handoffs.find((h) => h.kind === "catalogue")!;
    const contactHandoff = checkout.handoffs.find((h) => h.kind === "contact")!;
    expect(catalogueHandoff.sourceLabel).toBe("Farm Fresh");
    expect(catalogueHandoff.status).toBe("requested");
    expect(contactHandoff.sourceLabel).toBe("Farm Fresh Guy");
    expect(contactHandoff.status).toBe("requested");
    expect(catalogueHandoff.items).toEqual([{ title: "Mangoes", quantity: 2, unitPrice: 200 }]);
    expect(contactHandoff.items).toEqual([{ title: "Bananas", quantity: 3, unitPrice: 100 }]);

    const forbidden = await app.inject({
      method: "GET",
      url: `/buy/checkouts/${checkout.id}`,
      headers: { cookie: seller.cookie }
    });
    expect(forbidden.statusCode).toBe(404);

    const readBack = await getJson<UnifiedCheckoutSummary>(
      app,
      `/buy/checkouts/${checkout.id}`,
      buyer.cookie
    );
    expect(readBack.handoffs).toEqual(checkout.handoffs);

    // The contact order is now a real, visible result on the source status.
    const sellerView = await getJson<StatusBroadcastSummary>(
      app,
      `/businesses/${seller.business.id}/status-broadcasts/${status.id}`,
      seller.cookie
    );
    expect(sellerView.resultingOrderIds).toEqual([contactHandoff.orderId]);

    await app.close();
  });

  it("never lets a cart item merge two different sources into one handoff", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const shopA = await createOwnerBusiness(app, "254700000703", "Shop A");
    const shopB = await createOwnerBusiness(app, "254700000704", "Shop B");
    await postJson(
      app,
      `/businesses/${shopA.business.id}/products`,
      { name: "Rice", unit: "kg", quantity: 10, buyingPrice: 80, sellingPrice: 120 },
      shopA.cookie
    );
    await postJson(
      app,
      `/businesses/${shopB.business.id}/products`,
      { name: "Beans", unit: "kg", quantity: 10, buyingPrice: 60, sellingPrice: 90 },
      shopB.cookie
    );
    const buyer = await createOwnerBusiness(app, "254700000705", "Buyer Co");
    const feed = await getJson<BuyFeedSummary>(app, "/buy/search?query=", buyer.cookie);
    const rice = feed.results.find((r) => r.title === "Rice")!;
    const beans = feed.results.find((r) => r.title === "Beans")!;

    const checkout = await postJson<UnifiedCheckoutSummary>(
      app,
      "/buy/checkout",
      {
        items: [
          {
            sourceKind: "catalogue",
            sourceId: rice.sourceId,
            sourceLabel: rice.sourceLabel,
            title: "Rice",
            quantity: 1,
            agentId: rice.agentId,
            productId: rice.productId
          },
          {
            sourceKind: "catalogue",
            sourceId: beans.sourceId,
            sourceLabel: beans.sourceLabel,
            title: "Beans",
            quantity: 1,
            agentId: beans.agentId,
            productId: beans.productId
          }
        ]
      },
      buyer.cookie
    );
    expect(checkout.handoffs).toHaveLength(2);
    expect(new Set(checkout.handoffs.map((h) => h.sourceLabel))).toEqual(
      new Set(["Shop A", "Shop B"])
    );

    await app.close();
  });

  // Side-effect test (docs/architecture/durable-execution-plane.md "Idempotency"): an
  // order-creating checkout that presents the same idempotency key twice - the scenario a resumed
  // or retried runtime turn produces (see commerce-capabilities.ts's
  // `runtime-checkout:${action.id}` key) - must not create a second order.
  it("does not create a second order when the same idempotency key is presented twice", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const seller = await createOwnerBusiness(app, "254700000706", "Idempotent Farm");
    await postJson(
      app,
      `/businesses/${seller.business.id}/products`,
      { name: "Avocados", unit: "kg", quantity: 15, buyingPrice: 90, sellingPrice: 150 },
      seller.cookie
    );
    const buyer = await createOwnerBusiness(app, "254700000707", "Idempotent Buyer");
    const feed = await getJson<BuyFeedSummary>(app, "/buy/search?query=", buyer.cookie);
    const avocado = feed.results.find((r) => r.title === "Avocados")!;

    const body = JSON.stringify({
      items: [
        {
          sourceKind: "catalogue",
          sourceId: avocado.sourceId,
          sourceLabel: avocado.sourceLabel,
          title: "Avocados",
          quantity: 2,
          agentId: avocado.agentId,
          productId: avocado.productId
        }
      ]
    });
    const headers = { ...jsonHeaders(buyer.cookie), "idempotency-key": "confirmed-action-xyz" };

    const first = await app.inject({
      method: "POST",
      url: "/buy/checkout",
      headers,
      payload: body
    });
    expect(first.statusCode).toBe(200);
    const firstCheckout = first.json<UnifiedCheckoutSummary>();

    // Simulates the task resuming/retrying after an interruption and re-issuing the exact same
    // confirmed capability call.
    const second = await app.inject({
      method: "POST",
      url: "/buy/checkout",
      headers,
      payload: body
    });
    expect(second.statusCode).toBe(200);
    const secondCheckout = second.json<UnifiedCheckoutSummary>();

    expect(secondCheckout.id).toBe(firstCheckout.id);
    expect(secondCheckout.handoffs).toEqual(firstCheckout.handoffs);

    // Exactly one order exists for the seller, not two.
    const sellerFeedCheck = await getJson<BuyFeedSummary>(
      app,
      "/buy/search?query=avocado",
      buyer.cookie
    );
    expect(sellerFeedCheck.results[0]?.title).toBe("Avocados");
    expect(sellerFeedCheck.results[0]?.sourceId).toBe(avocado.sourceId);

    // A different idempotency key for otherwise-identical input legitimately creates a second,
    // independent order - idempotency must not become an accidental global dedup.
    const third = await app.inject({
      method: "POST",
      url: "/buy/checkout",
      headers: { ...jsonHeaders(buyer.cookie), "idempotency-key": "confirmed-action-different" },
      payload: body
    });
    expect(third.statusCode).toBe(200);
    const thirdCheckout = third.json<UnifiedCheckoutSummary>();
    expect(thirdCheckout.id).not.toBe(firstCheckout.id);
    expect(thirdCheckout.handoffs[0]?.orderId).not.toBe(firstCheckout.handoffs[0]?.orderId);

    await app.close();
  });
});

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  destination: string,
  name: string,
  pin = "1234"
) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: destination, pin })
  });
  expect(signup.statusCode, signup.body).toBe(200);
  const cookie = extractCookie(signup.headers["set-cookie"]);
  const result = await postJson<{ business: { id: string; grogoniId: string } }>(
    app,
    "/businesses",
    { name, language: "en" },
    cookie
  );
  return { business: result.business, cookie };
}

async function postJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  cookie?: string
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: jsonHeaders(cookie),
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

async function getJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  cookie?: string
): Promise<T> {
  const response = await app.inject({
    method: "GET",
    url,
    headers: cookie === undefined ? {} : { cookie }
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

function jsonHeaders(cookie?: string) {
  return { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) };
}

function extractCookie(header: string | string[] | number | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  expect(typeof value).toBe("string");
  return String(value).split(";")[0] ?? "";
}
