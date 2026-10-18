import { receiptNetwork } from "../services/api/src/cp2/domains/suppliers/receipt-network";
import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  buildReceiptStructuredExtraction,
  parseReceiptText
} from "../services/api/src/cp2/domains/suppliers/shared";
import {
  parseReceiptFields,
  restoreReceiptJobFields
} from "../services/api/src/cp2/domains/suppliers/receipt-fields";

function fields() {
  const f = buildReceiptStructuredExtraction(parseReceiptText(""));
  Object.assign(f.supplier, {
    supplierName: "Acacia Wholesale",
    phoneNumber: "+254712345678",
    email: "orders@acacia.example"
  });
  Object.assign(f.salesAgent, {
    name: "Jane Agent",
    phoneNumber: "+254722345678",
    email: "jane@acacia.example"
  });
  Object.assign(f.receipt, {
    receiptNumber: "DEL-77",
    purchaseDate: "2026-10-17",
    currency: "KES",
    total: 570
  });
  f.products = [
    {
      itemName: "Rice",
      itemCode: "R-1",
      sku: "RICE-1",
      quantity: 2,
      unit: "bag",
      unitPrice: 180,
      lineTotal: 360,
      batchNumber: "B-7",
      expiryDate: "2027-10-17"
    },
    {
      itemName: "Soap",
      itemCode: null,
      sku: "SOAP-1",
      quantity: 3,
      unit: "bar",
      unitPrice: 70,
      lineTotal: 210,
      batchNumber: null,
      expiryDate: null
    }
  ];
  return f;
}
async function fixture() {
  const store = createCp2Store();
  const app = buildApi({ cp2: { store } });
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    payload: { method: "phone", contact: "+254712000077", pin: "1234" }
  });
  const cookies = signup.headers["set-cookie"];
  const cookie = (Array.isArray(cookies) ? cookies[0] : cookies)!.split(";")[0]!;
  const response = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: { cookie },
    payload: { name: "Receipt shop", language: "en" }
  });
  const businessId = response.json().business.id;
  const call = (path: string, payload?: unknown, method = "POST") =>
    app.inject({
      method: method as "POST",
      url: `/businesses/${businessId}${path}`,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload })
    });
  return { app, store, businessId, cookie, call };
}
describe("delivery receipt field routing and document bindings", () => {
  it.each([
    ["product-management", "productId"],
    ["supplier-management", "supplierId"],
    ["customer-management", "customerId"],
    ["invoice-management", "customerName"],
    ["payment-management", "customerName"],
    ["import-management", "importJobId"],
    ["logistics-management", "customerName"]
  ])("persists and reloads the %s tool result card in canonical chat", async (type, field) => {
    const { app, businessId, cookie } = await fixture();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/v1/conversations",
        headers: { cookie },
        payload: { kind: "personal", activeShopId: businessId, title: "Delivery review" }
      });
      expect(created.statusCode, created.body).toBe(200);
      const conversationId = created.json().conversation.id;
      const content = { type, businessId, [field]: "review-target" };
      const posted = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { cookie },
        payload: {
          conversationId,
          clientMessageId: "receipt-review-card",
          author: "agent",
          content
        }
      });
      expect(posted.statusCode, posted.body).toBe(200);
      expect(posted.json().content).toEqual(content);
      const loaded = await app.inject({
        method: "GET",
        url: `/v1/conversations/${conversationId}`,
        headers: { cookie }
      });
      expect(loaded.json().messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ content })])
      );
    } finally {
      await app.close();
    }
  });
  it("prefills fields, receives stock once, and binds the document to the right wholesaler, agent and products", async () => {
    const { app, store, businessId, call } = await fixture();
    try {
      const draft = await call("/receipt-ocr/jobs", {
        fileName: "delivery.png",
        contentType: "image/png",
        extractedText: "A layout the legacy regex parser cannot interpret",
        structuredExtraction: fields(),
        engine: "gpt-6-luna"
      });
      expect(draft.statusCode, draft.body).toBe(200);
      const job = draft.json();
      expect(job.items).toHaveLength(2);
      expect(job.supplierName).toBe("Acacia Wholesale");
      expect(job.structuredExtraction.salesAgent.phoneNumber).toBe("+254722345678");
      expect((await call("/products", undefined, "GET")).json()).toHaveLength(0);
      const confirm = () =>
        call(`/receipt-ocr/jobs/${job.id}/confirm`, {
          createSupplier: true,
          createSalesAgent: true,
          receiveInventory: true
        });
      const saved = await confirm();
      expect(saved.statusCode, saved.body).toBe(200);
      const receipt = saved.json();
      const products = (await call("/products", undefined, "GET")).json();
      expect(products).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Rice", sku: "RICE-1", quantity: 2, buyingPrice: 180 }),
          expect.objectContaining({ name: "Soap", quantity: 3 })
        ])
      );
      const suppliers = (await call("/suppliers", undefined, "GET")).json();
      expect(suppliers[0]).toMatchObject({
        name: "Acacia Wholesale",
        phone: "+254712345678",
        email: "orders@acacia.example"
      });
      expect(suppliers[0].salesAgents[0]).toMatchObject({
        name: "Jane Agent",
        phone: "+254722345678"
      });
      const network = await call(`/purchase-receipts/${receipt.id}/network`, undefined, "GET");
      expect(network.statusCode, network.body).toBe(200);
      expect(
        network.json().nodes.filter((n: { kind: string }) => n.kind === "product")
      ).toHaveLength(2);
      expect(network.json().edges).toContainEqual({
        from: receipt.id,
        to: receipt.supplierId,
        relation: "supplied_by"
      });
      expect((await confirm()).json().id).toBe(receipt.id);
      expect(
        (await call("/products", undefined, "GET"))
          .json()
          .find((p: { sku: string }) => p.sku === "RICE-1").quantity
      ).toBe(2);
      const restored = createCp2Store();
      const snapshot = store.snapshot();
      snapshot.receiptLineItems.reverse();
      restored.hydrateSnapshot(snapshot);
      const restoredJob = restored.snapshot().receiptOCRJobs.find((j) => j.id === job.id)!;
      expect(restoredJob.businessId).toBe(businessId);
      expect(restoredJob.structuredExtraction.deliveryBinding?.purchaseReceiptId).toBe(receipt.id);
      const restoredReceipt = restored.getPurchaseReceipt({
        sessionId: snapshot.sessions[0]!.id,
        businessId,
        receiptId: receipt.id
      });
      const restoredNetwork = receiptNetwork(restoredReceipt, restoredJob);
      expect(restoredNetwork.nodes.find((node) => node.label === "Rice")?.id).toBe(
        products.find((p: { name: string }) => p.name === "Rice").id
      );
    } finally {
      await app.close();
    }
  });
  it("persists corrections before confirmation and rejects invalid quantities", async () => {
    const { app, call } = await fixture();
    try {
      const draft = (
        await call("/receipt-ocr/jobs", {
          fileName: "delivery.png",
          contentType: "image/png",
          extractedText: "Delivery",
          structuredExtraction: fields()
        })
      ).json();
      const corrected = fields();
      corrected.salesAgent.phoneNumber = "+254733345678";
      corrected.products[0]!.quantity = 4;
      corrected.products[0]!.lineTotal = 720;
      const patch = await call(
        `/receipt-ocr/jobs/${draft.id}`,
        { extractedText: "Delivery", structuredExtraction: corrected },
        "PATCH"
      );
      expect(patch.statusCode, patch.body).toBe(200);
      expect(patch.json().items[0].quantity).toBe(4);
      corrected.products[0]!.quantity = -1;
      expect(
        (
          await call(
            `/receipt-ocr/jobs/${draft.id}`,
            { extractedText: "Delivery", structuredExtraction: corrected },
            "PATCH"
          )
        ).statusCode
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it("restores normalized SQL receipt fields and keeps supplier and agent phones separate", () => {
    const f = fields();
    const parsed = restoreReceiptJobFields(f, undefined, "Unstructured text");
    expect(parsed.items.map((i) => i.quantity)).toEqual([2, 3]);
    expect(parsed.total).toBe(570);
    expect(parsed.receiptDate).toBe("2026-10-17");
    expect(
      parseReceiptFields({ ...f, deliveryBinding: { purchaseReceiptId: "forged" } }).deliveryBinding
    ).toBeUndefined();
    expect(parseReceiptFields(f).salesAgent.phoneNumber).toBe("+254722345678");
    expect(() => parseReceiptFields({ ...f, receipt: { ...f.receipt, total: "570" } })).toThrow();
  });
});
