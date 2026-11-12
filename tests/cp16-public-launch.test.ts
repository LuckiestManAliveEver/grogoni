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
  featureFlags: Array<{
    key: string;
    enabled: boolean;
  }>;
  support: {
    openTicketCount: number;
  };
}

interface LaunchReadinessResponse {
  status: "blocked" | "needs_review" | "ready";
  betaStatus: "blocked" | "needs_review" | "ready";
  settings: {
    status: "closed" | "open" | "paused";
    publicOnboardingEnabled: boolean;
    rollbackArmed: boolean;
    freezeActive: boolean;
    allowedSignupCount: number;
  };
  checklist: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    items: Array<{
      key: string;
      status: string;
    }>;
  };
  onboarding: {
    firstRunComplete: boolean;
    allowedSignupCount: number;
  };
  support: {
    openIncidentCount: number;
    criticalOpenIncidentCount: number;
    resolvedIncidentCount: number;
    betaOpenTicketCount: number;
  };
  telemetry: {
    sessionEventCount: number;
    crashFreeSessionRate: number;
    launchSafePayloadCount: number;
  };
  sync: {
    activeQueueCount: number;
    conflictCount: number;
    failedCount: number;
  };
  payments: {
    paymentCount: number;
    reconciliationMismatchCount: number;
  };
  rollback: {
    rollbackArmed: boolean;
    freezeActive: boolean;
    canPauseOnboarding: boolean;
  };
  gates: Array<{
    key: string;
    passed: boolean;
    detail: string;
  }>;
}

interface LaunchIncidentResponse {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "open" | "mitigating" | "resolved";
  bodySummary: string;
}

interface BusinessReportResponse {
  beta: BetaReadinessResponse;
  launch: LaunchReadinessResponse;
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
      betaReadinessStatus: string;
      publicLaunchStatus: string;
      launchReadinessStatus: string;
      openLaunchIncidentCount: number;
      knowledgeFactCount: number;
    };
  };
}

describe("CP16 public launch", () => {
  it("opens reversible public onboarding only after launch gates pass with bounded support and runtime context", async () => {
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
            reason: "List products from bounded launch context."
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

    const initialLaunch = await getJson<LaunchReadinessResponse>(
      app,
      `/businesses/${businessId}/launch/readiness`,
      sessionCookie
    );

    expect(initialLaunch.status).toBe("blocked");
    expect(initialLaunch.settings).toMatchObject({
      status: "closed",
      publicOnboardingEnabled: false,
      rollbackArmed: true,
      freezeActive: true
    });
    expect(initialLaunch.checklist.pending).toBe(initialLaunch.checklist.total);

    const betaReadiness = await prepareBetaReadyBusiness(app, businessId, sessionCookie);
    expect(betaReadiness.status).toBe("ready");

    const launchIncident = await postJson<LaunchIncidentResponse>(
      app,
      `/businesses/${businessId}/launch/incidents`,
      {
        severity: "high",
        category: "onboarding",
        title: "Public onboarding rehearsal",
        body: "Sensitive launch incident detail for public merchant Amina should stay out of audits and prompts."
      },
      sessionCookie
    );
    expect(launchIncident.bodySummary).toContain("Sensitive launch incident detail");

    await patchJson(
      app,
      `/businesses/${businessId}/launch/incidents/${launchIncident.id}`,
      {
        status: "resolved"
      },
      sessionCookie
    );

    for (const item of initialLaunch.checklist.items) {
      await patchJson(
        app,
        `/businesses/${businessId}/launch/checklist/${item.key}`,
        {
          status: "passed",
          evidence: `${item.key} verified for CP16 launch.`
        },
        sessionCookie
      );
    }

    await patchJson(
      app,
      `/businesses/${businessId}/launch/settings`,
      {
        status: "open",
        publicOnboardingEnabled: true,
        rollbackArmed: true,
        freezeActive: false,
        allowedSignupCount: 250
      },
      sessionCookie
    );

    const readiness = await getJson<LaunchReadinessResponse>(
      app,
      `/businesses/${businessId}/launch/readiness`,
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
    expect(readiness.betaStatus).toBe("ready");
    expect(readiness.settings).toMatchObject({
      status: "open",
      publicOnboardingEnabled: true,
      rollbackArmed: true,
      freezeActive: false,
      allowedSignupCount: 250
    });
    expect(readiness.checklist).toMatchObject({
      passed: 7,
      failed: 0,
      pending: 0
    });
    expect(readiness.onboarding).toMatchObject({
      firstRunComplete: true,
      allowedSignupCount: 250
    });
    expect(readiness.support).toMatchObject({
      openIncidentCount: 0,
      criticalOpenIncidentCount: 0,
      resolvedIncidentCount: 1,
      betaOpenTicketCount: 0
    });
    expect(readiness.telemetry).toMatchObject({
      sessionEventCount: 1,
      crashFreeSessionRate: 1,
      launchSafePayloadCount: 2
    });
    expect(readiness.sync).toMatchObject({
      activeQueueCount: 0,
      conflictCount: 0,
      failedCount: 0
    });
    expect(readiness.payments).toMatchObject({
      paymentCount: 1,
      reconciliationMismatchCount: 0
    });
    expect(readiness.rollback).toMatchObject({
      rollbackArmed: true,
      freezeActive: false,
      canPauseOnboarding: true
    });
    expect(readiness.gates.every((gate) => gate.passed)).toBe(true);
    expect(report.launch.status).toBe("ready");
    expect(knowledge.facts.some((fact) => fact.topic === "launch")).toBe(true);
    expect(turn.turn.context).toMatchObject({
      betaReadinessStatus: "ready",
      publicLaunchStatus: "open",
      launchReadinessStatus: "ready",
      openLaunchIncidentCount: 0,
      knowledgeFactCount: 9
    });
    expect(capturedPrompt?.context).toMatchObject({
      publicLaunchStatus: "open",
      launchReadinessStatus: "ready",
      openLaunchIncidentCount: 0
    });
    expect(JSON.stringify(snapshot.auditEvents)).not.toContain("Sensitive launch incident detail");
    expect(JSON.stringify(capturedPrompt)).not.toContain("Sensitive launch incident detail");

    await app.close();
  });
});

async function prepareBetaReadyBusiness(
  app: ReturnType<typeof buildApi>,
  businessId: string,
  sessionCookie: string
): Promise<BetaReadinessResponse> {
  const initialReadiness = await getJson<BetaReadinessResponse>(
    app,
    `/businesses/${businessId}/beta/readiness`,
    sessionCookie
  );

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
        reason: `Enable ${flag.key} for CP16 launch.`
      },
      sessionCookie
    );
  }

  await seedLaunchDailyUseData(app, businessId, sessionCookie);
  await recordDeviceTests(app, businessId, sessionCookie);
  await replayThreeSyncMutations(app, businessId, sessionCookie);

  const supportTicket = await postJson<{ id: string }>(
    app,
    `/businesses/${businessId}/beta/support-tickets`,
    {
      severity: "high",
      title: "Launch support rehearsal",
      body: "Bounded beta support ticket for CP16 launch.",
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
      message: "Launch session completed",
      metadata: {
        surface: "launch",
        publicOnboarding: true
      }
    },
    sessionCookie
  );
  await postJson(
    app,
    `/businesses/${businessId}/beta/telemetry`,
    {
      kind: "error",
      message: "Launch retry warning",
      metadata: {
        surface: "sync",
        retryable: true
      }
    },
    sessionCookie
  );

  return getJson<BetaReadinessResponse>(
    app,
    `/businesses/${businessId}/beta/readiness`,
    sessionCookie
  );
}

async function seedLaunchDailyUseData(
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
        idempotencyKey: `cp16-sync-${index}`,
        mutationType: "customer.create",
        payload: {
          name: `Launch Sync ${index}`
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
      contact: "254700000016",
      pin: "3927"
    })
  });
  const sessionCookie = extractSessionCookie(verifyResponse.headers["set-cookie"]);
  const auth = verifyResponse.json<VerifyOtpResponse>();
  const business = await postJson<CreateBusinessResponse>(
    app,
    "/businesses",
    {
      name: "Jane's Launch Shop",
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
