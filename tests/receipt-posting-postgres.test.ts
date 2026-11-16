import { randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const { Pool } = createRequire(new URL("../services/api/package.json", import.meta.url))("pg");
import { describe, expect, it } from "vitest";
import { createPostgresCp2Store } from "../services/api/src/cp2/postgres-store";
import {
  buildReceiptStructuredExtraction,
  parseReceiptText
} from "../services/api/src/cp2/domains/suppliers/shared";

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("receipt posting PostgreSQL persistence", () => {
  it("retains reviewed document and verified conversion across database reloads", async () => {
    let store = await createPostgresCp2Store({ databaseUrl: databaseUrl! });
    try {
      const owner = store.signupWithPhonePin({
        destination: `+2547${randomInt(10000000, 99999999)}`,
        pin: "3927"
      });
      const business = store.createBusiness({
        sessionId: owner.session.id,
        name: "Receipt database test",
        language: "en"
      }).business;
      const input = { sessionId: owner.session.id, businessId: business.id };
      const product = store.createProduct({
        ...input,
        product: { name: "Milk", unit: "packet", quantity: 0 }
      });
      const packaging = store.executeSourceCommerce(input, "packaging.verify", {
        productId: product.id,
        packUnit: "carton",
        unitsPerPack: 12,
        confirmed: true
      });
      const fields = buildReceiptStructuredExtraction(
        parseReceiptText("Supplier: Acacia\nDate: 2026-11-16\nMilk,5,1200,6000\nTotal: 6000")
      );
      fields.documentType = "invoice";
      fields.fulfillmentStatus = "received";
      fields.receipt.receiptNumber = randomUUID();
      fields.products[0]!.unit = "carton";
      const job = store.createReceiptOCRJob({
        ...input,
        sourceFileName: "milk.txt",
        contentType: "text/plain",
        extractedText: "Milk receipt",
        structuredExtraction: fields
      });
      await store.flush();
      await store.close();
      store = await createPostgresCp2Store({ databaseUrl: databaseUrl! });
      const receipt = store.confirmReceiptOCRJob({
        ...input,
        ocrJobId: job.id,
        createSupplier: true,
        receiveInventory: true
      });
      await store.flush();
      await store.close();
      store = await createPostgresCp2Store({ databaseUrl: databaseUrl! });
      expect(store.snapshot().products.find((p) => p.id === product.id)?.quantity).toBe(60);
      expect(
        store.snapshot().receiptOCRJobs.find((j) => j.id === job.id)?.structuredExtraction
          .deliveryBinding?.products[0]
      ).toMatchObject({ packagingId: packaging.id, stockQuantity: 60 });
      expect(
        store.confirmReceiptOCRJob({ ...input, ocrJobId: job.id, receiveInventory: true }).id
      ).toBe(receipt.id);
      await store.flush();
      expect(store.snapshot().products.find((p) => p.id === product.id)?.quantity).toBe(60);
    } finally {
      await store.close();
    }
  }, 60000);

  it("enforces packaging uniqueness and validates migration rollback without deleting evidence", async () => {
    const pool = new Pool({ connectionString: databaseUrl! });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const businessId = randomUUID();
      const record = {
        id: randomUUID(),
        businessId,
        kind: "packaging",
        status: "active",
        productId: randomUUID(),
        packUnit: "carton",
        baseUnit: "packet",
        unitsPerPack: 12,
        verifiedBy: randomUUID(),
        verifiedAt: new Date().toISOString()
      };
      await client.query(
        "insert into cp2_unified_commerce_records(entity_id,business_id,record) values($1,$2,$3)",
        [record.id, businessId, record]
      );
      await client.query("savepoint duplicate_check");
      const duplicate = { ...record, id: randomUUID() };
      await expect(
        client.query(
          "insert into cp2_unified_commerce_records(entity_id,business_id,record) values($1,$2,$3)",
          [duplicate.id, businessId, duplicate]
        )
      ).rejects.toMatchObject({ code: "23505" });
      await client.query("rollback to savepoint duplicate_check");
      await client.query("savepoint invalid_check");
      await expect(
        client.query(
          "update cp2_unified_commerce_records set record = jsonb_set(record, '{unitsPerPack}', '1.5'::jsonb) where entity_id=$1",
          [record.id]
        )
      ).rejects.toMatchObject({ code: "23514" });
      await client.query("rollback to savepoint invalid_check");
      await client.query(
        await readFile(
          new URL("../infra/db/rollbacks/137_receipt_verified_packaging.down.sql", import.meta.url),
          "utf8"
        )
      );
      expect(
        (
          await client.query("select record from cp2_unified_commerce_records where entity_id=$1", [
            record.id
          ])
        ).rows[0].record.unitsPerPack
      ).toBe(12);
    } finally {
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  });
});
