import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  buildReceiptStructuredExtraction,
  parseReceiptText
} from "../services/api/src/cp2/domains/suppliers/shared";
import {
  normalizedStockUnit,
  receiptUnitMatchesStock
} from "../services/api/src/cp2/domains/suppliers/receipt-units";

/** docs/audits/receipt-to-commerce-checklist-2026-11-16.md, P0: five cartons must never be
 * received as five packets. A differing unit keeps the receipt pending; nothing is posted. */

async function fixture() {
  const store = createCp2Store();
  const app = buildApi({ cp2: { store } });
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    payload: { method: "phone", contact: "+254712000091", pin: "3927" }
  });
  const cookies = signup.headers["set-cookie"];
  const cookie = (Array.isArray(cookies) ? cookies[0] : cookies)!.split(";")[0]!;
  const businessId = (
    await app.inject({
      method: "POST",
      url: "/businesses",
      headers: { cookie },
      payload: { name: "Units shop", language: "en" }
    })
  ).json().business.id as string;
  const call = (path: string, payload?: unknown, method = "POST") =>
    app.inject({
      method: method as "POST",
      url: `/businesses/${businessId}${path}`,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload })
    });
  return { app, call };
}

function receipt(lines: Array<{ name: string; quantity: number; unit: string | null }>) {
  const fields = buildReceiptStructuredExtraction(parseReceiptText(""));
  Object.assign(fields.supplier, { supplierName: "Acacia Wholesale" });
  Object.assign(fields.receipt, { receiptNumber: `U-${Math.random()}`, currency: "KES" });
  fields.products = lines.map((line) => ({
    itemName: line.name,
    itemCode: null,
    sku: null,
    quantity: line.quantity,
    unit: line.unit,
    unitPrice: 50,
    lineTotal: 50 * line.quantity,
    batchNumber: null,
    expiryDate: null
  }));
  return fields;
}

async function scanAndConfirm(
  call: Awaited<ReturnType<typeof fixture>>["call"],
  lines: Parameters<typeof receipt>[0]
) {
  const draft = await call("/receipt-ocr/jobs", {
    fileName: "delivery.png",
    contentType: "image/png",
    extractedText: "delivery",
    structuredExtraction: receipt(lines),
    engine: "gpt-6-luna"
  });
  expect(draft.statusCode, draft.body).toBe(200);
  const job = draft.json();
  const confirmed = await call(`/receipt-ocr/jobs/${job.id}/confirm`, {
    createSupplier: true,
    receiveInventory: true
  });
  return { job, confirmed };
}

const stockOf = async (call: Awaited<ReturnType<typeof fixture>>["call"], name: string) =>
  (
    (await call("/products", undefined, "GET")).json() as Array<{ name: string; quantity: number }>
  ).find((product) => product.name === name)?.quantity;

describe("receipt units", () => {
  it.each([
    ["Pkts", "packet", true],
    ["packets", "packet", true],
    ["PCS", "piece", true],
    ["bags", "bag", true],
    ["boxes", "box", true],
    ["glass", "glass", true],
    ["katoni", "carton", true],
    [" Kgs. ", "kg", true],
    ["carton", "packet", false],
    ["kg", "g", false]
  ])("%s against stock in %s matches: %s", (line, stock, expected) => {
    expect(receiptUnitMatchesStock(line, stock)).toBe(expected);
  });

  it("treats an unstated unit as nothing to contradict", () => {
    expect(normalizedStockUnit("  ")).toBeNull();
    expect(receiptUnitMatchesStock(null, "packet")).toBe(true);
    expect(receiptUnitMatchesStock("carton", "")).toBe(true);
    // The placeholder a product gets when saved without a unit.
    expect(receiptUnitMatchesStock("bag", "unit")).toBe(true);
  });

  it("refuses five cartons into stock kept in packets and posts nothing, then accepts the corrected line", async () => {
    const { app, call } = await fixture();
    try {
      const created = await call("/products", { name: "Sugar 1kg", unit: "packet", quantity: 10 });
      expect(created.statusCode, created.body).toBe(200);

      const refused = await scanAndConfirm(call, [
        { name: "Sugar 1kg", quantity: 5, unit: "carton" }
      ]);
      expect(refused.confirmed.statusCode).toBe(409);
      expect(refused.confirmed.json().code).toBe("delivery_unit_mismatch");
      expect(await stockOf(call, "Sugar 1kg")).toBe(10);
      expect((await call("/purchase-receipts", undefined, "GET")).json()).toHaveLength(0);

      // The person corrects the pending draft to the stock unit (5 cartons of 12 = 60 packets).
      const corrected = await call(
        `/receipt-ocr/jobs/${refused.job.id}`,
        {
          extractedText: "delivery",
          structuredExtraction: receipt([{ name: "Sugar 1kg", quantity: 60, unit: "pkts" }])
        },
        "PATCH"
      );
      expect(corrected.statusCode, corrected.body).toBe(200);
      const accepted = await call(`/receipt-ocr/jobs/${refused.job.id}/confirm`, {
        createSupplier: true,
        receiveInventory: true
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(await stockOf(call, "Sugar 1kg")).toBe(70);
    } finally {
      await app.close();
    }
  });

  it("refuses one new product listed in two different units on the same receipt", async () => {
    const { app, call } = await fixture();
    try {
      const { confirmed } = await scanAndConfirm(call, [
        { name: "Cooking oil", quantity: 2, unit: "carton" },
        { name: "Cooking oil", quantity: 6, unit: "bottle" }
      ]);
      expect(confirmed.statusCode).toBe(409);
      expect(confirmed.json().code).toBe("delivery_unit_mismatch");
      expect(await stockOf(call, "Cooking oil")).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
