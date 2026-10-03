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
  name: string;
}

interface InvoiceResponse {
  id: string;
  invoiceNumber: string;
}

interface ConfirmInvoiceResponse {
  invoice: InvoiceResponse;
}

interface PaymentResponse {
  payment: {
    id: string;
  };
}

interface LogisticsResponse {
  id: string;
}

interface RoleCheckResponse {
  allowed: boolean;
  permission: string;
  role: string;
}

interface DataExportResponse {
  id: string;
  checksum: string;
  recordCounts: Record<string, number>;
  data: {
    customers: CustomerResponse[];
    auditEvents: Array<{
      type: string;
      risk: string;
    }>;
  };
}

interface VerificationResponse {
  tier: "unverified" | "owner_verified" | "business_verified";
  evidenceType: "none" | "owner_attestation" | "business_document";
}

interface TaxConfigResponse {
  countryCode: "KE";
  defaultTaxRate: number;
  taxIdLabel: string;
  taxId: string | null;
}

interface DeviceTrustResponse {
  deviceId: string;
  level: "unknown" | "trusted" | "restricted";
}

interface SecurityReviewResponse {
  rbac: {
    gaps: string[];
  };
  audit: {
    missingHighRiskAuditCount: number;
    coveredActionTypes: string[];
  };
  sensitiveData: {
    rawSensitiveLogFindings: number;
    promptExposure: "bounded";
  };
  tielReadiness: {
    verificationTier: "unverified" | "owner_verified" | "business_verified";
    deviceTrustLevel: "unknown" | "trusted" | "restricted";
    fullTielDeferred: true;
  };
}

interface BusinessReportResponse {
  compliance: {
    exportCount: number;
    deletionRequestCount: number;
    scheduledAnonymizationCount: number;
    retainedRecordCount: number;
    verificationTier: string;
    taxCountryCode: string;
    deviceTrustLevel: string;
    highRiskAuditEventCount: number;
  };
}

interface KnowledgeResponse {
  facts: Array<{
    topic: string;
    detail: string;
    metric: number;
  }>;
}

interface RuntimeTurnResponse {
  turn: {
    context: {
      complianceExportCount: number;
      scheduledDeletionCount: number;
      verificationTier: string;
      deviceTrustLevel: string;
      knowledgeFactCount: number;
    };
    telemetry: Array<{
      metadata: Record<string, unknown>;
    }>;
  };
}

interface DeletionResponse {
  status: "scheduled";
  deactivatedAt: string;
  anonymizeAfter: string;
  retention: {
    retainedInvoiceCount: number;
    retainedPaymentCount: number;
    retainedLogisticsCount: number;
    retainedAuditEventCount: number;
    directIdentifierFieldsRemoved: number;
  };
}

describe("CP14 security compliance", () => {
  it("exports scoped data, audits high-risk controls, bounds runtime context, and deactivates deleted accounts", async () => {
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
            reason: "List products from bounded compliance context."
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
    const { customer } = await seedComplianceData(app, businessId, sessionCookie);

    const ownerExportRole = await postJson<RoleCheckResponse>(
      app,
      "/roles/check",
      {
        businessId,
        role: "owner",
        permission: "compliance:export"
      },
      sessionCookie
    );
    const ownerDeleteRole = await postJson<RoleCheckResponse>(
      app,
      "/roles/check",
      {
        businessId,
        role: "owner",
        permission: "compliance:delete"
      },
      sessionCookie
    );
    const unauthenticatedExport = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/compliance/export`,
      headers: jsonHeaders(),
      payload: JSON.stringify({})
    });

    expect(ownerExportRole).toMatchObject({
      allowed: true,
      permission: "compliance:export",
      role: "owner"
    });
    expect(ownerDeleteRole).toMatchObject({
      allowed: true,
      permission: "compliance:delete",
      role: "owner"
    });
    expect(unauthenticatedExport.statusCode).toBe(401);

    const verification = await patchJson<VerificationResponse>(
      app,
      `/businesses/${businessId}/compliance/verification`,
      {
        tier: "owner_verified",
        evidenceType: "owner_attestation",
        note: "Owner attested in person"
      },
      sessionCookie
    );
    const taxConfig = await patchJson<TaxConfigResponse>(
      app,
      `/businesses/${businessId}/compliance/tax-config`,
      {
        countryCode: "KE",
        defaultTaxRate: 0.16,
        taxId: "P051234567A",
        pricesIncludeTax: false
      },
      sessionCookie
    );
    const deviceTrust = await patchJson<DeviceTrustResponse>(
      app,
      `/businesses/${businessId}/compliance/device-trust`,
      {
        deviceId: "owner-browser",
        level: "trusted",
        reason: "Primary owner device"
      },
      sessionCookie
    );
    const dataExport = await postJson<DataExportResponse>(
      app,
      `/businesses/${businessId}/compliance/export`,
      {},
      sessionCookie
    );
    const review = await getJson<SecurityReviewResponse>(
      app,
      `/businesses/${businessId}/compliance/security-review`,
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

    expect(verification).toMatchObject({
      tier: "owner_verified",
      evidenceType: "owner_attestation"
    });
    expect(taxConfig).toMatchObject({
      countryCode: "KE",
      defaultTaxRate: 0.16,
      taxIdLabel: "KRA PIN",
      taxId: "P051234567A"
    });
    expect(deviceTrust).toMatchObject({
      deviceId: "owner-browser",
      level: "trusted"
    });
    expect(dataExport.checksum).toHaveLength(64);
    expect(dataExport.recordCounts.customers).toBe(1);
    expect(dataExport.data.customers[0]?.name).toBe(customer.name);
    expect(JSON.stringify(dataExport.data.auditEvents)).not.toContain(customer.name);
    expect(review.rbac.gaps).toEqual([]);
    expect(review.audit.missingHighRiskAuditCount).toBe(0);
    expect(review.audit.coveredActionTypes).toEqual(
      expect.arrayContaining([
        "compliance.data_export_created",
        "compliance.device_trust_updated",
        "compliance.tax_config_updated",
        "compliance.verification_tier_updated"
      ])
    );
    expect(review.sensitiveData).toMatchObject({
      rawSensitiveLogFindings: 0,
      promptExposure: "bounded"
    });
    expect(review.tielReadiness).toMatchObject({
      verificationTier: "owner_verified",
      fullTielDeferred: true
    });
    expect(report.compliance).toMatchObject({
      exportCount: 1,
      verificationTier: "owner_verified",
      taxCountryCode: "KE"
    });
    expect(report.compliance.highRiskAuditEventCount).toBeGreaterThanOrEqual(4);
    expect(knowledge.facts.some((fact) => fact.topic === "compliance")).toBe(true);
    expect(JSON.stringify(knowledge)).not.toContain(customer.name);
    expect(turn.turn.context).toMatchObject({
      complianceExportCount: 1,
      scheduledDeletionCount: 0,
      verificationTier: "owner_verified",
      deviceTrustLevel: "unknown",
      knowledgeFactCount: 9
    });
    expect(capturedPrompt?.context).toMatchObject({
      complianceExportCount: 1,
      scheduledDeletionCount: 0,
      verificationTier: "owner_verified"
    });
    expect(JSON.stringify(capturedPrompt)).not.toContain(customer.name);
    expect(JSON.stringify(turn.turn.telemetry)).not.toContain(customer.name);

    const invalidDeletion = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/compliance/account-deletion`,
      headers: { ...jsonHeaders(), cookie: sessionCookie },
      payload: JSON.stringify({
        confirmation: "delete",
        reason: "Wrong confirmation"
      })
    });
    const deletionResponse = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/compliance/account-deletion`,
      headers: { ...jsonHeaders(), cookie: sessionCookie },
      payload: JSON.stringify({
        confirmation: "DELETE",
        reason: "Owner requested deletion"
      })
    });
    const deletion = deletionResponse.json<DeletionResponse>();
    const sessionAfterDeletion = await app.inject({
      method: "GET",
      url: "/session",
      headers: {
        cookie: sessionCookie
      }
    });
    const exportAfterDeletion = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/compliance/export`,
      headers: { ...jsonHeaders(), cookie: sessionCookie },
      payload: JSON.stringify({})
    });
    const snapshot = store.snapshot();

    expect(invalidDeletion.statusCode).toBe(400);
    expect(deletionResponse.statusCode).toBe(200);
    expect(JSON.stringify(deletionResponse.headers["set-cookie"])).toContain("grogoni_session=");
    expect(JSON.stringify(deletionResponse.headers["set-cookie"])).toContain("grogoni_refresh=");
    expect(deletion.status).toBe("scheduled");
    expect(deletion.deactivatedAt).toBeTruthy();
    expect(Date.parse(deletion.anonymizeAfter)).toBeGreaterThan(Date.parse(deletion.deactivatedAt));
    expect(deletion.retention).toMatchObject({
      retainedInvoiceCount: 1,
      retainedPaymentCount: 1,
      retainedLogisticsCount: 1
    });
    expect(deletion.retention.directIdentifierFieldsRemoved).toBeGreaterThan(0);
    expect(sessionAfterDeletion.statusCode).toBe(401);
    expect(exportAfterDeletion.statusCode).toBe(401);
    expect(
      snapshot.auditEvents.some(
        (event) =>
          event.type === "compliance.account_deletion_scheduled" && event.risk === "critical"
      )
    ).toBe(true);
    expect(JSON.stringify(snapshot.auditEvents)).not.toContain("Owner requested deletion");

    await app.close();
  });
});

async function seedComplianceData(
  app: ReturnType<typeof buildApi>,
  businessId: string,
  sessionCookie: string
) {
  const customer = await postJson<CustomerResponse>(
    app,
    `/businesses/${businessId}/customers`,
    {
      name: "Amina",
      phone: "+254700000099",
      email: "amina@example.com"
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
  await postJson<PaymentResponse>(
    app,
    `/businesses/${businessId}/payments`,
    {
      invoiceId: confirmed.invoice.id,
      amount: 40,
      method: "cash"
    },
    sessionCookie
  );
  await postJson<LogisticsResponse>(
    app,
    `/businesses/${businessId}/logistics`,
    {
      invoiceId: confirmed.invoice.id,
      method: "delivery",
      destination: "Private customer address"
    },
    sessionCookie
  );

  return {
    customer
  };
}

async function createOwnerBusiness(app: ReturnType<typeof buildApi>) {
  const verifyResponse = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({
      method: "phone",
      contact: "254700000014",
      pin: "1234"
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
