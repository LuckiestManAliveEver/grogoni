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

interface SupplierResponse {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
}

interface ProductResponse {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  quantity: number;
  buyingPrice: number | null;
  sellingPrice: number | null;
}

interface ImportPreviewRowResponse {
  rowNumber: number;
  mapped: Record<string, unknown>;
  errors: string[];
  selected: boolean;
}

interface ImportJobResponse {
  id: string;
  target: "supplier" | "product";
  status: "previewed" | "confirmed" | "failed";
  source: {
    fileName: string;
    checksum: string;
    content?: string;
  };
  rows: ImportPreviewRowResponse[];
  confirmedCount: number;
  errorMessage: string | null;
}

interface ImportConfirmResponse {
  job: ImportJobResponse;
  suppliers?: SupplierResponse[];
  products?: ProductResponse[];
}

describe("CP9 document import", () => {
  it("previews, corrects, and confirms supplier CSV rows without writing before confirmation", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const importJob = await postJson<ImportJobResponse>(
      app,
      `/businesses/${businessId}/imports/supplier-csv`,
      {
        fileName: "suppliers.csv",
        contentType: "text/csv",
        sourceType: "database",
        sourceLocator: "legacy suppliers export",
        content:
          "name,phone,email,notes\nWholesale Depot,+254700000010,supply@example.com,Main supplier\nx,,bad-email,Needs correction"
      },
      sessionCookie
    );

    expect(importJob.status).toBe("previewed");
    expect(importJob.source).toMatchObject({
      fileName: "suppliers.csv",
      sourceType: "database",
      sourceLocator: "legacy suppliers export"
    });
    expect(importJob.source.content).toBeUndefined();
    expect(importJob.rows).toHaveLength(2);
    expect(importJob.rows[0]).toMatchObject({
      selected: true,
      mapped: {
        name: "Wholesale Depot",
        email: "supply@example.com"
      }
    });
    expect(importJob.rows[1].selected).toBe(false);
    expect(importJob.rows[1].errors.length).toBeGreaterThan(0);
    expect(store.snapshot().suppliers).toHaveLength(0);

    const blocked = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/imports/${importJob.id}/confirm`,
      headers: {
        ...jsonHeaders(),
        cookie: sessionCookie
      },
      payload: JSON.stringify({
        selectedRowNumbers: [1, 2]
      })
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      code: "import_rows_invalid"
    });
    expect(store.snapshot().suppliers).toHaveLength(0);

    const corrected = await patchJson<ImportJobResponse>(
      app,
      `/businesses/${businessId}/imports/${importJob.id}/rows/2`,
      {
        selected: true,
        mapped: {
          name: "Lake Produce",
          phone: "+254700000011",
          email: "lake@example.com",
          notes: "Corrected in preview"
        }
      },
      sessionCookie
    );
    expect(corrected.rows[1]).toMatchObject({
      selected: true,
      errors: [],
      mapped: {
        name: "Lake Produce",
        email: "lake@example.com"
      }
    });
    expect(store.snapshot().suppliers).toHaveLength(0);

    const confirmed = await postJson<ImportConfirmResponse>(
      app,
      `/businesses/${businessId}/imports/${importJob.id}/confirm`,
      {},
      sessionCookie
    );
    expect(confirmed.job).toMatchObject({
      status: "confirmed",
      confirmedCount: 2
    });
    expect(confirmed.suppliers?.map((supplier) => supplier.name)).toEqual([
      "Wholesale Depot",
      "Lake Produce"
    ]);
    expect(store.snapshot().suppliers).toHaveLength(2);
    expect(store.snapshot().auditEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "document_import.previewed",
        "supplier.created",
        "document_import.confirmed"
      ])
    );

    await app.close();
  });

  it("previews and confirms product catalogue rows from document and database exports", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const sheetImport = await postJson<ImportJobResponse>(
      app,
      `/businesses/${businessId}/imports/product-catalogue`,
      {
        fileName: "products.tsv",
        contentType: "text/tab-separated-values",
        content:
          "Product\tSKU\tUnit\tStock\tCost\tPrice\nTomatoes\tTOM-001\tkg\t20\t60\t90\nMaize Flour\tMAI-002\tbag\t8\t110\t145"
      },
      sessionCookie
    );

    expect(sheetImport).toMatchObject({
      target: "product",
      status: "previewed"
    });
    expect(sheetImport.rows).toHaveLength(2);
    expect(sheetImport.rows[0]).toMatchObject({
      selected: true,
      mapped: {
        name: "Tomatoes",
        sku: "TOM-001",
        quantity: 20,
        buyingPrice: 60,
        sellingPrice: 90
      }
    });

    const confirmedSheet = await postJson<ImportConfirmResponse>(
      app,
      `/businesses/${businessId}/imports/${sheetImport.id}/confirm-products`,
      {},
      sessionCookie
    );
    expect(confirmedSheet.job).toMatchObject({
      status: "confirmed",
      confirmedCount: 2
    });
    expect(confirmedSheet.products?.map((product) => product.name)).toEqual([
      "Tomatoes",
      "Maize Flour"
    ]);

    const databaseImport = await postJson<ImportJobResponse>(
      app,
      `/businesses/${businessId}/imports/product-catalogue`,
      {
        fileName: "legacy-products.sql",
        contentType: "application/sql",
        content:
          "INSERT INTO products (name, sku, unit, quantity, buying_price, selling_price) VALUES ('Rice', 'RIC-003', 'bag', 5, 120, 180);"
      },
      sessionCookie
    );
    expect(databaseImport).toMatchObject({
      target: "product",
      status: "previewed"
    });
    expect(databaseImport.rows[0]).toMatchObject({
      mapped: {
        name: "Rice",
        sku: "RIC-003",
        quantity: 5
      }
    });

    expect(store.snapshot().products.map((product) => product.name)).toEqual([
      "Tomatoes",
      "Maize Flour"
    ]);

    await app.close();
  });

  it("records failed empty imports without corrupting existing records", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const failed = await postJson<ImportJobResponse>(
      app,
      `/businesses/${businessId}/imports/supplier-csv`,
      {
        fileName: "empty.csv",
        content: "name,email\n"
      },
      sessionCookie
    );

    expect(failed).toMatchObject({
      status: "failed",
      confirmedCount: 0,
      errorMessage: "Import file does not contain data rows."
    });
    expect(store.snapshot().suppliers).toEqual([]);
    expect(store.snapshot().auditEvents.map((event) => event.type)).toContain(
      "document_import.failed"
    );

    await app.close();
  });
});

async function createOwnerBusiness(app: ReturnType<typeof buildApi>) {
  const verifyResponse = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({
      method: "phone",
      contact: "254700000009",
      pin: "3927"
    })
  });
  const sessionCookie = extractSessionCookie(verifyResponse.headers["set-cookie"]);
  const auth = verifyResponse.json<VerifyOtpResponse>();
  const business = await postJson<CreateBusinessResponse>(
    app,
    "/businesses",
    {
      name: "Jane's Shop",
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

  expect(response.statusCode).toBe(200);
  return response.json<TResponse>();
}

async function patchJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: Record<string, unknown>,
  cookie?: string
): Promise<TResponse> {
  const response = await app.inject({
    method: "PATCH",
    url,
    headers: cookie === undefined ? jsonHeaders() : { ...jsonHeaders(), cookie },
    payload: JSON.stringify(payload)
  });

  expect(response.statusCode).toBe(200);
  return response.json<TResponse>();
}

function jsonHeaders() {
  return {
    "content-type": "application/json"
  };
}

function extractSessionCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  expect(value).toBeDefined();
  return value?.split(";")[0] ?? "";
}
