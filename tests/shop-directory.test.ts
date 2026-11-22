import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool as PgPool, PoolClient } from "pg";
import { shopCategories, shopPlaceMaxLength } from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import { saveTransactionalCp2Snapshot } from "../services/api/src/cp2/postgres-store";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes";
import {
  createPublicRoutes,
  shopCategories as edgeShopCategories,
  shopPlaceMaxLength as edgeShopPlaceMaxLength
} from "../supabase/functions/api/public-routes";

// The shop directory: a buyer finds a shop by what it sells (category) and where it is (place),
// as well as by name, Grogoni ID or product. The owner sets the listing on the shop's presence
// record; a private shop is never listed.
function shopFor(store: ReturnType<typeof createCp2Store>, name: string) {
  const owner = store.continueWithChannelPin({
    channel: "email",
    destination: `${name.toLowerCase().replace(/\W+/gu, "-")}-${randomUUID()}@example.test`,
    pin: "3927"
  });
  const business = store.createBusiness({
    sessionId: owner.session.id,
    name,
    language: "en",
    // Random: the PostgreSQL test shares a database with earlier runs (unique phone index).
    phoneNumber: `+2547${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
    phoneCountry: "KE"
  }).business;
  return { owner, business };
}

describe("shop directory listing", () => {
  it("filters by category and place, and plain search finds the place too", () => {
    const store = createCp2Store();
    const mama = shopFor(store, "Mama Mboga");
    const duka = shopFor(store, "Duka la Dawa");
    const unlisted = shopFor(store, "Unlisted Shop");
    store.setShopDirectoryListing({
      sessionId: mama.owner.session.id,
      businessId: mama.business.id,
      category: "fresh_produce",
      place: "  Westlands,   Nairobi "
    });
    store.setShopDirectoryListing({
      sessionId: duka.owner.session.id,
      businessId: duka.business.id,
      category: "pharmacy",
      place: "Kisumu"
    });
    const names = (input: Parameters<typeof store.listPublicStorefronts>[0]) =>
      store
        .listPublicStorefronts(input)
        .map((storefront) => storefront.businessName)
        .filter((name) => name !== "Jane's Shop");

    expect(names({ category: "pharmacy" })).toEqual(["Duka la Dawa"]);
    expect(names({ place: "westlands" })).toEqual(["Mama Mboga"]);
    // Spaces collapse in the query as they did in the saved place.
    expect(names({ place: " westlands,    nairobi " })).toEqual(["Mama Mboga"]);
    expect(names({ search: "kisumu" })).toEqual(["Duka la Dawa"]);
    expect(names({ category: "fresh_produce", place: "kisumu" })).toEqual([]);
    expect(names({})).toEqual(["Duka la Dawa", "Mama Mboga", "Unlisted Shop"]);
    const listed = store
      .listPublicStorefronts({ category: "fresh_produce" })
      .find((storefront) => storefront.businessName === "Mama Mboga");
    // Whitespace is tidied once, when saved.
    expect(listed).toMatchObject({ category: "fresh_produce", place: "Westlands, Nairobi" });
    expect(
      store
        .listPublicStorefronts({})
        .find((storefront) => storefront.businessName === unlisted.business.name)
    ).not.toHaveProperty("category");
  });

  it("keeps a private shop out of the directory, and survives a presence change", () => {
    const store = createCp2Store();
    const shop = shopFor(store, "Quiet Shop");
    store.setShopDirectoryListing({
      sessionId: shop.owner.session.id,
      businessId: shop.business.id,
      category: "hardware",
      place: "Thika"
    });
    store.setShopPresence({
      sessionId: shop.owner.session.id,
      businessId: shop.business.id,
      status: "busy"
    });
    expect(store.listPublicStorefronts({ category: "hardware" })).toHaveLength(1);
    store.setShopPresence({
      sessionId: shop.owner.session.id,
      businessId: shop.business.id,
      status: "private"
    });
    expect(store.listPublicStorefronts({ category: "hardware" })).toEqual([]);
  });

  it("clears a field with null, and refuses an unknown category or an unusable place", () => {
    const store = createCp2Store();
    const shop = shopFor(store, "Edge Cases");
    const set = (category: string | null, place: string | null) =>
      store.setShopDirectoryListing({
        sessionId: shop.owner.session.id,
        businessId: shop.business.id,
        category: category as never,
        place
      });
    set("bakery", "Nakuru");
    expect(set(null, "")).toMatchObject({ category: null, place: null });
    expect(() => set("casino", null)).toThrow(/category from the list/u);
    expect(() => set(null, "x".repeat(shopPlaceMaxLength + 1))).toThrow(/80 characters/u);
    expect(() => set(null, "<script>")).toThrow(/without < or >/u);
  });

  it("lets only the owner change the listing", () => {
    const store = createCp2Store();
    const shop = shopFor(store, "Owned Shop");
    const stranger = store.continueWithChannelPin({
      channel: "email",
      destination: `stranger-${randomUUID()}@example.test`,
      pin: "3927"
    });
    expect(() =>
      store.setShopDirectoryListing({
        sessionId: stranger.session.id,
        businessId: shop.business.id,
        category: "other",
        place: null
      })
    ).toThrow();
  });

  it("serves the listing and the filters over HTTP", async () => {
    const store = createCp2Store();
    const shop = shopFor(store, "Http Shop");
    const app = buildApi({ cp2: { store } });
    try {
      const cookie = `grogoni_session=${shop.owner.session.id}`;
      const saved = await app.inject({
        method: "PATCH",
        url: `/businesses/${shop.business.id}/directory-listing`,
        headers: { cookie },
        payload: { category: "electronics", place: "Mombasa" }
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json()).toMatchObject({ category: "electronics", place: "Mombasa" });
      const found = await app.inject({
        method: "GET",
        url: "/public/storefronts?category=electronics&place=momb"
      });
      expect(found.json().storefronts.map((s: { businessName: string }) => s.businessName)).toEqual(
        ["Http Shop"]
      );
      const unknown = await app.inject({
        method: "GET",
        url: "/public/storefronts?category=casino"
      });
      expect(unknown.statusCode).toBe(400);
      const wrongType = await app.inject({
        method: "PATCH",
        url: `/businesses/${shop.business.id}/directory-listing`,
        headers: { cookie },
        payload: { category: 7 }
      });
      expect(wrongType.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("the Edge API's copy of the categories matches the shared list", () => {
    expect([...edgeShopCategories]).toEqual([...shopCategories]);
    expect(edgeShopPlaceMaxLength).toBe(shopPlaceMaxLength);
  });
});

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

describe.skipIf(!databaseUrl)("shop directory on PostgreSQL (Edge)", () => {
  it("saves a listing through the Edge pipeline and finds it with the Edge search", async () => {
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
      const place = `Ruiru ${randomUUID().slice(0, 8)}`;
      const shop = shopFor(store, `Directory shop ${randomUUID().slice(0, 8)}`);
      await transaction((client) =>
        saveTransactionalCp2Snapshot(client, store.snapshot(), baseline)
      );
      const edge = await createEdgeDomainRoutes({ transaction });
      const path = `/businesses/${shop.business.id}/directory-listing`;
      const saved = await edge.routes(
        new Request(`https://grogoni.com${path}`, {
          method: "PATCH",
          headers: {
            cookie: `grogoni_session=${shop.owner.session.id}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({ category: "agrovet", place })
        }),
        path
      );
      expect(saved?.status, await saved?.clone().text()).toBe(200);

      const publicRoutes = createPublicRoutes(transaction as never);
      const search = async (query: string) => {
        const response = await publicRoutes(
          new Request(`https://grogoni.com/public/storefronts?${query}`),
          "/public/storefronts"
        );
        expect(response?.status).toBe(200);
        return ((await response!.json()) as { storefronts: Array<Record<string, unknown>> })
          .storefronts;
      };
      const byPlace = await search(`category=agrovet&place=${encodeURIComponent(place)}`);
      expect(byPlace).toEqual([
        expect.objectContaining({
          businessName: shop.business.name,
          category: "agrovet",
          place
        })
      ]);
      expect(await search(`search=${encodeURIComponent(place.toLowerCase())}`)).toHaveLength(1);
      expect(
        await search(`place=${encodeURIComponent(`  ${place.replace(" ", "    ")} `)}`)
      ).toHaveLength(1);
      expect(await search(`category=pharmacy&place=${encodeURIComponent(place)}`)).toEqual([]);
      const refused = await publicRoutes(
        new Request("https://grogoni.com/public/storefronts?category=casino"),
        "/public/storefronts"
      );
      expect(refused?.status).toBe(400);
    } finally {
      await pool.end();
    }
  }, 60_000);
});
