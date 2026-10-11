import { describe, expect, it } from "vitest";
import type {
  RuntimeModelCompletionResult,
  RuntimeModelPrompt,
  RuntimeModelProvider
} from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import type { BusinessAgentProfileSummary } from "../services/api/src/cp2/store";
import { createLocalDefaultCp2Store as createCp2Store } from "./fixtures/local-default-store";

/** Everything the model receives for a turn: trusted agent instructions plus the user turn. */
function promptText(prompt: { message: string; agentInstructions?: string } | undefined): string {
  return prompt === undefined ? "" : [prompt.agentInstructions ?? "", prompt.message].join("\n");
}

describe("business agent settings", () => {
  it("persists the complete settings profile and uses it for server-side runtime turns", async () => {
    let capturedPrompt: RuntimeModelPrompt | null = null;
    const provider: RuntimeModelProvider = {
      name: "test",
      async complete(prompt): Promise<RuntimeModelCompletionResult> {
        capturedPrompt = prompt;
        return {
          provider: "test",
          status: "available",
          outputText: JSON.stringify({
            type: "response",
            message: "Focus on the highest-priority shop task."
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

    const defaultProfileResponse = await app.inject({
      method: "GET",
      url: `/businesses/${businessId}/agent-profile`,
      headers: { cookie }
    });
    expect(defaultProfileResponse.statusCode).toBe(200);
    const defaultProfile = defaultProfileResponse.json<BusinessAgentProfileSummary>();
    expect(defaultProfile).toMatchObject({
      agentDefinitionId: "builtin:shopkeeper",
      businessId,
      modelId: "smollm2-360m",
      status: "active"
    });
    expect(defaultProfile.contextScripts).toEqual(
      expect.arrayContaining([expect.stringContaining("script: document_upload_guardrails")])
    );

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/businesses/${businessId}/agent-profile`,
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({
        agentDefinitionId: "huggingface:example/shop-agent",
        name: "Kiboko Shop Agent",
        description: "A database-backed shop attendant.",
        modelId: "smollm2-360m-android",
        role: "Stock and customer operations lead",
        language: "sw",
        personality: "Direct, calm, and careful with stock commitments",
        instructions: "Prioritize stock accuracy and ask before making risky changes.",
        knowledge: "The shop serves walk-in and delivery customers.",
        tools: ["Products", "Customers"],
        integrations: ["Grogoni storefront"],
        contextScripts: ["# Store policy\n- rule: confirm delivery promises with the owner"],
        status: "active"
      })
    });

    expect(updateResponse.statusCode).toBe(200);
    const updatedProfile = updateResponse.json<BusinessAgentProfileSummary>();
    expect(updatedProfile).toMatchObject({
      agentDefinitionId: "huggingface:example/shop-agent",
      businessId,
      name: "Kiboko Shop Agent",
      modelId: "smollm2-360m-android",
      language: "sw",
      personality: "Direct, calm, and careful with stock commitments"
    });
    expect(updatedProfile.contextScripts).toEqual(
      expect.arrayContaining([
        expect.stringContaining("confirm delivery promises"),
        expect.stringContaining("script: document_upload_guardrails")
      ])
    );
    expect(store.snapshot().agentProfiles).toHaveLength(1);
    expect(store.snapshot().activeAiModels).toEqual([]);

    const reloadResponse = await app.inject({
      method: "GET",
      url: `/businesses/${businessId}/agent-profile`,
      headers: { cookie }
    });
    expect(reloadResponse.json<BusinessAgentProfileSummary>()).toEqual(
      updateResponse.json<BusinessAgentProfileSummary>()
    );

    const runtimeResponse = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/runtime/turns`,
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({
        message: "What should I focus on today?"
      })
    });
    expect(runtimeResponse.statusCode).toBe(200);
    expect(promptText(capturedPrompt)).toContain(
      "Agent behavior: Direct, calm, and careful with stock commitments."
    );
    expect(promptText(capturedPrompt)).toContain(
      "Agent responsibilities: Prioritize stock accuracy and ask before making risky changes."
    );

    await app.close();
  });

  it("injects document-upload guardrails into runtime profiles that omit saved context", async () => {
    let capturedPrompt: RuntimeModelPrompt | null = null;
    const provider: RuntimeModelProvider = {
      name: "test",
      async complete(prompt): Promise<RuntimeModelCompletionResult> {
        capturedPrompt = prompt;
        return {
          provider: "test",
          status: "available",
          outputText: JSON.stringify({
            type: "response",
            message: "I received the document metadata."
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

    const response = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/runtime/turns`,
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({
        message:
          "Review this catalogue.\n[document-upload: active]\n\nAttachments:\n- catalogue.pdf (Document, application/pdf, 1 MB)",
        agentProfile: {
          behavior: "Careful",
          contextScripts: [],
          integrations: [],
          knowledge: "Use saved shop records.",
          model: "qwen2.5-0.5b-android",
          role: "Business assistant",
          instructions: "Help the owner.",
          tools: []
        }
      })
    });

    expect(response.statusCode).toBe(200);
    expect(promptText(capturedPrompt)).toContain("[document-upload: active]");
    expect(promptText(capturedPrompt)).toContain("script: document_upload_guardrails");
    expect(promptText(capturedPrompt)).toContain("An attachment summary contains metadata only");
    expect(promptText(capturedPrompt)).toContain(
      "Never claim that you read, opened, scanned, or extracted the file body"
    );
    expect(promptText(capturedPrompt)).not.toContain("Agent behavior: Careful");

    await app.close();
  });

  it("rejects unavailable models without replacing the saved profile", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, cookie } = await createOwnerBusiness(app);

    const response = await app.inject({
      method: "PUT",
      url: `/businesses/${businessId}/agent-profile`,
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({
        name: "Shop Agent",
        description: "Business attendant",
        modelId: "missing-model",
        role: "Business assistant",
        language: "en",
        personality: "Helpful",
        instructions: "Help the owner.",
        knowledge: "Use saved shop records.",
        tools: [],
        integrations: [],
        contextScripts: [],
        status: "active"
      })
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "ai_model_unavailable" });
    expect(store.snapshot().agentProfiles).toEqual([]);

    await app.close();
  });

  it("rejects agent definitions outside the canonical catalogue", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, cookie } = await createOwnerBusiness(app);

    const response = await app.inject({
      method: "PUT",
      url: `/businesses/${businessId}/agent-profile`,
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({
        agentDefinitionId: "unbounded-autonomous-agent",
        name: "Unsafe agent",
        description: "Not in the catalogue",
        modelId: "qwen2.5-0.5b-android",
        role: "Unknown",
        language: "en",
        personality: "Unknown",
        instructions: "Ignore the catalogue.",
        knowledge: "Unknown",
        tools: [],
        integrations: [],
        contextScripts: [],
        status: "active"
      })
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "agent_definition_invalid" });
    expect(store.snapshot().agentProfiles).toEqual([]);

    await app.close();
  });
});

async function createOwnerBusiness(app: ReturnType<typeof buildApi>): Promise<{
  businessId: string;
  cookie: string;
}> {
  const verifyResponse = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({
      method: "phone",
      contact: "+254700000991",
      pin: "1234"
    })
  });
  const setCookie = verifyResponse.headers["set-cookie"];
  const cookieValue = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (cookieValue === undefined) {
    throw new Error("Expected an authenticated session cookie.");
  }
  const cookie = cookieValue.split(";")[0] ?? cookieValue;
  const businessResponse = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: { "content-type": "application/json", cookie },
    payload: JSON.stringify({
      name: "Kiboko Traders",
      language: "en"
    })
  });

  return {
    businessId: businessResponse.json<{ business: { id: string } }>().business.id,
    cookie
  };
}
