import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

interface VerifyOtpResponse {
  session: {
    id: string;
  };
}

interface CreateBusinessResponse {
  business: {
    id: string;
  };
}

interface ProductResponse {
  id: string;
  quantity: number;
}

interface CustomerResponse {
  id: string;
  name: string;
}

interface InvoiceResponse {
  id: string;
  businessId: string;
  invoiceNumber: string;
  status: "draft" | "confirmed";
  customerId: string | null;
  customerName: string | null;
  subtotal: number;
  taxRate: number;
  taxTotal: number;
  total: number;
  items: Array<{
    productId: string;
    productName: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }>;
}

interface ConfirmInvoiceResponse {
  invoice: InvoiceResponse;
  movements: Array<{
    productId: string;
    type: "sale";
    quantityBefore: number;
    quantityAfter: number;
    delta: number;
    reason: string;
  }>;
}

describe("CP6 invoice and inventory flow", () => {
  it("previews, saves, confirms, and lists invoices with deterministic stock movement", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const product = await postJson<ProductResponse>(
      app,
      `/businesses/${businessId}/products`,
      {
        name: "Maize Flour",
        unit: "packet",
        quantity: 5
      },
      sessionCookie
    );
    const customer = await postJson<CustomerResponse>(
      app,
      `/businesses/${businessId}/customers`,
      {
        name: "Amina Otieno"
      },
      sessionCookie
    );
    const invoicePayload = {
      customerId: customer.id,
      taxRate: 0.1,
      items: [
        {
          productId: product.id,
          quantity: 2,
          unitPrice: 100
        }
      ]
    };

    const preview = await postJson<InvoiceResponse>(
      app,
      `/businesses/${businessId}/invoices/preview`,
      invoicePayload,
      sessionCookie
    );

    expect(preview).toMatchObject({
      businessId,
      customerId: customer.id,
      customerName: "Amina Otieno",
      subtotal: 200,
      taxRate: 0.1,
      taxTotal: 20,
      total: 220
    });
    expect(store.snapshot().products.find((item) => item.id === product.id)?.quantity).toBe(5);
    expect(store.snapshot().inventoryMovements).toHaveLength(1);

    const draft = await postJson<InvoiceResponse>(
      app,
      `/businesses/${businessId}/invoices`,
      invoicePayload,
      sessionCookie
    );

    expect(draft).toMatchObject({
      invoiceNumber: "INV-00001",
      status: "draft",
      total: 220
    });
    expect(store.snapshot().products.find((item) => item.id === product.id)?.quantity).toBe(5);

    const confirmation = await postJson<ConfirmInvoiceResponse>(
      app,
      `/businesses/${businessId}/invoices/${draft.id}/confirm`,
      {},
      sessionCookie
    );

    expect(confirmation.invoice).toMatchObject({
      id: draft.id,
      status: "confirmed",
      invoiceNumber: "INV-00001"
    });
    expect(confirmation.movements).toEqual([
      expect.objectContaining({
        productId: product.id,
        type: "sale",
        quantityBefore: 5,
        quantityAfter: 3,
        delta: -2,
        reason: "Invoice INV-00001"
      })
    ]);
    expect(store.snapshot().products.find((item) => item.id === product.id)?.quantity).toBe(3);

    const invoices = await getJson<InvoiceResponse[]>(
      app,
      `/businesses/${businessId}/invoices`,
      sessionCookie
    );

    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      id: draft.id,
      status: "confirmed"
    });
    expect(store.snapshot().auditEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining(["invoice.created", "invoice.confirmed", "inventory.stock_adjusted"])
    );

    await app.close();
  });

  it("rejects oversold and cross-business invoice confirmation", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const { businessId: secondBusinessId, sessionCookie: secondSessionCookie } =
      await createOwnerBusiness(app, {
        contact: "254700000106",
        businessName: "Second Shop"
      });
    const product = await postJson<ProductResponse>(
      app,
      `/businesses/${businessId}/products`,
      {
        name: "Rice",
        quantity: 1
      },
      sessionCookie
    );
    const draft = await postJson<InvoiceResponse>(
      app,
      `/businesses/${businessId}/invoices`,
      {
        items: [
          {
            productId: product.id,
            quantity: 2,
            unitPrice: 50
          }
        ]
      },
      sessionCookie
    );

    const oversold = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/invoices/${draft.id}/confirm`,
      headers: {
        ...jsonHeaders(),
        cookie: sessionCookie
      },
      payload: JSON.stringify({})
    });

    expect(oversold.statusCode).toBe(409);
    expect(oversold.json()).toMatchObject({
      code: "stock_insufficient"
    });
    expect(store.snapshot().products.find((item) => item.id === product.id)?.quantity).toBe(1);

    const crossBusinessConfirm = await app.inject({
      method: "POST",
      url: `/businesses/${secondBusinessId}/invoices/${draft.id}/confirm`,
      headers: {
        ...jsonHeaders(),
        cookie: secondSessionCookie
      },
      payload: JSON.stringify({})
    });

    expect(crossBusinessConfirm.statusCode).toBe(404);
    expect(crossBusinessConfirm.json()).toMatchObject({
      code: "invoice_not_found"
    });

    await app.close();
  });

  it("rejects duplicate invoice lines that oversell the same product", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const product = await postJson<ProductResponse>(
      app,
      `/businesses/${businessId}/products`,
      {
        name: "Beans",
        quantity: 5
      },
      sessionCookie
    );
    const draft = await postJson<InvoiceResponse>(
      app,
      `/businesses/${businessId}/invoices`,
      {
        items: [
          {
            productId: product.id,
            quantity: 3,
            unitPrice: 80
          },
          {
            productId: product.id,
            quantity: 3,
            unitPrice: 80
          }
        ]
      },
      sessionCookie
    );

    const duplicateLineOversell = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/invoices/${draft.id}/confirm`,
      headers: {
        ...jsonHeaders(),
        cookie: sessionCookie
      },
      payload: JSON.stringify({})
    });

    expect(duplicateLineOversell.statusCode).toBe(409);
    expect(duplicateLineOversell.json()).toMatchObject({
      code: "stock_insufficient"
    });
    expect(store.snapshot().products.find((item) => item.id === product.id)?.quantity).toBe(5);
    expect(store.snapshot().invoices.find((invoice) => invoice.id === draft.id)?.status).toBe(
      "draft"
    );
    expect(
      store.snapshot().inventoryMovements.filter((movement) => movement.type === "sale")
    ).toHaveLength(0);

    await app.close();
  });

  it("does not consume invoice numbers when create validation fails", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const product = await postJson<ProductResponse>(
      app,
      `/businesses/${businessId}/products`,
      {
        name: "Sugar",
        quantity: 4
      },
      sessionCookie
    );

    const invalidCreate = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/invoices`,
      headers: {
        ...jsonHeaders(),
        cookie: sessionCookie
      },
      payload: JSON.stringify({
        items: [
          {
            productId: "missing-product",
            quantity: 1,
            unitPrice: 25
          }
        ]
      })
    });

    expect(invalidCreate.statusCode).toBe(404);
    expect(invalidCreate.json()).toMatchObject({
      code: "product_not_found"
    });

    const draft = await postJson<InvoiceResponse>(
      app,
      `/businesses/${businessId}/invoices`,
      {
        items: [
          {
            productId: product.id,
            quantity: 1,
            unitPrice: 25
          }
        ]
      },
      sessionCookie
    );

    expect(draft.invoiceNumber).toBe("INV-00001");

    await app.close();
  });
});

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  options: { contact?: string; businessName?: string } = {}
) {
  const verifyResponse = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({
      method: "phone",
      contact: options.contact ?? "254700000006",
      pin: "3927"
    })
  });
  const sessionCookie = extractSessionCookie(verifyResponse.headers["set-cookie"]);
  const auth = verifyResponse.json<VerifyOtpResponse>();
  const business = await postJson<CreateBusinessResponse>(
    app,
    "/businesses",
    {
      name: options.businessName ?? "Jane's Shop",
      language: "en"
    },
    sessionCookie
  );

  expect(auth.session.id).toBeTruthy();

  return {
    businessId: business.business.id,
    sessionCookie
  };
}

async function postJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: Record<string, unknown>,
  cookie?: string
): Promise<TResponse> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: cookie === undefined ? jsonHeaders() : { ...jsonHeaders(), cookie },
    payload: JSON.stringify(payload)
  });

  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode).toBeLessThan(300);

  return response.json<TResponse>();
}

async function getJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  cookie: string
): Promise<TResponse> {
  const response = await app.inject({
    method: "GET",
    url,
    headers: {
      cookie
    }
  });

  expect(response.statusCode).toBe(200);

  return response.json<TResponse>();
}

function jsonHeaders(): Record<string, string> {
  return {
    "content-type": "application/json"
  };
}

function extractSessionCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;

  if (value === undefined) {
    throw new Error("Expected set-cookie header.");
  }

  return value.split(";")[0] ?? value;
}
