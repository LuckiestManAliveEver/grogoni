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
}

interface CustomerResponse {
  id: string;
}

interface InvoiceResponse {
  id: string;
}

interface ConfirmInvoiceResponse {
  invoice: InvoiceResponse;
}

interface BetaReadinessResponse {
  status: "blocked" | "needs_review" | "ready";
  access: {
    status: "not_invited" | "active" | "paused";
    invitedMerchantCount: number;
    targetMerchantCount: number;
  };
  featureFlags: Array<{
    key: string;
    enabled: boolean;
    reason: string;
  }>;
  deviceTesting: {
    passedDeviceClasses: string[];
    failedTestCount: number;
  };
  offline: {
    cachedRecordCount: number;
    testedSurfaceCount: number;
  };
  syncStress: {
    syncedMutationCount: number;
    conflictCount: number;
    failedCount: number;
    ready: boolean;
  };
  payments: {
    paymentCount: number;
    reconciliationMismatchCount: number;
    controlledProductionReady: boolean;
  };
  support: {
    openTicketCount: number;
    criticalOpenTicketCount: number;
    documentedSeverityCount: number;
  };
  telemetry: {
    sessionEventCount: number;
    crashEventCount: number;
    errorEventCount: number;
    crashFreeSessionRate: number;
    rawSensitivePayloadCount: number;
  };
  gates: Array<{
    key: string;
    passed: boolean;
    detail: string;
  }>;
}

interface BetaSupportTicketResponse {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "open" | "triaged" | "resolved";
  bodySummary: string;
}

interface BusinessReportResponse {
  beta: BetaReadinessResponse;
}

interface BusinessKnowledgeResponse {
  facts: Array<{
    topic: string;
    detail: string;
    metric: number;
  }>;
}

interface RuntimeTurnResponse {
  turn: {
    context: {
      betaAccessStatus: string;
      betaReadinessStatus: string;
      openSupportTicketCount: number;
      crashFreeSessionRate: number;
      knowledgeFactCount: number;
    };
    telemetry: Array<{
      metadata: Record<string, unknown>;
    }>;
  };
}

describe("CP15 beta release hardening", () => {
  it("gates closed beta readiness, bounds telemetry and support data, and preserves runtime context safety", async () => {
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
            reason: "List products from bounded beta context."
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
    const initialReadiness = await getJson<BetaReadinessResponse>(
      app,
      `/businesses/${businessId}/beta/readiness`,
      sessionCookie
    );

    expect(initialReadiness.status).toBe("blocked");
    expect(initialReadiness.access.status).toBe("not_invited");
    expect(initialReadiness.featureFlags.every((flag) => !flag.enabled)).toBe(true);

    await patchJson(
      app,
      `/businesses/${businessId}/beta/access`,
      {
        status: "active",
        invitedMerchantCount: 10
      },
      sessionCookie
    );

    for (const flag of initialReadiness.featureFlags) {
      await patchJson(
        app,
        `/businesses/${businessId}/beta/feature-flags/${flag.key}`,
        {
          enabled: true,
          reason: `Enable ${flag.key} for CP15.`
        },
        sessionCookie
      );
    }

    await seedBetaDailyUseData(app, businessId, sessionCookie);
    await recordDeviceTests(app, businessId, sessionCookie);
    await replayThreeSyncMutations(app, businessId, sessionCookie);

    const supportTicket = await postJson<BetaSupportTicketResponse>(
      app,
      `/businesses/${businessId}/beta/support-tickets`,
      {
        severity: "high",
        title: "Payment handoff rehearsal",
        body: "Sensitive support detail for private beta customer Amina should not enter audit or prompts.",
        source: "operator"
      },
      sessionCookie
    );
    await patchJson(
      app,
      `/businesses/${businessId}/beta/support-tickets/${supportTicket.id}`,
      {
        status: "resolved"
      },
      sessionCookie
    );
    await postJson(
      app,
      `/businesses/${businessId}/beta/telemetry`,
      {
        kind: "session",
        message: "Sensitive crash-free session message should be hashed",
        metadata: {
          surface: "invoice",
          deviceClass: "android_1gb"
        }
      },
      sessionCookie
    );
    await postJson(
      app,
      `/businesses/${businessId}/beta/telemetry`,
      {
        kind: "error",
        message: "Bounded retry warning",
        metadata: {
          surface: "sync",
          retryable: true
        }
      },
      sessionCookie
    );

    const readiness = await getJson<BetaReadinessResponse>(
      app,
      `/businesses/${businessId}/beta/readiness`,
      sessionCookie
    );
    const report = await getJson<BusinessReportResponse>(
      app,
      `/businesses/${businessId}/reports/summary`,
      sessionCookie
    );
    const knowledge = await getJson<BusinessKnowledgeResponse>(
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
    const snapshot = store.snapshot();

    expect(readiness.status).toBe("ready");
    expect(readiness.access).toMatchObject({
      status: "active",
      invitedMerchantCount: 10,
      targetMerchantCount: 10
    });
    expect(readiness.deviceTesting).toMatchObject({
      passedDeviceClasses: ["android_1gb", "android_2gb"],
      failedTestCount: 0
    });
    expect(readiness.offline.testedSurfaceCount).toBe(5);
    expect(readiness.syncStress).toMatchObject({
      syncedMutationCount: 3,
      conflictCount: 0,
      failedCount: 0,
      ready: true
    });
    expect(readiness.payments).toMatchObject({
      paymentCount: 1,
      reconciliationMismatchCount: 0,
      controlledProductionReady: true
    });
    expect(readiness.support).toMatchObject({
      openTicketCount: 0,
      criticalOpenTicketCount: 0
    });
    expect(readiness.telemetry).toMatchObject({
      sessionEventCount: 1,
      crashEventCount: 0,
      errorEventCount: 1,
      crashFreeSessionRate: 1,
      rawSensitivePayloadCount: 0
    });
    expect(readiness.gates.every((gate) => gate.passed)).toBe(true);
    expect(report.beta.status).toBe("ready");
    expect(knowledge.facts.some((fact) => fact.topic === "beta")).toBe(true);
    expect(turn.turn.context).toMatchObject({
      betaAccessStatus: "active",
      betaReadinessStatus: "ready",
      openSupportTicketCount: 0,
      crashFreeSessionRate: 1,
      knowledgeFactCount: 9
    });
    expect(capturedPrompt?.context).toMatchObject({
      betaAccessStatus: "active",
      betaReadinessStatus: "ready",
      openSupportTicketCount: 0
    });
    expect(snapshot.betaTelemetryEvents[0]?.messageHash).toHaveLength(64);
    expect(JSON.stringify(snapshot.auditEvents)).not.toContain("Sensitive support detail");
    expect(JSON.stringify(snapshot.auditEvents)).not.toContain("Sensitive crash-free session");
    expect(JSON.stringify(capturedPrompt)).not.toContain("Sensitive support detail");
    expect(JSON.stringify(turn.turn.telemetry)).not.toContain("Sensitive crash-free session");

    await app.close();
  });
});

async function seedBetaDailyUseData(
  app: ReturnType<typeof buildApi>,
  businessId: string,
  sessionCookie: string
) {
  const customer = await postJson<CustomerResponse>(
    app,
    `/businesses/${businessId}/customers`,
    {
      name: "Amina",
      phone: "+254700000099"
    },
    sessionCookie
  );
  const product = await postJson<ProductResponse>(
    app,
    `/businesses/${businessId}/products`,
    {
      name: "Rice",
      quantity: 6
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
          productId: product.id,
          quantity: 1,
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
  await postJson(
    app,
    `/businesses/${businessId}/payments`,
    {
      invoiceId: confirmed.invoice.id,
      amount: 100,
      method: "cash"
    },
    sessionCookie
  );
  await postJson(
    app,
    `/businesses/${businessId}/logistics`,
    {
      invoiceId: confirmed.invoice.id,
      method: "pickup"
    },
    sessionCookie
  );
}

async function recordDeviceTests(
  app: ReturnType<typeof buildApi>,
  businessId: string,
  sessionCookie: string
) {
  for (const deviceClass of ["android_1gb", "android_2gb"]) {
    await postJson(
      app,
      `/businesses/${businessId}/beta/device-tests`,
      {
        deviceClass,
        workflow: "daily owner workflow",
        status: "passed",
        durationMs: 90000
      },
      sessionCookie
    );
  }
}

async function replayThreeSyncMutations(
  app: ReturnType<typeof buildApi>,
  businessId: string,
  sessionCookie: string
) {
  for (const index of [1, 2, 3]) {
    await postJson(
      app,
      `/businesses/${businessId}/sync-queue`,
      {
        idempotencyKey: `cp15-sync-${index}`,
        mutationType: "customer.create",
        payload: {
          name: `Beta Sync ${index}`
        }
      },
      sessionCookie
    );
  }

  await postJson(app, `/businesses/${businessId}/sync-queue/replay`, {}, sessionCookie);
}

async function createOwnerBusiness(app: ReturnType<typeof buildApi>) {
  const verifyResponse = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({
      method: "phone",
      contact: "254700000015",
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
  payload: unknown,
  sessionCookie?: string
): Promise<TResponse> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: {
      ...jsonHeaders(),
      ...(sessionCookie === undefined ? {} : { cookie: sessionCookie })
    },
    payload: JSON.stringify(payload)
  });

  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode).toBeLessThan(300);
  return response.json<TResponse>();
}

async function patchJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  sessionCookie?: string
): Promise<TResponse> {
  const response = await app.inject({
    method: "PATCH",
    url,
    headers: {
      ...jsonHeaders(),
      ...(sessionCookie === undefined ? {} : { cookie: sessionCookie })
    },
    payload: JSON.stringify(payload)
  });

  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode).toBeLessThan(300);
  return response.json<TResponse>();
}

async function getJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  sessionCookie: string
): Promise<TResponse> {
  const response = await app.inject({
    method: "GET",
    url,
    headers: {
      cookie: sessionCookie
    }
  });

  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode).toBeLessThan(300);
  return response.json<TResponse>();
}

function jsonHeaders() {
  return {
    "content-type": "application/json"
  };
}

function extractSessionCookie(setCookie: string | string[] | undefined): string {
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(cookie).toBeTruthy();
  return cookie?.split(";")[0] ?? "";
}
