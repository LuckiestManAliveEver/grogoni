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
  name: string;
  quantity: number;
}

interface CustomerResponse {
  id: string;
  name: string;
}

interface InvoiceResponse {
  id: string;
  status: "draft" | "confirmed";
  total: number;
}

interface ConfirmInvoiceResponse {
  invoice: InvoiceResponse;
}

interface PaymentResponse {
  invoicePayment: {
    paidTotal: number;
    balanceDue: number;
    status: "unpaid" | "partially_paid" | "paid";
  };
}

interface RoleCheckResponse {
  allowed: boolean;
  permission: string;
  role: string;
}

interface BusinessReportResponse {
  businessId: string;
  sales: {
    confirmedInvoiceCount: number;
    grossSales: number;
    collectedTotal: number;
    outstandingTotal: number;
  };
  inventory: {
    productCount: number;
    lowStockCount: number;
    outOfStockCount: number;
  };
  debts: {
    customerCount: number;
    totalOutstanding: number;
  };
  sync: {
    active: number;
  };
}

interface NotificationInboxResponse {
  summary: {
    unread: number;
    read: number;
    archived: number;
    total: number;
  };
  notifications: Array<{
    id: string;
    type: string;
    severity: string;
    status: "unread" | "read" | "archived";
    title: string;
    body: string;
  }>;
}

interface KnowledgeResponse {
  businessId: string;
  report: BusinessReportResponse;
  notificationSummary: NotificationInboxResponse["summary"];
  facts: Array<{
    topic: string;
    severity: string;
    detail: string;
    metric: number;
  }>;
}

interface RuntimeTurnResponse {
  turn: {
    context: {
      lowStockCount: number;
      outstandingDebtTotal: number;
      unreadNotificationCount: number;
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

describe("CP12 reports notifications and knowledge", () => {
  it("builds deterministic scoped reports and in-app notifications", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const { customer, invoice } = await seedReportData(app, businessId, sessionCookie);
    const reportRole = await postJson<RoleCheckResponse>(
      app,
      "/roles/check",
      {
        businessId,
        role: "owner",
        permission: "report:read"
      },
      sessionCookie
    );
    const notificationRole = await postJson<RoleCheckResponse>(
      app,
      "/roles/check",
      {
        businessId,
        role: "owner",
        permission: "notification:write"
      },
      sessionCookie
    );

    const report = await getJson<BusinessReportResponse>(
      app,
      `/businesses/${businessId}/reports/summary`,
      sessionCookie
    );
    const unauthenticatedReport = await app.inject({
      method: "GET",
      url: `/businesses/${businessId}/reports/summary`
    });

    expect(reportRole).toMatchObject({
      allowed: true,
      permission: "report:read",
      role: "owner"
    });
    expect(notificationRole).toMatchObject({
      allowed: true,
      permission: "notification:write",
      role: "owner"
    });
    expect(unauthenticatedReport.statusCode).toBe(401);
    expect(report).toMatchObject({
      businessId,
      sales: {
        confirmedInvoiceCount: 1,
        grossSales: 200,
        collectedTotal: 80,
        outstandingTotal: 120
      },
      inventory: {
        productCount: 2,
        lowStockCount: 1,
        outOfStockCount: 1
      },
      debts: {
        customerCount: 1,
        totalOutstanding: 120
      }
    });

    const inbox = await getJson<NotificationInboxResponse>(
      app,
      `/businesses/${businessId}/notifications`,
      sessionCookie
    );
    expect(inbox.summary).toMatchObject({
      unread: 4,
      total: 4
    });
    expect(inbox.notifications.map((notification) => notification.type).sort()).toEqual([
      "beta_readiness",
      "launch_readiness",
      "low_stock",
      "open_debt"
    ]);

    const knowledge = await getJson<KnowledgeResponse>(
      app,
      `/businesses/${businessId}/knowledge`,
      sessionCookie
    );
    expect(knowledge).toMatchObject({
      businessId,
      notificationSummary: {
        unread: 4
      }
    });
    expect(knowledge.facts.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(knowledge)).not.toContain(customer.name);
    expect(JSON.stringify(knowledge)).not.toContain(invoice.id);

    const { businessId: secondBusinessId, sessionCookie: secondSessionCookie } =
      await createOwnerBusiness(app, {
        contact: "254700000112",
        businessName: "Second Shop"
      });
    const secondReport = await getJson<BusinessReportResponse>(
      app,
      `/businesses/${secondBusinessId}/reports/summary`,
      secondSessionCookie
    );
    expect(secondReport).toMatchObject({
      businessId: secondBusinessId,
      sales: {
        grossSales: 0
      },
      inventory: {
        productCount: 0
      },
      debts: {
        totalOutstanding: 0
      }
    });

    const createdEvents = store
      .snapshot()
      .auditEvents.filter((event) => event.type === "notification.created");
    expect(createdEvents).toHaveLength(4);
    expect(JSON.stringify(createdEvents)).not.toContain("Rice");

    await app.close();
  });

  it("updates notification state without mutating business records", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    await seedReportData(app, businessId, sessionCookie);

    const inbox = await getJson<NotificationInboxResponse>(
      app,
      `/businesses/${businessId}/notifications`,
      sessionCookie
    );
    const firstNotification = inbox.notifications[0];
    expect(firstNotification).toBeDefined();
    const productCount = store.snapshot().products.length;
    const invoiceCount = store.snapshot().invoices.length;

    const read = await patchJson<{ status: string }>(
      app,
      `/businesses/${businessId}/notifications/${firstNotification?.id}`,
      {
        status: "read"
      },
      sessionCookie
    );
    expect(read.status).toBe("read");

    const archived = await patchJson<{ status: string }>(
      app,
      `/businesses/${businessId}/notifications/${firstNotification?.id}`,
      {
        status: "archived"
      },
      sessionCookie
    );
    expect(archived.status).toBe("archived");

    const updatedInbox = await getJson<NotificationInboxResponse>(
      app,
      `/businesses/${businessId}/notifications`,
      sessionCookie
    );
    expect(updatedInbox.summary).toMatchObject({
      archived: 1,
      unread: 3
    });
    expect(store.snapshot().products).toHaveLength(productCount);
    expect(store.snapshot().invoices).toHaveLength(invoiceCount);
    expect(
      store.snapshot().auditEvents.filter((event) => event.type === "notification.status_updated")
    ).toHaveLength(2);

    await app.close();
  });

  it("exposes bounded CP12 knowledge counts to runtime and local model prompts", async () => {
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
            reason: "List products from bounded CP12 knowledge."
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
    await seedReportData(app, businessId, sessionCookie);

    const turn = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        message: "open products"
      },
      sessionCookie
    );

    expect(turn.turn).toMatchObject({
      context: {
        lowStockCount: 1,
        outstandingDebtTotal: 120,
        unreadNotificationCount: 4,
        knowledgeFactCount: 9
      },
      plan: {
        toolName: "products.list"
      }
    });
    expect(capturedPrompt?.context).toMatchObject({
      lowStockCount: 1,
      outstandingDebtTotal: 120,
      unreadNotificationCount: 4,
      knowledgeFactCount: 9
    });
    expect(JSON.stringify(capturedPrompt)).not.toContain("Rice");
    expect(JSON.stringify(turn.turn.telemetry)).not.toContain("Rice");

    await app.close();
  });
});

async function seedReportData(
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
  const rice = await postJson<ProductResponse>(
    app,
    `/businesses/${businessId}/products`,
    {
      name: "Rice",
      quantity: 2
    },
    sessionCookie
  );
  await postJson<ProductResponse>(
    app,
    `/businesses/${businessId}/products`,
    {
      name: "Salt",
      quantity: 1
    },
    sessionCookie
  );
  const draft = await postJson<InvoiceResponse>(
    app,
    `/businesses/${businessId}/invoices`,
    {
      customerId: customer.id,
      items: [
        {
          productId: rice.id,
          quantity: 2,
          unitPrice: 100
        }
      ]
    },
    sessionCookie
  );
  const confirmed = await postJson<ConfirmInvoiceResponse>(
    app,
    `/businesses/${businessId}/invoices/${draft.id}/confirm`,
    {},
    sessionCookie
  );
  await postJson<PaymentResponse>(
    app,
    `/businesses/${businessId}/payments`,
    {
      invoiceId: confirmed.invoice.id,
      amount: 80,
      method: "cash"
    },
    sessionCookie
  );

  return {
    customer,
    invoice: confirmed.invoice
  };
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
      contact: options.contact ?? "254700000012",
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
