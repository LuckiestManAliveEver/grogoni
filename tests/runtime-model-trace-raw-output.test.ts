import { describe, expect, it } from "vitest";
import type { RuntimeModelProvider } from "../packages/shared-types/src";
import { runtimeModelTraceTextLimit } from "../services/api/src/cp2/domains/agent-runtime/shared";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

interface RuntimeTurnResponse {
  turn: {
    model: { rawOutputText?: string } | null;
  };
}

describe("runtime model trace raw output", () => {
  it("keeps the model's raw completion text on the turn's model trace for audit", async () => {
    const modelOutput = JSON.stringify({
      type: "tool",
      toolName: "product.create",
      input: { name: "Sugar", unit: "kg", quantity: 5, sellingPrice: 120 },
      reason: "Drafting a product from the merchant's message."
    });
    const provider: RuntimeModelProvider = {
      name: "raw-output-trace-test",
      async complete() {
        return {
          provider: "raw-output-trace-test",
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

    const result = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { message: "I got a fresh batch of goods today, not sure how to log it in the system" },
      cookie
    );

    expect(result.turn.model?.rawOutputText).toBe(modelOutput);
    await app.close();
  });

  it("truncates an oversized raw completion instead of storing it unbounded", async () => {
    const oversizedMessage = "a".repeat(runtimeModelTraceTextLimit + 500);
    const modelOutput = JSON.stringify({ type: "response", message: oversizedMessage });
    const provider: RuntimeModelProvider = {
      name: "raw-output-truncation-test",
      async complete() {
        return {
          provider: "raw-output-truncation-test",
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

    const result = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { message: "there's a thing I need to put into the system but I don't know how" },
      cookie
    );

    const rawOutputText = result.turn.model?.rawOutputText;
    expect(rawOutputText).toBeDefined();
    expect(rawOutputText?.length).toBeLessThan(modelOutput.length);
    expect(rawOutputText?.endsWith("[truncated]")).toBe(true);
    await app.close();
  });
});

async function createOwnerBusiness(app: ReturnType<typeof buildApi>) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({ method: "phone", contact: "254700009902", pin: "3927" })
  });
  expect(signup.statusCode).toBe(200);
  const cookie = extractSessionCookie(signup.headers["set-cookie"]);
  const business = await postJson<{ business: { id: string } }>(
    app,
    "/businesses",
    { name: "Trace Audit Shop", language: "en" },
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
