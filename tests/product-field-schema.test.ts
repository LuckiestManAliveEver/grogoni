import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import type { ProductFieldSchemaSummary, ProductSummary } from "@grogoni/shared-types";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

describe("product field schema", () => {
  it("persists a validated business-scoped schema through the API and store snapshot", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const cookie = await createSession(app);
    const business = await postJson<{ business: { id: string } }>(
      app,
      "/businesses",
      { name: "Schema Shop", language: "en" },
      cookie
    );
    const path = `/businesses/${business.business.id}/products/fields`;

    const defaults = await app.inject({ method: "GET", url: path, headers: { cookie } });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json<ProductFieldSchemaSummary>().fields.map((field) => field.id)).toEqual([
      "name",
      "sku",
      "unit",
      "quantity",
      "selling-price"
    ]);

    const saved = await postJson<ProductFieldSchemaSummary>(
      app,
      path,
      {
        fields: [
          { id: "name", label: "Product name", inputType: "text", required: true },
          { id: "color", label: "Color", inputType: "select", required: false }
        ]
      },
      cookie
    );
    expect(saved.fields).toHaveLength(2);
    expect(store.snapshot().productFieldSchemas).toEqual([saved]);

    const product = await postJson<ProductSummary>(
      app,
      `/businesses/${business.business.id}/products`,
      {
        name: "Blue shirt",
        sku: "SHIRT-BLUE",
        unit: "piece",
        quantity: 3,
        buyingPrice: 10,
        sellingPrice: 20,
        fieldValues: { color: "Blue" }
      },
      cookie
    );
    expect(product.fieldValues).toEqual({ color: "Blue" });
    expect(store.snapshot().products).toContainEqual(
      expect.objectContaining({ id: product.id, fieldValues: { color: "Blue" } })
    );

    const duplicate = await app.inject({
      method: "POST",
      url: path,
      headers: { "content-type": "application/json", cookie },
      payload: {
        fields: [
          { id: "name", label: "Name", inputType: "text", required: true },
          { id: "name", label: "Other", inputType: "text", required: false }
        ]
      }
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toMatchObject({ code: "product_field_duplicate" });

    await app.close();
  });

  it("ships a reversible normalized persistence migration", () => {
    const migration = readFileSync("infra/db/migrations/027_product_field_schemas.sql", "utf8");
    const rollback = readFileSync("infra/db/rollbacks/027_product_field_schemas.down.sql", "utf8");
    expect(migration).toContain("create table if not exists cp2_product_field_schemas");
    expect(rollback).toContain("drop table if exists cp2_product_field_schemas");
  });
});

async function createSession(app: FastifyInstance): Promise<string> {
  const verified = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: {
      method: "phone",
      contact: "+254700000827",
      pin: "1234"
    }
  });
  expect(verified.statusCode).toBe(200);
  const setCookie = verified.headers["set-cookie"];
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (value === undefined) throw new Error("Expected session cookie.");
  return value.split(";")[0] ?? value;
}

async function postJson<T>(
  app: FastifyInstance,
  url: string,
  payload: Record<string, unknown>,
  cookie?: string
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie })
    },
    payload
  });
  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode).toBeLessThan(300);
  return response.json<T>();
}
