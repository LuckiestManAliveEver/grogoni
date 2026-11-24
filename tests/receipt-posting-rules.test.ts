import { describe, expect, it } from "vitest";
import type { PurchaseReceiptSummary, ReceiptOCRJobSummary } from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  buildReceiptStructuredExtraction,
  parseReceiptText
} from "../services/api/src/cp2/domains/suppliers/shared";

// docs/audits/receipt-to-commerce-checklist-2026-11-16.md, P0: the document type decides what a
// confirmation may post, printed arithmetic must add up (or be checked against the paper), and
// values that were not printed are recorded as derived. All enforced at confirmation.

async function fixture() {
  const store = createCp2Store();
  const app = buildApi({ cp2: { store } });
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    payload: {
      method: "phone",
      contact: `+2547${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      pin: "3927"
    }
  });
  const cookies = signup.headers["set-cookie"];
  const cookie = (Array.isArray(cookies) ? cookies[0] : cookies)!.split(";")[0]!;
  const businessId = (
    await app.inject({
      method: "POST",
      url: "/businesses",
      headers: { cookie },
      payload: { name: "Rules shop", language: "en" }
    })
  ).json().business.id as string;
  const call = (path: string, payload?: unknown, method = "POST") =>
    app.inject({
      method: method as "POST",
      url: `/businesses/${businessId}${path}`,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload })
    });
  const draft = async (fields: ReturnType<typeof receipt> | undefined, extractedText: string) => {
    const created = await call("/receipt-ocr/jobs", {
      fileName: "scan.txt",
      contentType: "text/plain",
      extractedText,
      ...(fields ? { structuredExtraction: fields } : {})
    });
    expect(created.statusCode, created.body).toBe(200);
    return created.json() as ReceiptOCRJobSummary;
  };
  const confirm = (job: ReceiptOCRJobSummary, extra: Record<string, unknown> = {}) =>
    call(`/receipt-ocr/jobs/${job.id}/confirm`, {
      createSupplier: true,
      receiveInventory: true,
      ...extra
    });
  return { app, call, draft, confirm, store, businessId };
}

function receipt(
  options: { documentType?: string | null; lineTotal?: number; total?: number | null } = {}
) {
  const fields = buildReceiptStructuredExtraction(parseReceiptText(""));
  Object.assign(fields.supplier, { supplierName: "Acacia Wholesale" });
  Object.assign(fields.receipt, {
    receiptNumber: `R-${Math.random()}`,
    currency: "KES",
    total: options.total === undefined ? 1900 : options.total,
    documentType: options.documentType ?? null
  });
  fields.products = [
    {
      itemName: "Sugar 2kg",
      itemCode: null,
      sku: null,
      quantity: 5,
      unit: null,
      unitPrice: 380,
      lineTotal: options.lineTotal ?? 1900,
      batchNumber: null,
      expiryDate: null
    }
  ];
  return fields;
}

const stock = (store: ReturnType<typeof createCp2Store>, businessId: string) =>
  store
    .snapshot()
    .products.filter((product) => product.businessId === businessId)
    .map((product) => [product.name, product.quantity]);

describe("what a document may post", () => {
  it.each([
    ["quotation", "QUOTATION\nValid 14 days"],
    ["pro_forma", "PRO FORMA INVOICE"],
    ["credit_note", "CREDIT NOTE CN-4"],
    ["return", "GOODS RETURN NOTE"],
    ["sales_receipt", "Our receipt"],
    ["payment_receipt", "PAYMENT RECEIPT"]
  ])("refuses a %s, and moves no stock", async (documentType, text) => {
    const { app, draft, confirm, store, businessId } = await fixture();
    const job = await draft(receipt({ documentType }), text);
    expect(job.structuredExtraction.checks).toMatchObject({ documentType, recordPurchase: false });
    const refused = await confirm(job);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: "receipt_document_not_postable",
      details: { documentType }
    });
    expect(stock(store, businessId)).toEqual([]);
    expect(store.snapshot().purchaseReceipts).toEqual([]);
    await app.close();
  });

  it("takes the printed heading when no type was named", async () => {
    const { app, draft, confirm } = await fixture();
    const job = await draft(
      undefined,
      "QUOTATION\nSupplier: Acacia\nSugar, 5, 380, 1900\nTotal: 1900"
    );
    expect(job.structuredExtraction.checks?.documentType).toBe("quotation");
    expect((await confirm(job)).statusCode).toBe(409);
    await app.close();
  });

  it("asks a person when Luna and the printed heading disagree, then accepts their choice", async () => {
    const { app, call, draft, confirm, store, businessId } = await fixture();
    // As chat-image-reader resolves it: Luna said purchase receipt, the paper says quotation.
    const job = await draft(receipt({ documentType: "unknown" }), "QUOTATION");
    expect(job.structuredExtraction.checks?.refusal).toMatch(/Choose what kind of document/u);
    expect((await confirm(job)).statusCode).toBe(409);
    const fields = {
      ...job.structuredExtraction,
      receipt: { ...job.structuredExtraction.receipt, documentType: "purchase_receipt" }
    };
    const corrected = await call(
      `/receipt-ocr/jobs/${job.id}`,
      { extractedText: job.fullText, structuredExtraction: fields },
      "PATCH"
    );
    expect(corrected.statusCode, corrected.body).toBe(200);
    const accepted = await confirm(corrected.json());
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((accepted.json() as PurchaseReceiptSummary).documentType).toBe("purchase_receipt");
    expect(stock(store, businessId)).toEqual([["Sugar 2kg", 5]]);
    await app.close();
  });

  it("saves an unheaded slip as a purchase receipt, marked as assumed", async () => {
    const { app, draft, confirm } = await fixture();
    const job = await draft(receipt(), "Acacia Wholesale\nSugar 5 x 380");
    expect(job.structuredExtraction.checks?.documentType).toBe("purchase_receipt");
    expect(job.structuredExtraction.derivedFields).toContain("receipt.documentType");
    const saved = (await confirm(job)).json() as PurchaseReceiptSummary;
    expect(saved.documentType).toBe("purchase_receipt");
    expect(saved.derivedFields).toContain("receipt.documentType");
    await app.close();
  });

  it("posts an invoice as owed, not paid, and records what was not printed", async () => {
    const { app, draft, confirm, store, businessId } = await fixture();
    const job = await draft(receipt({ documentType: "invoice", total: null }), "TAX INVOICE INV-7");
    const saved = (await confirm(job)).json() as PurchaseReceiptSummary;
    expect(saved).toMatchObject({ documentType: "invoice", total: 1900 });
    // No date or total was printed: the saved values say they were filled in.
    expect(saved.derivedFields).toEqual(
      expect.arrayContaining(["receipt.purchaseDate", "receipt.total"])
    );
    expect(stock(store, businessId)).toEqual([["Sugar 2kg", 5]]);
    await app.close();
  });
});

describe("printed arithmetic", () => {
  it("refuses a line that does not add up until it is corrected or checked against the paper", async () => {
    const { app, draft, confirm, store, businessId } = await fixture();
    const job = await draft(receipt({ lineTotal: 1800, total: 1800 }), "CASH SALE");
    expect(job.structuredExtraction.checks?.arithmeticIssues).toEqual([
      expect.objectContaining({
        code: "line_total_mismatch",
        field: "products.0.lineTotal",
        expected: 1900,
        printed: 1800
      })
    ]);
    const refused = await confirm(job);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: "receipt_arithmetic_mismatch",
      details: { issues: [expect.objectContaining({ field: "products.0.lineTotal" })] }
    });
    expect(stock(store, businessId)).toEqual([]);
    const accepted = await confirm(job, { acknowledgedDiscrepancies: ["products.0.lineTotal"] });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((accepted.json() as PurchaseReceiptSummary).acknowledgedDiscrepancies).toEqual([
      "products.0.lineTotal"
    ]);
    await app.close();
  });

  it("does not let an acknowledgement for another field pass a mismatch", async () => {
    const { app, draft, confirm } = await fixture();
    const job = await draft(receipt({ lineTotal: 1800, total: 1800 }), "CASH SALE");
    expect((await confirm(job, { acknowledgedDiscrepancies: ["receipt.total"] })).statusCode).toBe(
      409
    );
    expect((await confirm(job, { acknowledgedDiscrepancies: "receipt.total" })).statusCode).toBe(
      400
    );
    await app.close();
  });

  it("recomputes the checks from the draft, never from the client", async () => {
    const { app, call, draft, confirm } = await fixture();
    const job = await draft(receipt({ lineTotal: 1800, total: 1800 }), "CASH SALE");
    // A client that saves forged "checks" with no issues still meets the server's own.
    const forged = {
      ...job.structuredExtraction,
      checks: { ...job.structuredExtraction.checks, arithmeticIssues: [], recordPurchase: true }
    };
    const saved = await call(
      `/receipt-ocr/jobs/${job.id}`,
      { extractedText: job.fullText, structuredExtraction: forged },
      "PATCH"
    );
    expect(saved.json().structuredExtraction.checks.arithmeticIssues).toHaveLength(1);
    expect((await confirm(saved.json())).statusCode).toBe(409);
    await app.close();
  });

  it("keeps a computed line total marked as computed, and drops the mark once a person changes it", async () => {
    const { app, call, draft } = await fixture();
    const job = await draft(
      undefined,
      "CASH SALE\nSupplier: Acacia Wholesale\nSugar, 5, 380\nTotal: 1900"
    );
    expect(job.structuredExtraction.derivedFields).toEqual(["products.0.lineTotal"]);
    const resaved = await call(
      `/receipt-ocr/jobs/${job.id}`,
      { extractedText: job.fullText, structuredExtraction: job.structuredExtraction },
      "PATCH"
    );
    expect(resaved.json().structuredExtraction.derivedFields).toEqual(["products.0.lineTotal"]);
    const edited = structuredClone(job.structuredExtraction);
    edited.products[0]!.lineTotal = 1850;
    const changed = await call(
      `/receipt-ocr/jobs/${job.id}`,
      { extractedText: job.fullText, structuredExtraction: edited },
      "PATCH"
    );
    expect(changed.json().structuredExtraction.derivedFields).toEqual([]);
    await app.close();
  });
});

describe("drafts from before these checks", () => {
  it("still confirm as purchase receipts, so nothing open in production is stranded", async () => {
    const { app, draft, confirm, store } = await fixture();
    const job = await draft(receipt(), "Acacia Wholesale");
    // What a draft saved before 2026-11-24 looks like: no type, no checks.
    const stored = store.snapshot().receiptOCRJobs.find((item) => item.id === job.id)!;
    delete stored.structuredExtraction.checks;
    delete stored.structuredExtraction.receipt.documentType;
    delete stored.structuredExtraction.derivedFields;
    const legacy = createCp2Store();
    legacy.hydrateSnapshot({ ...store.snapshot(), receiptOCRJobs: [stored] });
    const supplierDomain = (
      legacy as unknown as {
        supplierDomain: {
          assertReceiptPostable: (
            job: ReceiptOCRJobSummary,
            input: object
          ) => { documentType: string };
        };
      }
    ).supplierDomain;
    expect(supplierDomain.assertReceiptPostable(stored, {}).documentType).toBe("purchase_receipt");
    expect((await confirm(job)).statusCode).toBe(200);
    await app.close();
  });
});
