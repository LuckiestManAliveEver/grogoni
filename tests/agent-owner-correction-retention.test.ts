import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

interface CorrectionResponse {
  id: string;
  status: "active" | "disabled";
  disabledAt: string | null;
}

describe("agent owner correction retention sweep", () => {
  it("disables a correction older than its business's configured retention window", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, cookie } = await createOwnerBusiness(app);

    const submitted = await postJson<CorrectionResponse>(
      app,
      `/businesses/${businessId}/agent-runtime/corrections`,
      {
        correction: "Always confirm delivery date with the customer.",
        category: "instruction",
        promoteToInstruction: false
      },
      cookie
    );
    expect(submitted.status).toBe("active");

    // Default memoryPolicy.retentionDays is 90 (apps/web/src/owner-app-bootstrap.ts) - 91 days
    // later the correction should have aged out.
    const wellPastRetention = new Date(Date.now() + 91 * 24 * 60 * 60 * 1000);
    const disabledCount = store.purgeExpiredAgentOwnerCorrections(wellPastRetention);
    expect(disabledCount).toBe(1);

    const corrections = await getJson<CorrectionResponse[]>(
      app,
      `/businesses/${businessId}/agent-runtime/corrections`,
      cookie
    );
    const swept = corrections.find((correction) => correction.id === submitted.id);
    expect(swept?.status).toBe("disabled");
    expect(swept?.disabledAt).not.toBeNull();

    await app.close();
  });

  it("leaves a correction untouched while it's still inside the retention window", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, cookie } = await createOwnerBusiness(app);

    const submitted = await postJson<CorrectionResponse>(
      app,
      `/businesses/${businessId}/agent-runtime/corrections`,
      {
        correction: "Prices are always quoted in KES.",
        category: "business_fact",
        promoteToInstruction: false
      },
      cookie
    );

    const wellInsideRetention = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000);
    const disabledCount = store.purgeExpiredAgentOwnerCorrections(wellInsideRetention);
    expect(disabledCount).toBe(0);

    const corrections = await getJson<CorrectionResponse[]>(
      app,
      `/businesses/${businessId}/agent-runtime/corrections`,
      cookie
    );
    expect(corrections.find((correction) => correction.id === submitted.id)?.status).toBe("active");

    await app.close();
  });

  it("never re-disables an already-disabled correction on a later sweep", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, cookie } = await createOwnerBusiness(app);

    await postJson<CorrectionResponse>(
      app,
      `/businesses/${businessId}/agent-runtime/corrections`,
      {
        correction: "Never sell below cost price.",
        category: "instruction",
        promoteToInstruction: false
      },
      cookie
    );

    const wellPastRetention = new Date(Date.now() + 91 * 24 * 60 * 60 * 1000);
    expect(store.purgeExpiredAgentOwnerCorrections(wellPastRetention)).toBe(1);
    // A second sweep at the same (or later) time must find nothing left to disable.
    expect(store.purgeExpiredAgentOwnerCorrections(wellPastRetention)).toBe(0);

    await app.close();
  });
});

async function createOwnerBusiness(app: ReturnType<typeof buildApi>) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({ method: "phone", contact: "254700009903", pin: "3927" })
  });
  expect(signup.statusCode).toBe(200);
  const cookie = extractSessionCookie(signup.headers["set-cookie"]);
  const business = await postJson<{ business: { id: string } }>(
    app,
    "/businesses",
    { name: "Retention Sweep Shop", language: "en" },
    cookie
  );
  return { businessId: business.business.id, cookie };
}

async function postJson<T = unknown>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: Record<string, unknown>,
  cookie: string
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { ...jsonHeaders(), cookie },
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

async function getJson<T = unknown>(
  app: ReturnType<typeof buildApi>,
  url: string,
  cookie: string
): Promise<T> {
  const response = await app.inject({ method: "GET", url, headers: { cookie } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

function jsonHeaders() {
  return { "content-type": "application/json" };
}

function extractSessionCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  expect(value).toBeDefined();
  return value?.split(";")[0] ?? "";
}
