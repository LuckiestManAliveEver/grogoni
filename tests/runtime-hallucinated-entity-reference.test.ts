import { describe, expect, it } from "vitest";
import type { RuntimeModelProvider } from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

interface RuntimeTurnResponse {
  session: { id: string };
  turn: {
    status: string;
    response: string;
    plan: { toolName: string; confirmationToken: string | null };
  };
}

describe("runtime hallucinated entity reference check", () => {
  it("clarifies instead of confirming when a proposed customer.update names a customer that doesn't exist", async () => {
    let modelOutput = "";
    const provider: RuntimeModelProvider = {
      name: "hallucination-check-test",
      async complete() {
        return {
          provider: "hallucination-check-test",
          status: "available",
          outputText: modelOutput,
          durationMs: 1,
          errorCode: null,
          metadata: {}
        };
      }
    };
    const store = createCp2Store({ runtimeModelProvider: provider });
    const app = buildApi({ cp2: { store } });
    const { businessId, cookie } = await createOwnerBusiness(app);

    modelOutput = JSON.stringify({
      type: "tool",
      toolName: "customer.update",
      input: { customerName: "Someone Who Was Never Added", phone: "0700000000" },
      reason: "Updating a customer's phone number."
    });
    const result = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { message: "I got a fresh batch of goods today, not sure how to log it in the system" },
      cookie
    );

    expect(result.turn.status).toBe("clarifying");
    expect(result.turn.plan.confirmationToken).toBeNull();
    expect(result.turn.response).toContain(
      'couldn\'t find a customer named "Someone Who Was Never Added"'
    );

    await app.close();
  });

  it("clarifies instead of confirming when a proposed product.update names a product that doesn't exist", async () => {
    let modelOutput = "";
    const provider: RuntimeModelProvider = {
      name: "hallucination-check-test-product",
      async complete() {
        return {
          provider: "hallucination-check-test-product",
          status: "available",
          outputText: modelOutput,
          durationMs: 1,
          errorCode: null,
          metadata: {}
        };
      }
    };
    const store = createCp2Store({ runtimeModelProvider: provider });
    const app = buildApi({ cp2: { store } });
    const { businessId, cookie } = await createOwnerBusiness(app);

    modelOutput = JSON.stringify({
      type: "tool",
      toolName: "product.stock_adjust",
      input: { productName: "Imaginary Widget", quantity: 5 },
      reason: "Adjusting stock."
    });
    const result = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { message: "there's a thing I need to put into the system but I don't know how" },
      cookie
    );

    expect(result.turn.status).toBe("clarifying");
    expect(result.turn.response).toContain('couldn\'t find a product named "Imaginary Widget"');

    await app.close();
  });

  it("proceeds normally to needs_confirmation when the referenced customer genuinely exists", async () => {
    let modelOutput = "";
    const provider: RuntimeModelProvider = {
      name: "hallucination-check-real-entity",
      async complete() {
        return {
          provider: "hallucination-check-real-entity",
          status: "available",
          outputText: modelOutput,
          durationMs: 1,
          errorCode: null,
          metadata: {}
        };
      }
    };
    const store = createCp2Store({ runtimeModelProvider: provider });
    const app = buildApi({ cp2: { store } });
    const { businessId, cookie } = await createOwnerBusiness(app);

    const createProposed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { message: "add customer Real Person" },
      cookie
    );
    expect(createProposed.turn.plan.toolName).toBe("customer.create");
    const created = await postJson<
      RuntimeTurnResponse & { turn: { toolResult: { name: string } } }
    >(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        runtimeSessionId: createProposed.session.id,
        message: "confirm",
        confirmationToken: createProposed.turn.plan.confirmationToken
      },
      cookie
    );
    expect(created.turn.toolResult.name).toBe("Real Person");

    modelOutput = JSON.stringify({
      type: "tool",
      toolName: "customer.update",
      input: { customerName: "Real Person", phone: "0711111111" },
      reason: "Updating a customer's phone number."
    });
    const result = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { message: "there's a thing I need to put into the system but I don't know how" },
      cookie
    );

    expect(result.turn.status).toBe("needs_confirmation");
    expect(result.turn.plan.confirmationToken).not.toBeNull();

    await app.close();
  });
});

async function createOwnerBusiness(app: ReturnType<typeof buildApi>) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({ method: "phone", contact: "254700009904", pin: "3927" })
  });
  expect(signup.statusCode).toBe(200);
  const cookie = extractSessionCookie(signup.headers["set-cookie"]);
  const business = await postJson<{ business: { id: string } }>(
    app,
    "/businesses",
    { name: "Oracle Check Shop", language: "en" },
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
