import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const enabled = process.env.RUN_LIVE_MODEL_RUNTIME_TEST === "true";

describe.skipIf(!enabled)("live Render, Neon, and Vercel model runtime", () => {
  it("probes, activates, reloads, and chats through the deployed SmolLM binding", async () => {
    const apiUrl = required("GROGONI_API_URL").replace(/\/+$/u, "");
    const inferenceUrl = required("VERCEL_INFERENCE_URL").replace(/\/+$/u, "");
    const sessionToken = required("GROGONI_TEST_TOKEN");
    const agentId = required("GROGONI_TEST_AGENT_ID");
    const shopId = required("GROGONI_TEST_SHOP_ID");
    const modelId = process.env.GROGONI_MODEL_ID?.trim() || "smollm2-360m";
    const cookie = sessionToken.includes("=") ? sessionToken : `grogoni_session=${sessionToken}`;

    const liveness = await request(`${inferenceUrl}/health`);
    expect(liveness.response.ok).toBe(true);
    expect(liveness.body).toMatchObject({ ok: true, service: "grogoni-vercel-inference" });

    // Vercel executes whatever fully-resolved request Render sends it - there is no per-model
    // probe endpoint on the Vercel side. Render's own diagnostic route proves the whole path
    // (runtime binding -> signed Neon artifact URL -> Vercel download/load/generate) end to end.
    const probe = await request(`${apiUrl}/health/ai`);
    expect(probe.response.ok).toBe(true);
    expect(probe.body).toMatchObject({
      status: "ready",
      model: { status: "ready", model: modelId }
    });

    const activation = await request(
      `${apiUrl}/api/agents/${encodeURIComponent(agentId)}/models/${encodeURIComponent(
        modelId
      )}/activate`,
      { cookie, "content-type": "application/json" },
      "POST",
      {
        shopId,
        executionTarget: "vercel",
        executionMode: "LOCAL_FIRST",
        permissions: {
          allowRemoteShopDevice: false
        }
      }
    );
    expect(activation.response.ok).toBe(true);
    expect(activation.body).toMatchObject({
      binding: {
        agentId,
        shopId,
        modelId,
        status: "active",
        lastVerificationStatus: "passed"
      }
    });

    const binding = await request(
      `${apiUrl}/api/agents/${encodeURIComponent(
        agentId
      )}/model-binding?shopId=${encodeURIComponent(shopId)}`,
      { cookie }
    );
    expect(binding.body).toMatchObject({
      binding: { modelId, status: "active", lastVerificationStatus: "passed" }
    });

    const chat = await request(
      `${apiUrl}/businesses/${encodeURIComponent(shopId)}/runtime/turns`,
      { cookie, "content-type": "application/json" },
      "POST",
      { message: "Reply briefly with the name of the model serving this agent." }
    );
    expect(chat.response.ok).toBe(true);
    expect(chat.body).toMatchObject({
      turn: {
        model: {
          modelId,
          executionTarget: "vercel"
        }
      }
    });
    expect(chat.body?.turn?.model?.inferenceRequestId).toEqual(expect.any(String));
  }, 180_000);
});

async function request(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
  body?: unknown
): Promise<{ response: Response; body: LiveResponse | null }> {
  const response = await fetch(url, {
    method,
    headers: { accept: "application/json", "x-request-id": randomUUID(), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return {
    response,
    body: (await response.json().catch(() => null)) as LiveResponse | null
  };
}

interface LiveResponse {
  ok?: boolean;
  service?: string;
  status?: string;
  model?: {
    status?: string;
    model?: string;
  };
  binding?: {
    agentId?: string;
    shopId?: string;
    modelId?: string;
    status?: string;
    lastVerificationStatus?: string;
  };
  turn?: {
    model?: {
      modelId?: string;
      executionTarget?: string;
      inferenceRequestId?: string;
    };
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (value === "") throw new Error(`${name} is required for the live runtime test.`);
  return value;
}
