import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

interface RuntimeTurnResponse {
  session: { id: string; turnCount: number };
  turn: { status: string };
}

interface AgentEvaluationSummaryResponse {
  clarifying: number;
  averageSessionTurnCountAtClarify: number | null;
}

describe("agent evaluation summary clarify-rate telemetry", () => {
  it("counts clarifying turns separately from needs_confirmation and averages their session turn count", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, cookie } = await createOwnerBusiness(app);

    // Turn 1: a healthy read - completed, not a clarify.
    const first = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { message: "show products" },
      cookie
    );
    expect(first.turn.status).toBe("completed");
    const runtimeSessionId = first.session.id;

    // Turn 2: "add customer" with no name given - clarifies. Turn count at this point is 2.
    const second = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { runtimeSessionId, message: "add customer" },
      cookie
    );
    expect(second.turn.status).toBe("clarifying");
    expect(second.session.turnCount).toBe(2);

    // Turn 3: another clarify later in the same session - turn count 3.
    const third = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { runtimeSessionId, message: "add supplier" },
      cookie
    );
    expect(third.turn.status).toBe("clarifying");
    expect(third.session.turnCount).toBe(3);

    const summary = await getJson<AgentEvaluationSummaryResponse>(
      app,
      `/businesses/${businessId}/agent-runtime/evaluations`,
      cookie
    );
    expect(summary.clarifying).toBe(2);
    expect(summary.averageSessionTurnCountAtClarify).toBe((2 + 3) / 2);

    await app.close();
  });

  it("reports no clarifying turns and a null average for a business with none recorded yet", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, cookie } = await createOwnerBusiness(app);

    const summary = await getJson<AgentEvaluationSummaryResponse>(
      app,
      `/businesses/${businessId}/agent-runtime/evaluations`,
      cookie
    );
    expect(summary.clarifying).toBe(0);
    expect(summary.averageSessionTurnCountAtClarify).toBeNull();

    await app.close();
  });
});

async function createOwnerBusiness(app: ReturnType<typeof buildApi>) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({ method: "phone", contact: "254700009906", pin: "3927" })
  });
  expect(signup.statusCode).toBe(200);
  const cookie = extractSessionCookie(signup.headers["set-cookie"]);
  const business = await postJson<{ business: { id: string } }>(
    app,
    "/businesses",
    { name: "Clarify Rate Shop", language: "en" },
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
