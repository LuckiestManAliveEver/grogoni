import { describe, expect, it } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  buildReceiptStructuredExtraction,
  parseReceiptText
} from "../services/api/src/cp2/domains/suppliers/shared";
import { validateReceiptFinances } from "../services/api/src/cp2/domains/receipt-commerce/financial-validation";

function fields() {
  const result = buildReceiptStructuredExtraction(
    parseReceiptText("Supplier: Acacia\nDate: 2026-11-16\nRice,2,100,200\nTotal: 200")
  );
  return result;
}
function fixture() {
  const store = createCp2Store();
  const owner = store.signupWithPhonePin({ destination: "+254712346792", pin: "3927" });
  const business = store.createBusiness({
    sessionId: owner.session.id,
    name: "Validation shop",
    language: "en"
  }).business;
  const input = { sessionId: owner.session.id, businessId: business.id };
  const job = store.createReceiptOCRJob({
    ...input,
    sourceFileName: "receipt.txt",
    contentType: "text/plain",
    extractedText: "Supplier: Acacia\nRice,2,100,200\nTotal: 200",
    structuredExtraction: {
      ...fields(),
      products: fields().products.map((p) => ({ ...p, unit: "packet" }))
    }
  });
  return { store, input, job };
}

describe("receipt posting financial validation", () => {
  it("checks tax, discount, partial payment and balance independently", () => {
    const f = fields();
    Object.assign(f.receipt, {
      subtotal: 200,
      discount: 10,
      tax: 30.4,
      taxBasis: "exclusive",
      total: 220.4,
      amountPaid: 100,
      balance: 120.4
    });
    expect(validateReceiptFinances(f)).toEqual([]);
    f.receipt.balance = 120;
    expect(validateReceiptFinances(f).map((f) => f.field)).toContain("receipt.balance");
    f.receipt.total = 200;
    expect(validateReceiptFinances(f).map((f) => f.field)).toContain("receipt.total");
  });
  it.each([NaN, Infinity, -1, 1.001, Number.MAX_SAFE_INTEGER])(
    "rejects unsupported financial values: %s",
    (value) => {
      const f = fields();
      f.products[0]!.unitPrice = value;
      expect(validateReceiptFinances(f).length).toBeGreaterThan(0);
    }
  );
  it("does not derive missing grand totals and detects line arithmetic", () => {
    const f = fields();
    f.receipt.total = null;
    f.products[0]!.lineTotal = 190;
    expect(validateReceiptFinances(f).map((f) => f.field)).toEqual(
      expect.arrayContaining(["receipt.total", "products.0.lineTotal"])
    );
  });
  it("blocks before creating supplier, receipt or stock and permits corrected retry", () => {
    const { store, input, job } = fixture();
    const f = structuredClone(job.structuredExtraction);
    f.products[0]!.lineTotal = 999;
    store.correctReceiptOCRJob({
      ...input,
      ocrJobId: job.id,
      extractedText: job.fullText,
      structuredExtraction: { ...f, documentType: "invoice", fulfillmentStatus: "received" }
    });
    const before = store.snapshot();
    expect(() =>
      store.confirmReceiptOCRJob({
        ...input,
        ocrJobId: job.id,
        createSupplier: true,
        receiveInventory: true
      })
    ).toThrow(/line total/);
    expect(store.snapshot()).toEqual(before);
    f.products[0]!.lineTotal = 200;
    store.correctReceiptOCRJob({
      ...input,
      ocrJobId: job.id,
      extractedText: job.fullText,
      structuredExtraction: { ...f, documentType: "invoice", fulfillmentStatus: "received" }
    });
    const receipt = store.confirmReceiptOCRJob({
      ...input,
      ocrJobId: job.id,
      createSupplier: true,
      receiveInventory: true
    });
    expect(receipt.total).toBe(200);
    expect(
      store.confirmReceiptOCRJob({ ...input, ocrJobId: job.id, receiveInventory: true }).id
    ).toBe(receipt.id);
  });
  it("rejects carton-to-packet addition before any mutations", () => {
    const { store, input, job } = fixture();
    store.createProduct({ ...input, product: { name: "Rice", unit: "packet", quantity: 10 } });
    const f = structuredClone(job.structuredExtraction);
    f.products[0]!.unit = "carton";
    store.correctReceiptOCRJob({
      ...input,
      ocrJobId: job.id,
      extractedText: job.fullText,
      structuredExtraction: { ...f, documentType: "invoice", fulfillmentStatus: "received" }
    });
    const before = store.snapshot();
    expect(() =>
      store.confirmReceiptOCRJob({
        ...input,
        ocrJobId: job.id,
        createSupplier: true,
        receiveInventory: true
      })
    ).toThrow(/pack conversion/);
    expect(store.snapshot()).toEqual(before);
  });
  it("evaluates decimal rounding over a grid of receipt amounts", () => {
    for (const quantity of [0.125, 0.5, 1, 3, 12])
      for (const price of [0.01, 0.29, 9.99, 1200]) {
        const f = fields();
        const total = Math.round(quantity * Math.round(price * 100)) / 100;
        Object.assign(f.products[0]!, { quantity, unitPrice: price, lineTotal: total });
        f.receipt.total = total;
        expect(validateReceiptFinances(f), `${quantity} x ${price}`).toEqual([]);
        f.products[0]!.lineTotal += 0.03;
        expect(validateReceiptFinances(f).some((f) => f.field === "products.0.lineTotal")).toBe(
          true
        );
      }
  });
});

describe("receipt classification and fulfillment authorization", () => {
  it.each([
    "unknown",
    "quotation",
    "pro_forma_invoice",
    "return_receipt",
    "credit_note",
    "payment_receipt",
    "refund_receipt"
  ] as const)("rejects %s through the real purchase writer", (documentType) => {
    const { store, input, job } = fixture();
    store.correctReceiptOCRJob({
      ...input,
      ocrJobId: job.id,
      extractedText: job.fullText,
      structuredExtraction: {
        ...job.structuredExtraction,
        documentType,
        fulfillmentStatus: "received"
      }
    });
    const before = store.snapshot();
    expect(() =>
      store.confirmReceiptOCRJob({
        ...input,
        ocrJobId: job.id,
        createSupplier: true,
        receiveInventory: true
      })
    ).toThrow(/Classify/);
    expect(store.snapshot()).toEqual(before);
  });
  it("requires explicit delivery verification independently of document type", () => {
    const { store, input, job } = fixture();
    store.correctReceiptOCRJob({
      ...input,
      ocrJobId: job.id,
      extractedText: job.fullText,
      structuredExtraction: {
        ...job.structuredExtraction,
        documentType: "invoice",
        fulfillmentStatus: "pending"
      }
    });
    const before = store.snapshot();
    expect(() =>
      store.confirmReceiptOCRJob({
        ...input,
        ocrJobId: job.id,
        createSupplier: true,
        receiveInventory: true
      })
    ).toThrow(/goods were received/);
    expect(store.snapshot()).toEqual(before);
    expect(
      store.confirmReceiptOCRJob({ ...input, ocrJobId: job.id, createSupplier: true }).total
    ).toBe(200);
    expect(store.snapshot().inventoryMovements).toHaveLength(0);
    expect(store.snapshot().payments).toHaveLength(0);
  });
  it("blocks renamed/changed scans of the same supplier document after snapshot restore", () => {
    const { store, input, job } = fixture();
    const f = {
      ...job.structuredExtraction,
      documentType: "invoice" as const,
      fulfillmentStatus: "received" as const
    };
    f.receipt.receiptNumber = "INV-77";
    f.products[0]!.unit = "packet";
    store.correctReceiptOCRJob({
      ...input,
      ocrJobId: job.id,
      extractedText: job.fullText,
      structuredExtraction: f
    });
    const first = store.confirmReceiptOCRJob({
      ...input,
      ocrJobId: job.id,
      createSupplier: true,
      receiveInventory: true
    });
    const restored = createCp2Store();
    restored.hydrateSnapshot(store.snapshot());
    const duplicate = restored.createReceiptOCRJob({
      ...input,
      sourceFileName: "cropped-new-photo.txt",
      contentType: "text/plain",
      extractedText: "Acacia changed photograph",
      structuredExtraction: f
    });
    const before = restored.snapshot();
    expect(() =>
      restored.confirmReceiptOCRJob({
        ...input,
        ocrJobId: duplicate.id,
        supplierId: first.supplierId,
        receiveInventory: true
      })
    ).toThrow(/already recorded/);
    expect(restored.snapshot()).toEqual(before);
  });
});

describe("verified pack conversions through receipt confirmation", () => {
  it("posts 5 cartons as 60 packets, retains provenance and survives restore", () => {
    const { store, input, job } = fixture();
    const product = store.createProduct({
      ...input,
      product: { name: "Rice", unit: "packet", quantity: 0 }
    });
    const packaging = store.executeSourceCommerce(input, "packaging.verify", {
      productId: product.id,
      packUnit: "carton",
      unitsPerPack: 12,
      confirmed: true
    });
    const f = structuredClone(job.structuredExtraction);
    f.documentType = "invoice";
    f.fulfillmentStatus = "received";
    Object.assign(f.products[0]!, {
      quantity: 5,
      unit: "carton",
      unitPrice: 1200,
      lineTotal: 6000
    });
    f.receipt.total = 6000;
    store.correctReceiptOCRJob({
      ...input,
      ocrJobId: job.id,
      extractedText: job.fullText,
      structuredExtraction: f
    });
    const restored = createCp2Store();
    restored.hydrateSnapshot(store.snapshot());
    restored.confirmReceiptOCRJob({
      ...input,
      ocrJobId: job.id,
      createSupplier: true,
      receiveInventory: true
    });
    expect(restored.snapshot().products.find((p) => p.id === product.id)?.quantity).toBe(60);
    expect(
      restored.snapshot().receiptOCRJobs.find((j) => j.id === job.id)?.structuredExtraction
        .deliveryBinding?.products[0]
    ).toMatchObject({
      packagingId: packaging.id,
      receiptQuantity: 5,
      stockQuantity: 60,
      stockUnit: "packet"
    });
    restored.confirmReceiptOCRJob({ ...input, ocrJobId: job.id, receiveInventory: true });
    expect(restored.snapshot().products.find((p) => p.id === product.id)?.quantity).toBe(60);
  });
  it("requires explicit verification and rejects revoked definitions on retry", () => {
    const { store, input, job } = fixture();
    const product = store.createProduct({
      ...input,
      product: { name: "Rice", unit: "packet", quantity: 0 }
    });
    expect(() =>
      store.executeSourceCommerce(input, "packaging.verify", {
        productId: product.id,
        packUnit: "carton",
        unitsPerPack: 12
      })
    ).toThrow(/explicitly/);
    const packaging = store.executeSourceCommerce(input, "packaging.verify", {
      productId: product.id,
      packUnit: "carton",
      unitsPerPack: 12,
      confirmed: true
    });
    store.executeSourceCommerce(input, "packaging.revoke", { id: packaging.id });
    const f = {
      ...job.structuredExtraction,
      documentType: "invoice" as const,
      fulfillmentStatus: "received" as const
    };
    f.products[0]!.unit = "carton";
    store.correctReceiptOCRJob({
      ...input,
      ocrJobId: job.id,
      extractedText: job.fullText,
      structuredExtraction: f
    });
    const before = store.snapshot();
    expect(() =>
      store.confirmReceiptOCRJob({
        ...input,
        ocrJobId: job.id,
        createSupplier: true,
        receiveInventory: true
      })
    ).toThrow(/pack conversion/);
    expect(store.snapshot()).toEqual(before);
  });
  it.each([0, -1, 1.5, Infinity, 1000001])("rejects invalid packaging count %s", (unitsPerPack) => {
    const { store, input } = fixture();
    const product = store.createProduct({ ...input, product: { name: "Rice", unit: "packet" } });
    expect(() =>
      store.executeSourceCommerce(input, "packaging.verify", {
        productId: product.id,
        packUnit: "carton",
        unitsPerPack,
        confirmed: true
      })
    ).toThrow(/integer/);
  });
});

it("keeps calculated totals explicit and never supplies today's receipt date", () => {
  const derived = buildReceiptStructuredExtraction(
    parseReceiptText("Supplier: Acacia\nRice,2,100\nTotal: 200")
  );
  expect(derived.products[0]).toMatchObject({ lineTotal: 200, lineTotalSource: "derived" });
  expect(validateReceiptFinances(derived).map((f) => f.field)).toContain(
    "products.0.lineTotalSource"
  );
  const { store, input, job } = fixture();
  const f = { ...job.structuredExtraction, documentType: "invoice" as const };
  f.receipt.purchaseDate = null;
  store.correctReceiptOCRJob({
    ...input,
    ocrJobId: job.id,
    extractedText: job.fullText,
    structuredExtraction: f
  });
  const before = store.snapshot();
  expect(() =>
    store.confirmReceiptOCRJob({ ...input, ocrJobId: job.id, createSupplier: true })
  ).toThrow(/receipt date/);
  expect(store.snapshot()).toEqual(before);
});

it("treats date-only receipts and unreadable telephone numbers as missing phones", () => {
  expect(
    parseReceiptText("Supplier: Acacia\nDate: 2026-11-16\nRice,2,100,200\nTotal: 200").phone
  ).toBeNull();
  expect(parseReceiptText("Supplier: Acacia\nPhone: 12345678\nRice,2,100,200").phone).toBeNull();
});

it("validates explicit line discounts and inclusive tax without inventing a tax basis", () => {
  const f = fields();
  Object.assign(f.products[0]!, { lineDiscount: 20, lineTotal: 180 });
  Object.assign(f.receipt, { subtotal: 180, tax: 24.83, total: 180, taxBasis: "inclusive" });
  expect(validateReceiptFinances(f)).toEqual([]);
  f.receipt.taxBasis = "unknown";
  expect(validateReceiptFinances(f).map((f) => f.field)).toContain("receipt.taxBasis");
  f.receipt.taxBasis = "inclusive";
  f.products[0]!.lineDiscount = 10;
  expect(validateReceiptFinances(f).map((f) => f.field)).toContain("products.0.lineTotal");
});

it.each([
  ["KES 1,200.50", 1200.5],
  ["1,200", 1200],
  ["1200,50", 1200.5],
  ["-200", null],
  ["1,20,0", null],
  ["1.234", null]
])("parses receipt money without truncating %s", (printed, expected) => {
  expect(parseReceiptText(`Supplier: Acacia\nTotal: ${printed}`).total).toBe(expected);
});
it("uses Kenyan calendar dates and rejects invalid or ambiguous dates", () => {
  expect(parseReceiptText("Supplier: Acacia\nDate: 31/12/2026").receiptDate).toBe(
    "2026-12-31T00:00:00.000Z"
  );
  expect(parseReceiptText("Supplier: Acacia\nDate: 2026-02-31").receiptDate).toBeNull();
  expect(parseReceiptText("Supplier: Acacia\nDate: 01/02/26").receiptDate).toBeNull();
});

it("cannot turn an already recorded unfulfilled invoice into stock through a retry", () => {
  const { store, input, job } = fixture();
  store.correctReceiptOCRJob({
    ...input,
    ocrJobId: job.id,
    extractedText: job.fullText,
    structuredExtraction: {
      ...job.structuredExtraction,
      documentType: "invoice",
      fulfillmentStatus: "pending"
    }
  });
  store.confirmReceiptOCRJob({ ...input, ocrJobId: job.id, createSupplier: true });
  const before = store.snapshot();
  expect(() =>
    store.confirmReceiptOCRJob({ ...input, ocrJobId: job.id, receiveInventory: true })
  ).toThrow(/goods were received/);
  expect(store.snapshot()).toEqual(before);
});

it("rejects sub-thousandth quantities and excessive discounts even inside rounding tolerance", () => {
  const f = fields();
  f.products[0]!.quantity = 0.0001;
  expect(validateReceiptFinances(f).map((f) => f.field)).toContain("products.0.quantity");
  Object.assign(f.products[0]!, { quantity: 1, unitPrice: 1, lineDiscount: 1.01, lineTotal: 0 });
  f.receipt.total = 0;
  expect(validateReceiptFinances(f).map((f) => f.field)).toContain("products.0.lineTotal");
});
