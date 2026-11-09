import { describe, expect, it } from "vitest";
import type { RuntimeModelProvider } from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

interface RuntimeTurnResponse {
  session: { id: string };
  turn: {
    status: string;
    response: string;
    toolResult: unknown;
    plan: { toolName: string; confirmationToken: string | null };
  };
}

describe("runtime execution failure graceful degradation", () => {
  it("turns a genuine (non-hallucination) execution failure into a blocked turn instead of a raw HTTP crash", async () => {
    const provider: RuntimeModelProvider = {
      name: "execution-failure-test",
      async complete() {
        return {
          provider: "execution-failure-test",
          status: "available",
          outputText: JSON.stringify({
            type: "tool",
            toolName: "payment.record",
            input: {
              invoiceId: "11111111-1111-4111-8111-111111111111",
              amount: 500,
              method: "cash"
            },
            reason: "Recording a payment."
          }),
          durationMs: 1,
          errorCode: null,
          metadata: {}
        };
      }
    };
    const store = createCp2Store({ runtimeModelProvider: provider });
    const app = buildApi({ cp2: { store } });
    const { businessId, cookie } = await createOwnerBusiness(app);

    const proposed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { message: "I got a fresh batch of goods today, not sure how to log it in the system" },
      cookie
    );
    expect(proposed.turn.status).toBe("needs_confirmation");
    expect(proposed.turn.plan.toolName).toBe("payment.record");
    const confirmationToken = proposed.turn.plan.confirmationToken;
    expect(confirmationToken).not.toBeNull();

    // Confirming executes deps.recordPayment against an invoice id that was never created - a
    // genuine execution-time Cp2Error (404 invoice_not_found), not something the pre-confirmation
    // validation or the hallucinated-entity check (which only covers product/customer/supplier
    // names, not invoice ids) catches. Before this feature, this request would crash with a raw
    // HTTP error instead of a graceful turn.
    const confirmed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        runtimeSessionId: proposed.session.id,
        message: "confirm",
        confirmationToken
      },
      cookie
    );
    expect(confirmed.turn.status).toBe("blocked");
    expect(confirmed.turn.response).toBe("Invoice was not found.");
    expect(confirmed.turn.toolResult).toBeNull();

    // invoice_not_found is not marked retryable, so the confirmation token is consumed - a second
    // confirm with the same (now-stale) token must not silently re-attempt anything.
    const secondAttempt = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/runtime/turns`,
      headers: { ...jsonHeaders(), cookie },
      payload: JSON.stringify({
        runtimeSessionId: proposed.session.id,
        message: "confirm",
        confirmationToken
      })
    });
    expect(secondAttempt.statusCode).toBe(404);

    await app.close();
  });
});

async function createOwnerBusiness(app: ReturnType<typeof buildApi>) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({ method: "phone", contact: "254700009905", pin: "3927" })
  });
  expect(signup.statusCode).toBe(200);
  const cookie = extractSessionCookie(signup.headers["set-cookie"]);
  const business = await postJson<{ business: { id: string } }>(
    app,
    "/businesses",
    { name: "Execution Failure Shop", language: "en" },
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

function jsonHeaders() {
  return { "content-type": "application/json" };
}

function extractSessionCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  expect(value).toBeDefined();
  return value?.split(";")[0] ?? "";
}
