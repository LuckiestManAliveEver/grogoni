import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import type {
  NetworkGraphSummary,
  ProductCaptureJobSummary,
  StatusBroadcastCandidateSummary,
  StatusBroadcastSummary
} from "../packages/shared-types/src";

const onePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZCr8AAAAASUVORK5CYII=";

describe("photo capture items and status broadcast", () => {
  it("creates a job with exactly one honestly-stubbed item and lets the seller confirm it", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { business, cookie } = await createOwnerBusiness(app, "254700000601");

    const job = await postJson<ProductCaptureJobSummary>(
      app,
      `/businesses/${business.id}/product-captures`,
      { fileName: "shelf.jpg", contentType: "image/png", contentBase64: onePixelPng },
      cookie
    );
    expect(job.items).toHaveLength(1);
    expect(job.detectionAvailable).toBe(false);
    expect(job.items[0]?.boundingBox).toBeNull();
    expect(job.items[0]?.status).toBe("pending_review");

    const itemId = job.items[0]!.id;
    const confirmed = await postJson<{
      job: ProductCaptureJobSummary;
      product: { id: string; name: string; sellingPrice: number | null };
    }>(
      app,
      `/businesses/${business.id}/product-captures/${job.id}/items/${itemId}/confirm`,
      { title: "Tomatoes", visiblePrice: 150, unit: "crate" },
      cookie
    );
    expect(confirmed.product.name).toBe("Tomatoes");
    expect(confirmed.product.sellingPrice).toBe(150);
    expect(confirmed.job.items[0]?.status).toBe("confirmed");
    expect(confirmed.job.items[0]?.confirmedProductId).toBe(confirmed.product.id);
    expect(confirmed.job.status).toBe("CONFIRMED");

    // Resolving an already-resolved item is rejected, not silently repeated.
    const response = await app.inject({
      method: "POST",
      url: `/businesses/${business.id}/product-captures/${job.id}/items/${itemId}/reject`,
      headers: { cookie }
    });
    expect(response.statusCode).toBe(409);

    await app.close();
  });

  it("moves a job to CANCELLED with no product when its only item is rejected", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { business, cookie } = await createOwnerBusiness(app, "254700000602");

    const job = await postJson<ProductCaptureJobSummary>(
      app,
      `/businesses/${business.id}/product-captures`,
      { fileName: "blur.jpg", contentType: "image/png", contentBase64: onePixelPng },
      cookie
    );
    const rejected = await postJson<ProductCaptureJobSummary>(
      app,
      `/businesses/${business.id}/product-captures/${job.id}/items/${job.items[0]!.id}/reject`,
      {},
      cookie
    );
    expect(rejected.items[0]?.status).toBe("rejected");
    expect(rejected.status).toBe("CANCELLED");
    expect(rejected.publishedProductId).toBeNull();

    await app.close();
  });

  it("rejects posting a status with no recipients or with no confirmed items", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { business, cookie } = await createOwnerBusiness(app, "254700000603");

    const job = await postJson<ProductCaptureJobSummary>(
      app,
      `/businesses/${business.id}/product-captures`,
      { fileName: "shelf.jpg", contentType: "image/png", contentBase64: onePixelPng },
      cookie
    );

    const noConfirmedItems = await app.inject({
      method: "POST",
      url: `/businesses/${business.id}/status-broadcasts`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ sourceCaptureJobId: job.id, recipientNodeIds: ["anything"] })
    });
    expect(noConfirmedItems.statusCode).toBe(409);

    await postJson(
      app,
      `/businesses/${business.id}/product-captures/${job.id}/items/${job.items[0]!.id}/confirm`,
      { title: "Tomatoes", visiblePrice: 150 },
      cookie
    );

    const noRecipients = await app.inject({
      method: "POST",
      url: `/businesses/${business.id}/status-broadcasts`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ sourceCaptureJobId: job.id, recipientNodeIds: [] })
    });
    expect(noRecipients.statusCode).toBe(400);

    await app.close();
  });

  it("never defaults the contact picker to select-all, and delivers in-app only to matched Grogoni contacts", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { business, cookie } = await createOwnerBusiness(app, "254700000604");
    const contact = await createOwnerBusiness(app, "254700000605");

    const graph = await postJson<NetworkGraphSummary>(
      app,
      "/network/sync/contacts",
      {
        contacts: [
          { name: "Amina (on Grogoni)", phone: "+254700000605" },
          { name: "Baraka (not on Grogoni)", phone: "+254700000606" }
        ]
      },
      cookie
    );
    const grogoniContactNode = graph.nodes.find(
      (node) => node.displayName === "Amina (on Grogoni)"
    )!;
    const unmatchedNode = graph.nodes.find(
      (node) => node.displayName === "Baraka (not on Grogoni)"
    )!;
    expect(grogoniContactNode.grogoniUserId).not.toBeNull();
    expect(unmatchedNode.grogoniUserId).toBeNull();

    const { candidates } = await getJson<{ candidates: StatusBroadcastCandidateSummary[] }>(
      app,
      `/businesses/${business.id}/status-broadcasts/candidates`,
      cookie
    );
    // Neither candidate is an existing *customer* of this business yet, so neither is
    // pre-selected even though one of them is a matched Grogoni account - never select-all.
    expect(candidates.every((candidate) => candidate.defaultSelected === false)).toBe(true);
    const grogoniCandidate = candidates.find((c) => c.networkNodeId === grogoniContactNode.id)!;
    expect(grogoniCandidate.isGrogoniUser).toBe(true);

    const job = await postJson<ProductCaptureJobSummary>(
      app,
      `/businesses/${business.id}/product-captures`,
      { fileName: "shelf.jpg", contentType: "image/png", contentBase64: onePixelPng },
      cookie
    );
    await postJson(
      app,
      `/businesses/${business.id}/product-captures/${job.id}/items/${job.items[0]!.id}/confirm`,
      { title: "Tomatoes", visiblePrice: 150 },
      cookie
    );

    const status = await postJson<StatusBroadcastSummary>(
      app,
      `/businesses/${business.id}/status-broadcasts`,
      { sourceCaptureJobId: job.id, recipientNodeIds: [grogoniContactNode.id, unmatchedNode.id] },
      cookie
    );
    expect(status.recipients).toHaveLength(2);
    expect(
      status.recipients.find((r) => r.networkNodeId === grogoniContactNode.id)?.deliveryChannel
    ).toBe("in_app");
    expect(
      status.recipients.find((r) => r.networkNodeId === unmatchedNode.id)?.deliveryChannel
    ).toBe("share_sheet_pending");
    expect(status.viewCount).toBe(0);
    expect(status.replyCount).toBe(0);

    // "in_app" is genuinely discoverable by the matched recipient from their own session - not
    // pushed as a plaintext conversation message, since direct human-to-human conversations in
    // this app must be end-to-end encrypted and a server-composed card can't honestly satisfy that.
    const received = await getJson<{ statusBroadcasts: StatusBroadcastSummary[] }>(
      app,
      "/status-broadcasts/received",
      contact.cookie
    );
    expect(received.statusBroadcasts.map((s) => s.id)).toContain(status.id);

    // The recipient views it from their own session - the counter is real, not hardcoded.
    const viewed = await postJson<StatusBroadcastSummary>(
      app,
      `/status-broadcasts/${status.id}/view`,
      {},
      contact.cookie
    );
    expect(viewed.viewCount).toBe(1);
    const viewedAgain = await postJson<StatusBroadcastSummary>(
      app,
      `/status-broadcasts/${status.id}/view`,
      {},
      contact.cookie
    );
    expect(viewedAgain.viewCount).toBe(1);

    await app.close();
  });
});

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  destination: string,
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
    { name: `Shop ${destination}`, language: "en" },
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
  cookie: string
): Promise<T> {
  const response = await app.inject({ method: "GET", url, headers: { cookie } });
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
