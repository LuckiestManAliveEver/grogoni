import { describe, expect, it } from "vitest";
import type {
  RuntimeModelCompletionResult,
  RuntimeModelPrompt,
  RuntimeModelProvider
} from "../packages/shared-types/src";
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
  invoiceNumber: string;
  status: "draft" | "confirmed";
  total: number;
}

interface ConfirmInvoiceResponse {
  invoice: InvoiceResponse;
}

interface LogisticsResponse {
  id: string;
  businessId: string;
  invoiceId: string;
  invoiceNumber: string;
  customerName: string | null;
  method: "delivery" | "pickup";
  status: "pending" | "ready" | "out_for_delivery" | "completed" | "cancelled";
  destination: string | null;
  completedAt: string | null;
}

interface RoleCheckResponse {
  allowed: boolean;
  permission: string;
  role: string;
}

interface BusinessReportResponse {
  logistics: {
    fulfillmentCount: number;
    pendingCount: number;
    readyCount: number;
    outForDeliveryCount: number;
    completedCount: number;
    activeCount: number;
  };
}

interface KnowledgeResponse {
  facts: Array<{
    topic: string;
    detail: string;
    metric: number;
  }>;
}

interface SyncQueueItemResponse {
  id: string;
  status: "pending" | "processing" | "synced" | "failed" | "conflict";
}

interface SyncReplayResponse {
  item: SyncQueueItemResponse;
  replayed: boolean;
}

interface RuntimeTurnResponse {
  turn: {
    context: {
      logisticsCount: number;
      activeLogisticsCount: number;
      knowledgeFactCount: number;
    };
    plan: {
      toolName: string;
    };
    telemetry: Array<{
      metadata: Record<string, unknown>;
    }>;
  };
}

describe("CP13 logistics", () => {
  it("tracks deterministic scoped fulfillment without mutating commerce records", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const { customer, invoice, product } = await seedConfirmedInvoice(
      app,
      businessId,
      sessionCookie
    );
    const draft = await createDraftInvoice(app, businessId, sessionCookie, customer.id, product.id);
    const readRole = await postJson<RoleCheckResponse>(
      app,
      "/roles/check",
      {
        businessId,
        role: "owner",
        permission: "logistics:read"
      },
      sessionCookie
    );
    const writeRole = await postJson<RoleCheckResponse>(
      app,
      "/roles/check",
      {
        businessId,
        role: "owner",
        permission: "logistics:write"
      },
      sessionCookie
    );

    const unauthenticated = await app.inject({
      method: "GET",
      url: `/businesses/${businessId}/logistics`
    });
    const draftLogistics = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/logistics`,
      headers: { ...jsonHeaders(), cookie: sessionCookie },
      payload: JSON.stringify({
        invoiceId: draft.id,
        method: "delivery"
      })
    });
    const beforeSnapshot = store.snapshot();
    const logistics = await postJson<LogisticsResponse>(
      app,
      `/businesses/${businessId}/logistics`,
      {
        invoiceId: invoice.id,
        method: "delivery",
        destination: "Counter pickup desk",
        note: "Call before dispatch"
      },
      sessionCookie
    );

    expect(readRole).toMatchObject({
      allowed: true,
      permission: "logistics:read",
      role: "owner"
    });
    expect(writeRole).toMatchObject({
      allowed: true,
      permission: "logistics:write",
      role: "owner"
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(draftLogistics.statusCode).toBe(409);
    expect(logistics).toMatchObject({
      businessId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      customerName: customer.name,
      method: "delivery",
      status: "pending"
    });

    const duplicate = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/logistics`,
      headers: { ...jsonHeaders(), cookie: sessionCookie },
      payload: JSON.stringify({
        invoiceId: invoice.id,
        method: "pickup"
      })
    });
    expect(duplicate.statusCode).toBe(409);

    const ready = await patchJson<LogisticsResponse>(
      app,
      `/businesses/${businessId}/logistics/${logistics.id}`,
      {
        status: "ready"
      },
      sessionCookie
    );
    const dispatched = await patchJson<LogisticsResponse>(
      app,
      `/businesses/${businessId}/logistics/${logistics.id}`,
      {
        status: "out_for_delivery"
      },
      sessionCookie
    );
    const completed = await patchJson<LogisticsResponse>(
      app,
      `/businesses/${businessId}/logistics/${logistics.id}`,
      {
        status: "completed"
      },
      sessionCookie
    );
    const invalidReopen = await app.inject({
      method: "PATCH",
      url: `/businesses/${businessId}/logistics/${logistics.id}`,
      headers: { ...jsonHeaders(), cookie: sessionCookie },
      payload: JSON.stringify({
        status: "pending"
      })
    });

    expect(ready.status).toBe("ready");
    expect(dispatched.status).toBe("out_for_delivery");
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeTruthy();
    expect(invalidReopen.statusCode).toBe(400);

    const afterSnapshot = store.snapshot();
    expect(afterSnapshot.products.find((item) => item.id === product.id)?.quantity).toBe(
      beforeSnapshot.products.find((item) => item.id === product.id)?.quantity
    );
    expect(afterSnapshot.invoices.find((item) => item.id === invoice.id)?.total).toBe(
      invoice.total
    );
    expect(afterSnapshot.payments).toHaveLength(beforeSnapshot.payments.length);
    expect(
      afterSnapshot.auditEvents.filter((event) => event.type === "logistics.created")
    ).toHaveLength(1);
    expect(
      afterSnapshot.auditEvents.filter((event) => event.type === "logistics.status_updated")
    ).toHaveLength(3);

    const { businessId: secondBusinessId, sessionCookie: secondSessionCookie } =
      await createOwnerBusiness(app, {
        contact: "254700000113",
        businessName: "Second Shop"
      });
    const secondLogistics = await getJson<LogisticsResponse[]>(
      app,
      `/businesses/${secondBusinessId}/logistics`,
      secondSessionCookie
    );
    const crossBusinessUpdate = await app.inject({
      method: "PATCH",
      url: `/businesses/${secondBusinessId}/logistics/${logistics.id}`,
      headers: { ...jsonHeaders(), cookie: secondSessionCookie },
      payload: JSON.stringify({
        status: "ready"
      })
    });
    expect(secondLogistics).toEqual([]);
    expect(crossBusinessUpdate.statusCode).toBe(404);

    await app.close();
  });

  it("replays logistics mutations through the sync queue idempotently", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const { invoice } = await seedConfirmedInvoice(app, businessId, sessionCookie);
    const item = await postJson<SyncQueueItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue`,
      {
        idempotencyKey: "cp13-logistics-create-1",
        mutationType: "logistics.create",
        payload: {
          invoiceId: invoice.id,
          method: "pickup",
          note: "Customer will collect"
        }
      },
      sessionCookie
    );

    const firstReplay = await postJson<SyncReplayResponse>(
      app,
      `/businesses/${businessId}/sync-queue/${item.id}/replay`,
      {},
      sessionCookie
    );
    const secondReplay = await postJson<SyncReplayResponse>(
      app,
      `/businesses/${businessId}/sync-queue/${item.id}/replay`,
      {},
      sessionCookie
    );
    const logistics = await getJson<LogisticsResponse[]>(
      app,
      `/businesses/${businessId}/logistics`,
      sessionCookie
    );

    expect(firstReplay).toMatchObject({
      replayed: true,
      item: {
        status: "synced"
      }
    });
    expect(secondReplay).toMatchObject({
      replayed: false,
      item: {
        status: "synced"
      }
    });
    expect(logistics).toHaveLength(1);
    expect(logistics[0]).toMatchObject({
      invoiceId: invoice.id,
      method: "pickup",
      status: "pending"
    });

    await app.close();
  });

  it("exposes bounded logistics summaries to reports, knowledge, runtime, and local model prompts", async () => {
    let capturedPrompt: RuntimeModelPrompt | null = null;
    const provider: RuntimeModelProvider = {
      name: "test",
      async complete(prompt) {
        capturedPrompt = prompt;
        return {
          provider: "test",
          status: "available",
          outputText: JSON.stringify({
            type: "tool",
            toolName: "products.list",
            input: {},
            reason: "List products from bounded logistics context."
          }),
          durationMs: 1,
          errorCode: null,
          metadata: {}
        } satisfies RuntimeModelCompletionResult;
      }
    };
    const store = createCp2Store({ runtimeModelProvider: provider });
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const { customer, invoice } = await seedConfirmedInvoice(app, businessId, sessionCookie);
    await postJson<LogisticsResponse>(
      app,
      `/businesses/${businessId}/logistics`,
      {
        invoiceId: invoice.id,
        method: "delivery",
        destination: "Private customer address"
      },
      sessionCookie
    );

    const report = await getJson<BusinessReportResponse>(
      app,
      `/businesses/${businessId}/reports/summary`,
      sessionCookie
    );
    const knowledge = await getJson<KnowledgeResponse>(
      app,
      `/businesses/${businessId}/knowledge`,
      sessionCookie
    );
    const turn = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        message: "open products"
      },
      sessionCookie
    );

    expect(report.logistics).toMatchObject({
      fulfillmentCount: 1,
      pendingCount: 1,
      activeCount: 1
    });
    expect(knowledge.facts.some((fact) => fact.topic === "logistics" && fact.metric === 1)).toBe(
      true
    );
    expect(JSON.stringify(knowledge)).not.toContain(customer.name);
    expect(JSON.stringify(knowledge)).not.toContain("Private customer address");
    expect(turn.turn.context).toMatchObject({
      logisticsCount: 1,
      activeLogisticsCount: 1,
      knowledgeFactCount: 9
    });
    expect(capturedPrompt?.context).toMatchObject({
      logisticsCount: 1,
      activeLogisticsCount: 1
    });
    expect(JSON.stringify(capturedPrompt)).not.toContain(customer.name);
    expect(JSON.stringify(turn.turn.telemetry)).not.toContain("Private customer address");

    await app.close();
  });
});

async function seedConfirmedInvoice(
  app: ReturnType<typeof buildApi>,
  businessId: string,
  sessionCookie: string
) {
  const customer = await postJson<CustomerResponse>(
    app,
    `/businesses/${businessId}/customers`,
    {
      name: "Amina"
    },
    sessionCookie
  );
  const product = await postJson<ProductResponse>(
    app,
    `/businesses/${businessId}/products`,
    {
      name: "Rice",
      quantity: 5
    },
    sessionCookie
  );
  const draft = await createDraftInvoice(app, businessId, sessionCookie, customer.id, product.id);
  const confirmed = await postJson<ConfirmInvoiceResponse>(
    app,
    `/businesses/${businessId}/invoices/${draft.id}/confirm`,
    {},
    sessionCookie
  );

  return {
    customer,
    product,
    invoice: confirmed.invoice
  };
}

async function createDraftInvoice(
  app: ReturnType<typeof buildApi>,
  businessId: string,
  sessionCookie: string,
  customerId: string,
  productId: string
): Promise<InvoiceResponse> {
  return postJson<InvoiceResponse>(
    app,
    `/businesses/${businessId}/invoices`,
    {
      customerId,
      items: [
        {
          productId,
          quantity: 1,
          unitPrice: 100
        }
      ]
    },
    sessionCookie
  );
}

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
      contact: options.contact ?? "254700000013",
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

async function getJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  cookie?: string
): Promise<TResponse> {
  const response = await app.inject({
    method: "GET",
    url,
    headers: cookie === undefined ? undefined : { cookie }
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
