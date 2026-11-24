import { describe, expect, it } from "vitest";
import {
  classifyReceiptText,
  receiptDocumentEffects,
  receiptDocumentTypes,
  resolveReceiptDocumentType,
  validateReceiptArithmetic,
  type ReceiptArithmeticInput
} from "../services/api/src/cp2/domains/suppliers/receipt-validation";
import { parseReceiptMoney } from "../services/api/src/cp2/domains/suppliers/shared";
import { parseReceiptFields } from "../services/api/src/cp2/domains/suppliers/receipt-fields";
import {
  buildReceiptStructuredExtraction,
  parseReceiptText
} from "../services/api/src/cp2/domains/suppliers/shared";

// Receipt-to-commerce P0: the kind of document decides what it may post; printed arithmetic is
// recomputed; derived values are never checked against themselves.

describe("document type", () => {
  it.each([
    ["PRO FORMA INVOICE\nNo. 221", "pro_forma"],
    ["QUOTATION\nValid 14 days", "quotation"],
    ["CREDIT NOTE CN-19", "credit_note"],
    ["Tax Invoice\nINV-2041", "invoice"],
    ["DELIVERY NOTE DN-7", "delivery_note"],
    ["Goods Received Note", "delivery_note"],
    ["CASH SALE\nTill 552211", "purchase_receipt"],
    ["RISITI\nDuka la Mama", "purchase_receipt"],
    ["Ankara\nNamba 7", "invoice"],
    ["Mama Mboga\n2 x sukuma 40", null]
  ])("reads %j as %s", (text, type) => {
    expect(classifyReceiptText(text)).toBe(type);
  });

  it("decides on the heading, not a footer", () => {
    expect(
      classifyReceiptText("QUOTATION\n" + "line\n".repeat(10) + "Receipt no. on payment")
    ).toBe("quotation");
  });

  it("trusts agreement, asks a person on disagreement", () => {
    expect(resolveReceiptDocumentType("purchase_receipt", "CASH SALE")).toBe("purchase_receipt");
    expect(resolveReceiptDocumentType("invoice", "Receipt")).toBe("invoice");
    expect(resolveReceiptDocumentType("delivery_receipt", "Some shop")).toBe("delivery_note");
    expect(resolveReceiptDocumentType(null, "QUOTATION")).toBe("quotation");
    expect(resolveReceiptDocumentType(null, "Some shop")).toBe("unknown");
    // The model says purchase, the paper says quotation: a person decides.
    expect(resolveReceiptDocumentType("purchase_receipt", "QUOTATION")).toBe("unknown");
    expect(resolveReceiptDocumentType("quotation", "Receipt")).toBe("unknown");
    // The buyer scans it: a seller's "sales receipt" is a purchase to them.
    expect(resolveReceiptDocumentType("sales_receipt", "Kamau Hardware")).toBe("purchase_receipt");
  });

  it("lets only purchases, deliveries and invoices post", () => {
    const posting = receiptDocumentTypes.filter(
      (type) => receiptDocumentEffects(type).recordPurchase
    );
    expect(posting).toEqual(["purchase_receipt", "delivery_note", "invoice"]);
    for (const type of receiptDocumentTypes) {
      const effects = receiptDocumentEffects(type);
      expect(effects.refusal === null).toBe(effects.recordPurchase);
      if (!effects.recordPurchase) expect(effects.receiveStock).toBe(false);
    }
  });
});

const base = (overrides: Partial<ReceiptArithmeticInput> = {}): ReceiptArithmeticInput => ({
  products: [
    { itemName: "Sugar 2kg", quantity: 5, unitPrice: 380, lineTotal: 1900 },
    { itemName: "Blueband 500g", quantity: 3, unitPrice: 250, lineTotal: 750 }
  ],
  subtotal: 2650,
  discount: null,
  tax: null,
  total: 2650,
  amountPaid: null,
  balance: null,
  derivedFields: [],
  ...overrides
});

describe("receipt arithmetic", () => {
  it("passes a receipt that adds up", () => {
    expect(validateReceiptArithmetic(base())).toEqual([]);
  });

  it("names a line whose quantity times price is not its total", () => {
    const issues = validateReceiptArithmetic(
      base({
        products: [
          { itemName: "Sugar 2kg", quantity: 5, unitPrice: 380, lineTotal: 1800 },
          { itemName: "Blueband 500g", quantity: 3, unitPrice: 250, lineTotal: 750 }
        ],
        subtotal: 2550,
        total: 2550
      })
    );
    expect(issues).toEqual([
      expect.objectContaining({
        code: "line_total_mismatch",
        field: "products.0.lineTotal",
        expected: 1900,
        printed: 1800
      })
    ]);
  });

  it("catches a subtotal and a total that do not follow from the lines", () => {
    expect(
      validateReceiptArithmetic(base({ subtotal: 2600, total: 2600 })).map((i) => i.code)
    ).toEqual(["subtotal_mismatch"]);
    expect(validateReceiptArithmetic(base({ total: 2700 })).map((i) => i.code)).toEqual([
      "total_mismatch"
    ]);
  });

  it("accepts tax inclusive or added, and a discount", () => {
    expect(validateReceiptArithmetic(base({ tax: 365.52 }))).toEqual([]); // VAT inclusive
    expect(validateReceiptArithmetic(base({ tax: 424, total: 3074 }))).toEqual([]); // VAT added
    expect(validateReceiptArithmetic(base({ discount: 150, total: 2500 }))).toEqual([]);
    expect(
      validateReceiptArithmetic(base({ discount: 150, total: 2650 })).map((i) => i.code)
    ).toEqual(["total_mismatch"]);
  });

  it("checks the balance against total and paid, change included", () => {
    expect(validateReceiptArithmetic(base({ amountPaid: 2000, balance: 650 }))).toEqual([]);
    expect(validateReceiptArithmetic(base({ amountPaid: 3000, balance: 350 }))).toEqual([]); // change
    expect(
      validateReceiptArithmetic(base({ amountPaid: 2000, balance: 600 })).map((i) => i.code)
    ).toEqual(["balance_mismatch"]);
  });

  it("tolerates half a cent of rounding and nothing more", () => {
    const products = [{ itemName: "Tomatoes", quantity: 3, unitPrice: 33.33, lineTotal: 99.99 }];
    expect(validateReceiptArithmetic(base({ products, subtotal: 99.99, total: 99.99 }))).toEqual(
      []
    );
    expect(
      validateReceiptArithmetic(
        base({ products: [{ ...products[0]!, lineTotal: 100 }], subtotal: 100, total: 100 })
      )
    ).toHaveLength(1);
  });

  it("never checks a derived value against the calculation it came from", () => {
    // The parser computed this line total (none was printed): not a confirmation of anything.
    expect(
      validateReceiptArithmetic(
        base({
          products: [{ itemName: "Sugar 2kg", quantity: 5, unitPrice: 380, lineTotal: 1800 }],
          subtotal: null,
          total: null,
          derivedFields: ["products.0.lineTotal"]
        })
      )
    ).toEqual([]);
  });
});

describe("printed amounts", () => {
  it.each([
    ["Total: KES 3,800", 3800],
    ["Total 1,234.50", 1234.5],
    ["250", 250],
    ["99.99", 99.99],
    ["12,345,678", 12345678]
  ])("reads %j as %s (thousands commas, decimal point)", (text, value) => {
    expect(parseReceiptMoney(text)).toBe(value);
  });

  it("accepts a model amount sent as text, and still refuses words", () => {
    const fields = buildReceiptStructuredExtraction(parseReceiptText(""));
    const accepted = parseReceiptFields({
      ...fields,
      receipt: { ...fields.receipt, total: "KES 3,800" }
    });
    expect(accepted.receipt.total).toBe(3800);
    expect(() =>
      parseReceiptFields({ ...fields, receipt: { ...fields.receipt, total: "about 3800" } })
    ).toThrow(/receipt.total/u);
  });
});
