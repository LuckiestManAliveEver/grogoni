import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool as PgPool, PoolClient } from "pg";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  createPostgresCp2Store,
  saveTransactionalCp2Snapshot
} from "../services/api/src/cp2/postgres-store";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes";
import type {
  BuyFeedSummary,
  MutedShopSummary,
  NetworkGraphSummary,
  ProductCaptureJobSummary,
  StatusBroadcastCandidateSummary,
  StatusBroadcastSummary
} from "../packages/shared-types/src";

// Opt-in shop broadcasts: a customer can turn a shop's status updates off. While off, that shop's
// statuses leave the customer's received list and buy feed, and the shop's picker shows the
// customer as "turned off updates", never selects them, and posting skips them. Turning updates
// back on restores all of it.

const onePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZCr8AAAAASUVORK5CYII=";

async function setup(app: ReturnType<typeof buildApi>, sellerPhone: string, customerPhone: string) {
  const seller = await createOwnerBusiness(app, sellerPhone);
  const customer = await createOwnerBusiness(app, customerPhone);
  const graph = await postJson<NetworkGraphSummary>(
    app,
    "/network/sync/contacts",
    {
      contacts: [
        { name: "Amina", phone: `+${customerPhone}` },
        { name: "Not on Grogoni", phone: `+${sellerPhone.slice(0, -1)}9` }
      ]
    },
    seller.cookie
  );
  const amina = graph.nodes.find((node) => node.displayName === "Amina")!;
  const offline = graph.nodes.find((node) => node.displayName === "Not on Grogoni")!;
  const job = await postJson<ProductCaptureJobSummary>(
    app,
    `/businesses/${seller.business.id}/product-captures`,
    { fileName: "shelf.jpg", contentType: "image/png", contentBase64: onePixelPng },
    seller.cookie
  );
  await postJson(
    app,
    `/businesses/${seller.business.id}/product-captures/${job.id}/items/${job.items[0]!.id}/confirm`,
    { title: "Sukuma wiki", visiblePrice: 40 },
    seller.cookie
  );
  return { seller, customer, amina, offline, job };
}

const put = (
  app: ReturnType<typeof buildApi>,
  businessId: string,
  body: unknown,
  cookie?: string
) =>
  app.inject({
    method: "PUT",
    url: `/v1/broadcast-preferences/${businessId}`,
    headers: jsonHeaders(cookie),
    payload: JSON.stringify(body)
  });

describe("turning a shop's status updates off and on", () => {
  it("hides the shop's statuses, keeps the shop from sending, and restores both when turned on", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { seller, customer, amina, offline, job } = await setup(
      app,
      "254700000801",
      "254700000802"
    );
    const status = await postJson<StatusBroadcastSummary>(
      app,
      `/businesses/${seller.business.id}/status-broadcasts`,
      { sourceCaptureJobId: job.id, recipientNodeIds: [amina.id] },
      seller.cookie
    );
    const received = async () =>
      (
        await getJson<{ statusBroadcasts: StatusBroadcastSummary[] }>(
          app,
          "/status-broadcasts/received",
          customer.cookie
        )
      ).statusBroadcasts.map((item) => item.id);
    const feed = async () =>
      (
        await getJson<BuyFeedSummary>(app, "/buy/search?query=sukuma", customer.cookie)
      ).results.filter((result) => result.sourceKind === "contact");
    const candidate = async () =>
      (
        await getJson<{ candidates: StatusBroadcastCandidateSummary[] }>(
          app,
          `/businesses/${seller.business.id}/status-broadcasts/candidates`,
          seller.cookie
        )
      ).candidates.find((item) => item.networkNodeId === amina.id)!;

    expect(await received()).toEqual([status.id]);
    const before = await feed();
    expect(before.map((result) => [result.sourceBusinessId, result.sourceBusinessName])).toEqual([
      [seller.business.id, "Shop 254700000801"]
    ]);
    expect((await candidate()).optedOut).toBe(false);

    const off = await put(app, seller.business.id, { receive: false }, customer.cookie);
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toEqual({ businessId: seller.business.id, receive: false });

    expect(await received()).toEqual([]);
    expect(await feed()).toEqual([]);
    expect(
      (
        await getJson<{ mutedShops: MutedShopSummary[] }>(
          app,
          "/v1/broadcast-preferences",
          customer.cookie
        )
      ).mutedShops.map((shop) => [shop.businessId, shop.businessName])
    ).toEqual([[seller.business.id, "Shop 254700000801"]]);
    expect(await candidate()).toMatchObject({ optedOut: true, defaultSelected: false });

    // The shop cannot send to her: alone she is refused, beside another contact she is skipped.
    const refused = await app.inject({
      method: "POST",
      url: `/businesses/${seller.business.id}/status-broadcasts`,
      headers: jsonHeaders(seller.cookie),
      payload: JSON.stringify({ sourceCaptureJobId: job.id, recipientNodeIds: [amina.id] })
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("status_broadcast_recipients_opted_out");
    const skipped = await postJson<StatusBroadcastSummary>(
      app,
      `/businesses/${seller.business.id}/status-broadcasts`,
      { sourceCaptureJobId: job.id, recipientNodeIds: [amina.id, offline.id] },
      seller.cookie
    );
    expect(skipped.recipients.map((recipient) => recipient.networkNodeId)).toEqual([offline.id]);

    const on = await put(app, seller.business.id, { receive: true }, customer.cookie);
    expect(on.statusCode).toBe(200);
    expect(await received()).toEqual([status.id]);
    expect((await candidate()).optedOut).toBe(false);
    expect(
      (
        await getJson<{ mutedShops: MutedShopSummary[] }>(
          app,
          "/v1/broadcast-preferences",
          customer.cookie
        )
      ).mutedShops
    ).toEqual([]);
    await app.close();
  });

  it("is one person's choice: another customer of the shop still receives", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { seller, customer, amina } = await setup(app, "254700000811", "254700000812");
    const other = await createOwnerBusiness(app, "254700000813");
    await put(app, seller.business.id, { receive: false }, other.cookie);
    const candidates = (
      await getJson<{ candidates: StatusBroadcastCandidateSummary[] }>(
        app,
        `/businesses/${seller.business.id}/status-broadcasts/candidates`,
        seller.cookie
      )
    ).candidates;
    expect(candidates.find((item) => item.networkNodeId === amina.id)?.optedOut).toBe(false);
    expect(
      (
        await getJson<{ mutedShops: MutedShopSummary[] }>(
          app,
          "/v1/broadcast-preferences",
          customer.cookie
        )
      ).mutedShops
    ).toEqual([]);
    await app.close();
  });

  it("refuses a missing answer, an unknown shop, and a request without a session", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { seller, customer } = await setup(app, "254700000821", "254700000822");
    expect(
      (await put(app, seller.business.id, { receive: "no" }, customer.cookie)).statusCode
    ).toBe(400);
    expect((await put(app, randomUUID(), { receive: false }, customer.cookie)).statusCode).toBe(
      404
    );
    expect((await put(app, seller.business.id, { receive: false })).statusCode).toBe(401);
    await app.close();
  });

  it("skips a phone-only contact whose number is a customer who turned the shop off, without saying so", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const seller = await createOwnerBusiness(app, "254700000851");
    const customer = await createOwnerBusiness(app, "254700000852");
    // Undiscoverable: the seller's address book cannot link her, so she is a phone-only contact.
    const privacy = await app.inject({
      method: "PATCH",
      url: "/network/privacy",
      headers: jsonHeaders(customer.cookie),
      payload: JSON.stringify({ discoverable: false })
    });
    expect(privacy.statusCode, privacy.body).toBe(200);
    expect(
      (await put(app, seller.business.id, { receive: false }, customer.cookie)).statusCode
    ).toBe(200);
    const graph = await postJson<NetworkGraphSummary>(
      app,
      "/network/sync/contacts",
      {
        contacts: [
          { name: "Hidden Wanjiru", phone: "+254700000852" },
          { name: "Neighbour", phone: "+254700000859" }
        ]
      },
      seller.cookie
    );
    const hidden = graph.nodes.find((node) => node.displayName === "Hidden Wanjiru")!;
    const neighbour = graph.nodes.find((node) => node.displayName === "Neighbour")!;
    expect(hidden.grogoniUserId).toBeNull();
    // The picker shows her as an ordinary phone contact: nothing says she is on Grogoni.
    const candidates = (
      await getJson<{ candidates: StatusBroadcastCandidateSummary[] }>(
        app,
        `/businesses/${seller.business.id}/status-broadcasts/candidates`,
        seller.cookie
      )
    ).candidates;
    expect(candidates.find((item) => item.networkNodeId === hidden.id)).toMatchObject({
      isGrogoniUser: false,
      optedOut: false
    });
    const job = await postJson<ProductCaptureJobSummary>(
      app,
      `/businesses/${seller.business.id}/product-captures`,
      { fileName: "shelf.jpg", contentType: "image/png", contentBase64: onePixelPng },
      seller.cookie
    );
    await postJson(
      app,
      `/businesses/${seller.business.id}/product-captures/${job.id}/items/${job.items[0]!.id}/confirm`,
      { title: "Maize flour", visiblePrice: 180 },
      seller.cookie
    );
    const status = await postJson<StatusBroadcastSummary>(
      app,
      `/businesses/${seller.business.id}/status-broadcasts`,
      { sourceCaptureJobId: job.id, recipientNodeIds: [hidden.id, neighbour.id] },
      seller.cookie
    );
    expect(status.recipients.map((recipient) => recipient.networkNodeId)).toEqual([neighbour.id]);
    const alone = await app.inject({
      method: "POST",
      url: `/businesses/${seller.business.id}/status-broadcasts`,
      headers: jsonHeaders(seller.cookie),
      payload: JSON.stringify({ sourceCaptureJobId: job.id, recipientNodeIds: [hidden.id] })
    });
    expect(alone.statusCode).toBe(409);
    expect(alone.json().message).toBe("None of the chosen contacts can receive this status.");
    await app.close();
  });

  it("gives the shop no view when a turned-off customer opens its status by link", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { seller, customer, amina, job } = await setup(app, "254700000861", "254700000862");
    const status = await postJson<StatusBroadcastSummary>(
      app,
      `/businesses/${seller.business.id}/status-broadcasts`,
      { sourceCaptureJobId: job.id, recipientNodeIds: [amina.id] },
      seller.cookie
    );
    await put(app, seller.business.id, { receive: false }, customer.cookie);
    const opened = await postJson<StatusBroadcastSummary>(
      app,
      `/status-broadcasts/${status.id}/view`,
      {},
      customer.cookie
    );
    expect(opened.id).toBe(status.id);
    expect(opened.viewCount).toBe(0);
    // Back on: a view counts again.
    await put(app, seller.business.id, { receive: true }, customer.cookie);
    expect(
      (
        await postJson<StatusBroadcastSummary>(
          app,
          `/status-broadcasts/${status.id}/view`,
          {},
          customer.cookie
        )
      ).viewCount
    ).toBe(1);
    await app.close();
  });

  it("goes with the shop when the shop is deleted", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { seller, customer } = await setup(app, "254700000841", "254700000842");
    expect(
      (await put(app, seller.business.id, { receive: false }, customer.cookie)).statusCode
    ).toBe(200);
    const deletion = await postJson<{ request: { id: string } }>(
      app,
      `/businesses/${seller.business.id}/shop-deletion/request`,
      { shopId: seller.business.grogoniId },
      seller.cookie
    );
    await postJson(
      app,
      `/businesses/${seller.business.id}/shop-deletion/${deletion.request.id}/finalize`,
      { pin: "3927", acknowledgement: true, idempotencyKey: "delete-muted-shop" },
      seller.cookie
    );
    expect(store.purgeExpiredShopDeletions(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000))).toBe(
      1
    );
    expect(store.snapshot().broadcastPreferences).toEqual([]);
    expect(
      (
        await getJson<{ mutedShops: MutedShopSummary[] }>(
          app,
          "/v1/broadcast-preferences",
          customer.cookie
        )
      ).mutedShops
    ).toEqual([]);
    await app.close();
  });

  it("survives a snapshot round trip", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { seller, customer } = await setup(app, "254700000831", "254700000832");
    const off = await put(app, seller.business.id, { receive: false }, customer.cookie);
    expect(off.statusCode, off.body).toBe(200);
    await app.close();
    const snapshot = store.snapshot();
    expect(snapshot.broadcastPreferences).toEqual([
      expect.objectContaining({ businessId: seller.business.id, receive: false })
    ]);
    const restored = createCp2Store();
    restored.hydrateSnapshot(structuredClone(snapshot));
    expect(restored.snapshot().broadcastPreferences).toEqual(snapshot.broadcastPreferences);
  });
});

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

describe.skipIf(!databaseUrl)("shop update preferences on the Node PostgreSQL store", () => {
  it("saves turning a shop off, and deletes the row when it is turned back on", async () => {
    // setBroadcastPreference must be on the save queue (mutatingMethodNames), or the 200 above
    // would leave nothing in the database.
    const store = await createPostgresCp2Store({ databaseUrl: databaseUrl! });
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      const seller = store.continueWithChannelPin({
        channel: "email",
        destination: `node-pref-seller-${randomUUID()}@example.invalid`,
        pin: "3927"
      });
      const customer = store.continueWithChannelPin({
        channel: "email",
        destination: `node-pref-customer-${randomUUID()}@example.invalid`,
        pin: "3927"
      });
      const shop = store.createBusiness({
        sessionId: seller.session.id,
        name: `Node pref shop ${randomUUID().slice(0, 8)}`,
        language: "en",
        phoneNumber: `+2547${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
        phoneCountry: "KE"
      }).business;
      await store.flush();
      const id = `${customer.account.id}:${shop.id}`;
      const row = () =>
        pool.query("select record from cp2_broadcast_preferences where entity_id = $1", [id]);
      store.setBroadcastPreference({
        sessionId: customer.session.id,
        businessId: shop.id,
        receive: false
      });
      await store.flush();
      expect((await row()).rows[0]?.record).toMatchObject({ receive: false, businessId: shop.id });
      store.setBroadcastPreference({
        sessionId: customer.session.id,
        businessId: shop.id,
        receive: true
      });
      await store.flush();
      expect((await row()).rows).toEqual([]);
    } finally {
      await store.close();
      await pool.end();
    }
  }, 60_000);
});

describe.skipIf(!databaseUrl)("shop update preferences on PostgreSQL (Edge)", () => {
  it("saves the choice through the Edge pipeline, and the shop's picker sees it", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local lock_timeout = '10s'");
        await client.query(
          "select pg_advisory_xact_lock_shared(hashtext('grogoni.cp2.normalized_store'))"
        );
        const result = await work(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    try {
      const store = createCp2Store();
      const baseline = store.snapshot();
      const phone = () => `2547${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
      const sellerOwner = store.continueWithChannelPin({
        channel: "email",
        destination: `pref-seller-${randomUUID()}@example.invalid`,
        pin: "3927"
      });
      const customerPhone = phone();
      const customerOwner = store.signupWithPhonePin({
        destination: `+${customerPhone}`,
        pin: "3927"
      });
      const shop = store.createBusiness({
        sessionId: sellerOwner.session.id,
        name: `Pref shop ${randomUUID().slice(0, 8)}`,
        language: "en",
        phoneNumber: `+${phone()}`,
        phoneCountry: "KE"
      }).business;
      await transaction((client) =>
        saveTransactionalCp2Snapshot(client, store.snapshot(), baseline)
      );
      const edge = await createEdgeDomainRoutes({ transaction });
      const call = async (path: string, method: string, sessionId: string, body?: unknown) => {
        const response = await edge.routes(
          new Request(`https://grogoni.com${path}`, {
            method,
            headers: { cookie: `grogoni_session=${sessionId}`, "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
          }),
          path
        );
        expect(response?.status, await response?.clone().text()).toBe(200);
        return response!.json() as Promise<Record<string, unknown>>;
      };
      // The seller syncs the customer as a phone contact (through Edge, like the app).
      const graph = (await call("/network/sync/contacts", "POST", sellerOwner.session.id, {
        contacts: [{ name: "Wanjiku", phone: `+${customerPhone}` }]
      })) as unknown as NetworkGraphSummary;
      const node = graph.nodes.find((item) => item.displayName === "Wanjiku")!;
      expect(node.grogoniUserId).not.toBeNull();

      await call(`/v1/broadcast-preferences/${shop.id}`, "PUT", customerOwner.session.id, {
        receive: false
      });
      const row = await pool.query(
        "select account_id, business_id, record from cp2_broadcast_preferences where entity_id = $1",
        [`${customerOwner.account.id}:${shop.id}`]
      );
      expect(row.rows[0]).toMatchObject({
        account_id: customerOwner.account.id,
        business_id: shop.id,
        record: expect.objectContaining({ receive: false })
      });
      const muted = (await call("/v1/broadcast-preferences", "GET", customerOwner.session.id))
        .mutedShops as MutedShopSummary[];
      expect(muted.map((item) => item.businessId)).toEqual([shop.id]);
      // A separate request by the shop: its Edge scope loads the customer's row by business_id.
      const candidates = (
        await call(
          `/businesses/${shop.id}/status-broadcasts/candidates`,
          "GET",
          sellerOwner.session.id
        )
      ).candidates as StatusBroadcastCandidateSummary[];
      expect(candidates.find((item) => item.networkNodeId === node.id)).toMatchObject({
        optedOut: true,
        defaultSelected: false
      });

      // Posting a status runs the scope that loads turned-off customers' users (phone-only
      // matching): its SQL must hold. A missing capture job answers 404 from the handler, not 500.
      const post = await edge.routes(
        new Request(`https://grogoni.com/businesses/${shop.id}/status-broadcasts`, {
          method: "POST",
          headers: {
            cookie: `grogoni_session=${sellerOwner.session.id}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({ sourceCaptureJobId: randomUUID(), recipientNodeIds: [node.id] })
        }),
        `/businesses/${shop.id}/status-broadcasts`
      );
      expect(post?.status, await post?.clone().text()).toBe(404);

      // Two tabs: one account's choices run one at a time (the Edge account lock), so a burst of
      // off/on requests never leaves a state the last request did not ask for.
      const holder = await pool.connect();
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `edge:account:${customerOwner.account.id}`
      ]);
      let finished = false;
      const waiting = call(
        `/v1/broadcast-preferences/${shop.id}`,
        "PUT",
        customerOwner.session.id,
        {
          receive: true
        }
      ).then(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(finished).toBe(false);
      await holder.query("rollback");
      holder.release();
      await waiting;
      await Promise.all(
        [false, true, false, true, false].map((receive) =>
          call(`/v1/broadcast-preferences/${shop.id}`, "PUT", customerOwner.session.id, { receive })
        )
      );
      await call(`/v1/broadcast-preferences/${shop.id}`, "PUT", customerOwner.session.id, {
        receive: false
      });
      expect(
        (
          await pool.query(
            "select count(*)::int as n from cp2_broadcast_preferences where entity_id = $1",
            [`${customerOwner.account.id}:${shop.id}`]
          )
        ).rows[0].n
      ).toBe(1);
      await call(`/v1/broadcast-preferences/${shop.id}`, "PUT", customerOwner.session.id, {
        receive: true
      });
      const gone = await pool.query(
        "select 1 from cp2_broadcast_preferences where entity_id = $1",
        [`${customerOwner.account.id}:${shop.id}`]
      );
      expect(gone.rows).toEqual([]);
    } finally {
      await pool.end();
    }
  }, 60_000);
});

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  destination: string,
  pin = "3927"
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
