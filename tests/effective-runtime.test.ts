import { describe, expect, it } from "vitest";

import { buildApi } from "../services/api/src/app";
import { createLocalDefaultCp2Store as createCp2Store } from "./fixtures/local-default-store";
import type { ModelRuntimeAdapter } from "../services/api/src/inference/model-runtime";

describe("effective runtime API", () => {
  it("returns verified Shopkeeper + local SmolLM2 360M for an untouched account", async () => {
    const app = buildApi({
      cp2: { store: createCp2Store({ modelRuntimeAdapterResolver: resolver }) }
    });
    try {
      const actor = await createActor(app, "+254700009121");
      const response = await app.inject({
        method: "GET",
        url: `/businesses/${actor.businessId}/runtime/effective`,
        headers: { cookie: actor.cookie }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        agent: { id: "builtin:shopkeeper", name: "Shopkeeper", runtimeAdapterId: "grogoni" },
        model: { id: "smollm2-360m", name: "SmolLM2 360M Instruct Q4_0" },
        execution: { type: "local", ready: true },
        source: "default",
        status: "READY",
        ready: true
      });
      expect(response.json().binding.id).toEqual(expect.any(String));
    } finally {
      await app.close();
    }
  });

  it("reports UNAVAILABLE instead of fabricating READY when no execution adapter exists", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    try {
      const actor = await createActor(app, "+254700009122");
      const response = await app.inject({
        method: "GET",
        url: `/businesses/${actor.businessId}/runtime/effective`,
        headers: { cookie: actor.cookie }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        agent: { id: "builtin:shopkeeper", runtimeAdapterId: "grogoni" },
        model: { id: "smollm2-360m" },
        execution: { type: "local", hostId: null, ready: false },
        binding: null,
        source: "default",
        status: "UNAVAILABLE",
        ready: false
      });
    } finally {
      await app.close();
    }
  });

  it("replaces the default selection in the same binding and reset resolves the default again", async () => {
    const store = createCp2Store({ modelRuntimeAdapterResolver: resolver });
    const app = buildApi({ cp2: { store } });
    try {
      const actor = await createActor(app, "+254700009123");
      const initial = await effective(app, actor);
      const initialBindingId = initial.binding.id as string;

      const activation = await app.inject({
        method: "POST",
        url: `/api/agents/${actor.businessId}/models/qwen2.5-0.5b-android/activate`,
        headers: jsonHeaders(actor.cookie),
        payload: JSON.stringify({
          shopId: actor.businessId,
          executionTarget: "vercel",
          executionMode: "CLOUD_ONLY",
          costResponsibility: "merchant",
          permissions: { allowRemoteShopDevice: false }
        })
      });
      expect(activation.statusCode).toBe(200);

      const overridden = await effective(app, actor);
      expect(overridden).toMatchObject({
        binding: { id: initialBindingId },
        model: { id: "qwen2.5-0.5b-android" },
        source: "explicit-account",
        ready: true
      });

      const reset = await app.inject({
        method: "DELETE",
        url: `/api/agents/${actor.businessId}/model-binding?shopId=${actor.businessId}`,
        headers: { cookie: actor.cookie }
      });
      expect(reset.statusCode).toBe(200);
      const restored = await effective(app, actor);
      expect(restored).toMatchObject({
        binding: { id: initialBindingId },
        model: { id: "smollm2-360m" },
        source: "default",
        ready: true
      });
    } finally {
      await app.close();
    }
  });
});

// The default (SmolLM2 360M) runs on local Ollama; the explicitly activated model on "vercel".
const resolver = ({ modelId, executionTarget }: { modelId: string; executionTarget: string }) =>
  executionTarget === "vercel" || executionTarget === "local"
    ? adapter(modelId, executionTarget)
    : undefined;

function adapter(modelId: string, executionTarget: "vercel" | "local"): ModelRuntimeAdapter {
  return {
    provider: "test-vercel",
    executionTarget,
    canRun: async () => ({ available: true, errorCode: null, message: null }),
    healthCheck: async () => ({
      available: true,
      modelId,
      provider: "test-vercel",
      executionTarget,
      latencyMs: 1,
      responsePreview: "GROGONI_MODEL_OK",
      errorCode: null,
      message: null,
      retryable: false
    }),
    generate: async () => ({
      text: JSON.stringify({ type: "response", message: "Ready." }),
      modelId,
      provider: "test-vercel",
      executionTarget,
      latencyMs: 1
    })
  };
}

async function createActor(app: ReturnType<typeof buildApi>, contact: string) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact, pin: "1234" })
  });
  const cookieHeader = signup.headers["set-cookie"];
  const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)!.split(";")[0]!;
  const business = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: jsonHeaders(cookie),
    payload: JSON.stringify({ name: "Effective Runtime Shop", language: "en" })
  });
  return {
    cookie,
    businessId: business.json<{ business: { id: string } }>().business.id
  };
}

async function effective(
  app: ReturnType<typeof buildApi>,
  actor: { cookie: string; businessId: string }
) {
  const response = await app.inject({
    method: "GET",
    url: `/businesses/${actor.businessId}/runtime/effective`,
    headers: { cookie: actor.cookie }
  });
  expect(response.statusCode).toBe(200);
  return response.json<{
    binding: { id: string };
    model: { id: string };
    source: string;
    ready: boolean;
  }>();
}

function jsonHeaders(cookie: string) {
  return { "content-type": "application/json", cookie };
}
