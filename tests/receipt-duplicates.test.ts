import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool as PgPool, PoolClient } from "pg";
import type { PurchaseReceiptSummary, ReceiptOCRJobSummary } from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  createPostgresCp2Store,
  saveTransactionalCp2Snapshot
} from "../services/api/src/cp2/postgres-store";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes";
import { receiptFingerprints } from "../services/api/src/cp2/domains/suppliers/receipt-validation";
import {
  buildReceiptStructuredExtraction,
  parseReceiptText
} from "../services/api/src/cp2/domains/suppliers/shared";

// docs/audits/receipt-to-commerce-checklist-2026-11-16.md, P0: the same commercial receipt is
// saved once, whatever photograph or OCR it arrives through (recapture, crop, retyped copy).

function fields(options: {
  number?: string | null;
  supplier?: string;
  total?: number;
  date?: string;
  taxPin?: string | null;
  phone?: string | null;
}) {
  const extraction = buildReceiptStructuredExtraction(parseReceiptText(""));
  Object.assign(extraction.supplier, {
    supplierName: options.supplier ?? "Acacia Wholesale Ltd",
    phoneNumber: options.phone === undefined ? "+254722000111" : options.phone,
    taxPin: options.taxPin ?? null
  });
  Object.assign(extraction.receipt, {
    receiptNumber: options.number === undefined ? "R-1042" : options.number,
    currency: "KES",
    total: options.total ?? 1900,
    purchaseDate: options.date ?? "2026-11-20",
    documentType: "purchase_receipt"
  });
  extraction.products = [
    {
      itemName: "Sugar 2kg",
      itemCode: null,
      sku: null,
      quantity: 5,
      unit: null,
      unitPrice: 380,
      lineTotal: 1900,
      batchNumber: null,
      expiryDate: null
    }
  ];
  return extraction;
}

describe("receipt fingerprints", () => {
  it("are the same for a recapture that reads the same receipt differently", () => {
    const a = receiptFingerprints(fields({ number: "R-1042", supplier: "Acacia Wholesale Ltd" }));
    // OCR from another photo: spacing, case, punctuation and "Limited" differ.
    const b = receiptFingerprints(
      fields({ number: "r 1042", supplier: "ACACIA WHOLESALE LIMITED" })
    );
    expect(a.strong).not.toBeNull();
    expect(b.strong).toBe(a.strong);
    expect(b.weak).toBe(a.weak);
  });

  it("differ for another number, total, date or supplier", () => {
    const base = receiptFingerprints(fields({})).strong;
    for (const other of [
      fields({ number: "R-1043" }),
      fields({ total: 1950 }),
      fields({ date: "2026-11-21" }),
      fields({ supplier: "Baraka Distributors" })
    ])
      expect(receiptFingerprints(other).strong).not.toBe(base);
  });

  it("use the tax PIN when printed, so a renamed supplier is still the same supplier", () => {
    const a = receiptFingerprints(fields({ taxPin: "P051234567X", supplier: "Acacia" }));
    const b = receiptFingerprints(fields({ taxPin: "p051234567x", supplier: "Acacia Wholesale" }));
    expect(b.strong).toBe(a.strong);
  });

  it("have no strong fingerprint without a printed number or supplier", () => {
    expect(receiptFingerprints(fields({ number: null })).strong).toBeNull();
    expect(receiptFingerprints(fields({ number: null })).weak).not.toBeNull();
    const nobody = fields({});
    nobody.supplier.supplierName = null;
    nobody.supplier.phoneNumber = null;
    expect(receiptFingerprints(nobody)).toEqual({ strong: null, weak: null });
  });
});

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
      payload: { name: "Duplicate shop", language: "en" }
    })
  ).json().business.id as string;
  const call = (path: string, payload?: unknown) =>
    app.inject({
      method: "POST",
      url: `/businesses/${businessId}${path}`,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload })
    });
  const draft = async (extraction: ReturnType<typeof fields>, text: string) => {
    const created = await call("/receipt-ocr/jobs", {
      fileName: `${randomUUID()}.png`,
      contentType: "text/plain",
      extractedText: text,
      structuredExtraction: extraction
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
  return { app, store, businessId, draft, confirm };
}

const sugar = (store: ReturnType<typeof createCp2Store>, businessId: string) =>
  store.snapshot().products.find((p) => p.businessId === businessId && p.name === "Sugar 2kg")
    ?.quantity ?? 0;

describe("the same receipt is saved once", () => {
  it("refuses another photo of a saved receipt, and moves no stock twice", async () => {
    const { app, store, businessId, draft, confirm } = await fixture();
    const first = await draft(fields({}), "CASH SALE\nAcacia Wholesale Ltd\nR-1042");
    const saved = await confirm(first);
    expect(saved.statusCode, saved.body).toBe(200);
    const receipt = saved.json() as PurchaseReceiptSummary;
    expect(receipt.documentFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(sugar(store, businessId)).toBe(5);

    // A second photo, read with different spacing and case: the draft already says so.
    const again = await draft(
      fields({ number: "r 1042", supplier: "ACACIA WHOLESALE LIMITED" }),
      "cash sale\nACACIA WHOLESALE LIMITED\nr 1042"
    );
    expect(again.structuredExtraction.checks?.duplicateOf).toMatchObject({
      receiptId: receipt.id,
      match: "same"
    });
    const refused = await confirm(again);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: "receipt_duplicate",
      details: { receiptId: receipt.id }
    });
    // Even claiming it is different does not pass a same-number receipt.
    expect((await confirm(again, { confirmedDifferentFrom: receipt.id })).statusCode).toBe(409);
    expect(sugar(store, businessId)).toBe(5);
    await app.close();
  });

  it("asks about a possible duplicate without a number, and accepts the person's answer", async () => {
    const { app, store, businessId, draft, confirm } = await fixture();
    const first = (
      await confirm(await draft(fields({ number: null }), "Acacia"))
    ).json() as PurchaseReceiptSummary;
    const again = await draft(fields({ number: null }), "Acacia (another photo)");
    expect(again.structuredExtraction.checks?.duplicateOf).toMatchObject({
      receiptId: first.id,
      match: "possible"
    });
    const asked = await confirm(again);
    expect(asked.statusCode).toBe(409);
    expect(asked.json().code).toBe("receipt_possible_duplicate");
    // Naming another receipt does not answer the question.
    expect((await confirm(again, { confirmedDifferentFrom: randomUUID() })).statusCode).toBe(409);
    const accepted = await confirm(again, { confirmedDifferentFrom: first.id });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((accepted.json() as PurchaseReceiptSummary).confirmedDifferentFrom).toBe(first.id);
    expect(sugar(store, businessId)).toBe(10);
    await app.close();
  });

  it("catches a receipt saved before fingerprints existed, from its own scan", async () => {
    const { app, store, draft, confirm } = await fixture();
    const first = (
      await confirm(await draft(fields({}), "CASH SALE"))
    ).json() as PurchaseReceiptSummary;
    // As saved before 2026-11-24: no fingerprints on the receipt.
    const saved = store.snapshot();
    const legacy = createCp2Store();
    legacy.hydrateSnapshot({
      ...saved,
      purchaseReceipts: saved.purchaseReceipts.map((receipt) => {
        const { documentFingerprint: _a, contentFingerprint: _b, ...rest } = receipt;
        void _a;
        void _b;
        return rest;
      })
    });
    const job = (
      legacy as unknown as {
        supplierDomain: {
          assertReceiptPostable: (job: ReceiptOCRJobSummary, input: object) => unknown;
        };
      }
    ).supplierDomain;
    const again = await draft(fields({}), "CASH SALE again");
    expect(() => job.assertReceiptPostable({ ...again, businessId: first.businessId }, {})).toThrow(
      /already saved/u
    );
    await app.close();
  });

  it("does not treat the same number from another supplier as a duplicate", async () => {
    const { app, draft, confirm } = await fixture();
    await confirm(await draft(fields({}), "CASH SALE"));
    const other = await draft(
      fields({ supplier: "Baraka Distributors", phone: "+254733000222" }),
      "CASH SALE"
    );
    expect(other.structuredExtraction.checks?.duplicateOf).toBeUndefined();
    expect((await confirm(other)).statusCode).toBe(200);
    await app.close();
  });
});

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

describe.skipIf(!databaseUrl)("duplicate receipts on PostgreSQL (Edge)", () => {
  it("saves one of two concurrent confirmations of the same receipt, and the index holds", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
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
      const owner = store.continueWithChannelPin({
        channel: "email",
        destination: `dup-${randomUUID()}@example.invalid`,
        pin: "3927"
      });
      const businessId = store.createBusiness({
        sessionId: owner.session.id,
        name: `Dup shop ${randomUUID().slice(0, 8)}`,
        language: "en",
        phoneNumber: `+2547${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
        phoneCountry: "KE"
      }).business.id;
      await transaction((client) =>
        saveTransactionalCp2Snapshot(client, store.snapshot(), baseline)
      );
      const edge = await createEdgeDomainRoutes({ transaction });
      const call = async (path: string, body: unknown) => {
        const response = await edge.routes(
          new Request(`https://grogoni.com/businesses/${businessId}${path}`, {
            method: "POST",
            headers: {
              cookie: `grogoni_session=${owner.session.id}`,
              "content-type": "application/json"
            },
            body: JSON.stringify(body)
          }),
          `/businesses/${businessId}${path}`
        );
        return { status: response!.status, body: await response!.json() };
      };
      const number = `R-${randomUUID().slice(0, 8)}`;
      const drafts = await Promise.all(
        [1, 2].map(
          async (photo) =>
            (
              await call("/receipt-ocr/jobs", {
                fileName: `photo-${photo}.png`,
                contentType: "text/plain",
                extractedText: `CASH SALE photo ${photo}`,
                structuredExtraction: fields({ number })
              })
            ).body as ReceiptOCRJobSummary
        )
      );
      const results = await Promise.all(
        drafts.map((job) =>
          call(`/receipt-ocr/jobs/${job.id}/confirm`, {
            createSupplier: true,
            receiveInventory: true
          })
        )
      );
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      expect(results.find((result) => result.status === 409)?.body.code).toBe("receipt_duplicate");
      // What confirmation decided survives the database (migration 143), and the index refuses
      // a second row with the same fingerprint, whatever writes it.
      const relational = await pool.query(
        "select * from purchase_receipts where business_id = $1::uuid",
        [businessId]
      );
      expect(relational.rows).toHaveLength(1);
      const saved = relational.rows[0]!;
      expect(saved).toMatchObject({
        document_type: "purchase_receipt",
        document_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u)
      });
      await expect(
        pool.query(
          `insert into purchase_receipts (id, business_id, supplier_id, supplier_name, receipt_date,
             total, image_stored, created_at, document_fingerprint)
           values ($1, $2, $3, $4, now(), 1, false, now(), $5)`,
          [
            randomUUID(),
            businessId,
            saved.supplier_id,
            saved.supplier_name,
            saved.document_fingerprint
          ]
        )
      ).rejects.toThrow(/purchase_receipts_document_fingerprint_idx/u);
    } finally {
      await pool.end();
    }
  }, 60_000);
});

describe.skipIf(!databaseUrl)("what confirmation decided survives a restart (PostgreSQL)", () => {
  it("reloads the document type, derived values, acknowledgements and fingerprints", async () => {
    const first = await createPostgresCp2Store({ databaseUrl: databaseUrl! });
    let receiptId = "";
    try {
      const owner = first.continueWithChannelPin({
        channel: "email",
        destination: `restart-${randomUUID()}@example.invalid`,
        pin: "3927"
      });
      const businessId = first.createBusiness({
        sessionId: owner.session.id,
        name: `Restart shop ${randomUUID().slice(0, 8)}`,
        language: "en",
        phoneNumber: `+2547${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
        phoneCountry: "KE"
      }).business.id;
      const extraction = fields({ number: `R-${randomUUID().slice(0, 8)}` });
      extraction.products[0]!.lineTotal = 1800; // misprinted, ticked as checked
      extraction.receipt.total = 1800;
      const job = first.createReceiptOCRJob({
        sessionId: owner.session.id,
        businessId,
        sourceFileName: "restart.png",
        contentType: "text/plain",
        extractedText: "CASH SALE",
        structuredExtraction: extraction
      } as never);
      const receipt = first.confirmReceiptOCRJob({
        sessionId: owner.session.id,
        businessId,
        ocrJobId: job.id,
        createSupplier: true,
        acknowledgedDiscrepancies: ["products.0.lineTotal"]
      });
      receiptId = receipt.id;
      await first.flush();
    } finally {
      await first.close();
    }
    const second = await createPostgresCp2Store({ databaseUrl: databaseUrl! });
    try {
      const reloaded = second.snapshot().purchaseReceipts.find((item) => item.id === receiptId);
      expect(reloaded).toMatchObject({
        documentType: "purchase_receipt",
        acknowledgedDiscrepancies: ["products.0.lineTotal"],
        documentFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        contentFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        confirmedDifferentFrom: null
      });
      // The date and total were printed, so nothing was filled in.
      expect(reloaded?.derivedFields).toEqual([]);
    } finally {
      await second.close();
    }
  }, 60_000);
});
