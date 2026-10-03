import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { queryCatalogueProducts } from "../packages/business-core/src/index";
import type { ProductSummary } from "../packages/shared-types/src/index";
import { buildApi } from "../services/api/src/app";
import { createCp2Store, readSessionCookie } from "../services/api/src/cp2/store";

describe("platform-agnostic catalogue query", () => {
  const businessId = "00000000-0000-4000-8000-000000000101";
  const otherBusinessId = "00000000-0000-4000-8000-000000000202";
  const products = [
    product({
      id: "00000000-0000-4000-8000-000000000001",
      businessId,
      name: "Fresh Tomatoes",
      aliases: ["nyanya"],
      sellingPrice: 125,
      quantity: 8
    }),
    product({
      id: "00000000-0000-4000-8000-000000000002",
      businessId,
      name: "Fresh Onions",
      aliases: ["kitunguu"],
      sellingPrice: 80,
      quantity: 0
    }),
    product({
      id: "00000000-0000-4000-8000-000000000003",
      otherBusinessId,
      name: "Tomatoes",
      aliases: ["nyanya"],
      sellingPrice: 999,
      quantity: 20
    })
  ];

  it("matches exact names, fuzzy spellings, and explicit local aliases", () => {
    expect(query("Fresh Tomatoes").products.map((item) => item.productId)).toEqual([
      products[0]?.id
    ]);
    expect(query("Fresh Tomatos").products.map((item) => item.productId)).toEqual([
      products[0]?.id
    ]);
    expect(query("nyanya").products.map((item) => item.productId)).toEqual([products[0]?.id]);
  });

  it("returns multiple canonical matches and an explicit zero result", () => {
    expect(query("fresh").products.map((item) => item.productId)).toEqual([
      products[1]?.id,
      products[0]?.id
    ]);
    expect(query("laptop computer")).toEqual({
      query: "laptop computer",
      products: [],
      total: 0
    });
  });

  it("preserves business isolation, availability, price, IDs, and serialization", () => {
    const tomato = query("nyanya");
    expect(tomato.products).toEqual([
      {
        productId: products[0]?.id,
        businessId,
        name: "Fresh Tomatoes",
        unit: "kg",
        sellingPrice: 125,
        availability: "available",
        image: null
      }
    ]);
    expect(JSON.parse(JSON.stringify(tomato))).toEqual(tomato);
    expect(JSON.stringify(tomato)).not.toContain(otherBusinessId);
    expect(JSON.stringify(tomato)).not.toContain("999");

    expect(query("kitunguu").products[0]).toMatchObject({
      productId: products[1]?.id,
      sellingPrice: 80,
      availability: "unavailable"
    });
  });

  function query(value: string) {
    return queryCatalogueProducts({ businessId, products, query: value });
  }
});

describe("catalogue query integration", () => {
  it("hands the canonical queried product ID to the existing storefront order flow", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const cookie = await createSession(app, "254700000481");
    const created = await postJson<{ business: { id: string; grogoniId: string } }>(
      app,
      "/businesses",
      { name: "Chat Commerce Shop", language: "en" },
      cookie
    );
    const canonicalProduct = await postJson<ProductSummary>(
      app,
      `/businesses/${created.business.id}/products`,
      {
        name: "Tomatoes 1kg",
        aliases: ["nyanya"],
        unit: "kg",
        quantity: 5,
        sellingPrice: 150
      },
      cookie
    );
    const result = store.queryCatalogue({
      sessionId: readSessionCookie(cookie),
      businessId: created.business.id,
      query: "nyanya"
    });

    expect(result.products[0]?.productId).toBe(canonicalProduct.id);
    const runtime = await postJson<{
      turn: {
        plan: { toolName: string; input: Record<string, unknown> };
        toolResult: { products: Array<{ productId: string; sellingPrice: number }> };
      };
    }>(
      app,
      `/businesses/${created.business.id}/runtime/turns`,
      { message: "find product nyanya" },
      cookie
    );
    expect(runtime.turn).toMatchObject({
      plan: { toolName: "products.list", input: { query: "nyanya" } },
      toolResult: {
        products: [{ productId: canonicalProduct.id, sellingPrice: 150 }]
      }
    });
    const zero = await postJson<{
      turn: { response: string; toolResult: { products: unknown[]; total: number } };
    }>(
      app,
      `/businesses/${created.business.id}/runtime/turns`,
      { message: "find product laptop computer" },
      cookie
    );
    expect(zero.turn).toMatchObject({
      response: 'No catalogue products matched "laptop computer" in this shop.',
      toolResult: { products: [], total: 0 }
    });
    const publicSession = await postJson<{ capabilityToken: string }>(
      app,
      `/public/storefronts/${created.business.grogoniId}/sessions`,
      { visitorId: "visitor-chat-commerce" }
    );
    const order = await postJson<{ items: Array<{ productId: string }>; status: string }>(
      app,
      `/public/storefronts/${created.business.grogoniId}/orders`,
      {
        capabilityToken: publicSession.capabilityToken,
        customerName: "Amina",
        phone: "+254700000481",
        note: null,
        items: [{ productId: result.products[0]?.productId, quantity: 1 }]
      }
    );
    expect(order).toMatchObject({
      status: "requested",
      items: [{ productId: canonicalProduct.id }]
    });
    await app.close();
  });

  it("adds a production migration for canonical aliases and its search index", async () => {
    const migration = await readFile(
      "infra/db/migrations/048_product_catalogue_aliases.sql",
      "utf8"
    );
    const rollback = await readFile(
      "infra/db/rollbacks/048_product_catalogue_aliases.down.sql",
      "utf8"
    );
    expect(migration).toContain("add column if not exists aliases text[]");
    expect(migration).toContain("products_business_name_lower_idx");
    expect(rollback).toContain("drop column if exists aliases");
  });
});

function product(
  input: Partial<ProductSummary> & Pick<ProductSummary, "id" | "businessId" | "name">
): ProductSummary {
  return {
    sku: null,
    aliases: [],
    unit: "kg",
    quantity: 1,
    buyingPrice: null,
    sellingPrice: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...input
  };
}

async function createSession(app: FastifyInstance, destination: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: destination, pin: "1234" })
  });
  expect(response.statusCode).toBe(200);
  return extractCookie(response.headers["set-cookie"]);
}

async function postJson<T>(
  app: FastifyInstance,
  url: string,
  payload: unknown,
  cookie?: string
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie })
    },
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

function extractCookie(header: string | string[] | number | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  expect(typeof value).toBe("string");
  return String(value).split(";")[0] ?? "";
}
