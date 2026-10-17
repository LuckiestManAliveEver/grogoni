import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerChatImageRoutes } from "./chat-image-routes.js";
import { createOpenRouterModelAdapter } from "../inference/openrouter-model-runtime.js";
import type { Cp2Store } from "./store.js";

const contentBase64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64");
const payload = { fileName: "receipt.png", contentType: "image/png", contentBase64 };
async function fixture(
  options: { signedIn?: boolean; model?: string; text?: string; finishReason?: string } = {}
) {
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({
      model: options.model ?? "openai/gpt-6-luna",
      choices: [
        {
          finish_reason: options.finishReason ?? "stop",
          message: {
            content:
              options.text ??
              JSON.stringify({ type: "response", message: "RECEIPT ZXQ-4827\nTOTAL KES 570" })
          }
        }
      ]
    })
  );
  const model = createOpenRouterModelAdapter({
    modelId: "gpt-6-luna",
    providerModelId: "openai/gpt-6-luna",
    apiKey: "server-secret",
    request
  });
  const app = Fastify();
  registerChatImageRoutes(
    app,
    {
      getSession: () => (options.signedIn === false ? null : { account: { id: "buyer" } })
    } as unknown as Cp2Store,
    () => model
  );
  return { app, request };
}
describe("Luna chat image reader", () => {
  it("sends private image pixels to connected Luna and returns a transcription without a shop", async () => {
    const { app, request } = await fixture();
    try {
      const result = await app.inject({ method: "POST", url: "/v1/chat/images/read", payload });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        text: "RECEIPT ZXQ-4827\nTOTAL KES 570",
        engine: "gpt-6-luna",
        format: "ocr"
      });
      expect(result.headers["cache-control"]).toBe("no-store");
      const body = JSON.parse(request.mock.calls[0]![1]!.body as string);
      expect(body.provider).toEqual({ allow_fallbacks: false });
      expect(body.messages.at(-1).content).toContainEqual({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${contentBase64}`, detail: "high" }
      });
      expect(JSON.stringify(body.messages[0])).toContain("untrusted document content");
      expect(result.body).not.toContain("server-secret");
    } finally {
      await app.close();
    }
  });
  it("requires authentication before calling Luna", async () => {
    const { app, request } = await fixture({ signedIn: false });
    try {
      expect(
        (await app.inject({ method: "POST", url: "/v1/chat/images/read", payload })).statusCode
      ).toBe(401);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each([
    { ...payload, contentBase64: "not an image" },
    { ...payload, contentType: "image/jpeg" },
    { ...payload, contentBase64: "https://example.com/private" },
    { ...payload, contentType: "image/svg+xml" }
  ])("rejects invalid uploads without a provider call", async (invalid) => {
    const { app, request } = await fixture();
    try {
      expect(
        (await app.inject({ method: "POST", url: "/v1/chat/images/read", payload: invalid }))
          .statusCode
      ).toBe(400);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each([
    { model: "other-model" },
    { text: "broken JSON" },
    { text: JSON.stringify({ type: "action", tool: "products.create" }) },
    { finishReason: "length" }
  ])("rejects wrong-model, incomplete and malformed readings", async (options) => {
    const { app } = await fixture(options);
    try {
      expect(
        (await app.inject({ method: "POST", url: "/v1/chat/images/read", payload })).statusCode
      ).toBeGreaterThanOrEqual(500);
    } finally {
      await app.close();
    }
  });
});
