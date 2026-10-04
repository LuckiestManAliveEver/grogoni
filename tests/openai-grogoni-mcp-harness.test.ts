import { describe, expect, it } from "vitest";
// @ts-expect-error The live harness is intentionally a directly executable MJS module.
import {
  assertNoSecretLeak,
  catalogueProducts,
  discoveredToolNames,
  invalidMcpUrl,
  loadHarnessConfig,
  makeMcpTool,
  makeRedactor,
  parseModelJson,
  replaceShopId,
  responseText,
  runtimeState
} from "../scripts/openai-grogoni-mcp-harness.mjs";

const baseEnv = {
  OPENAI_API_KEY: "openai-test-secret",
  GROGONI_MCP_SERVER_URL: "https://grogoni.com/mcp?shopId=shop-one",
  GROGONI_MCP_TOKEN: "grogoni-test-secret",
  GROGONI_SHOP_ID: "shop-one"
};

describe("OpenAI Grogoni MCP live harness helpers", () => {
  it("refuses missing credentials and mismatched shop bindings without echoing secrets", () => {
    expect(() => loadHarnessConfig({})).toThrow(/OPENAI_API_KEY.*GROGONI_MCP_SERVER_URL/u);
    expect(() => loadHarnessConfig({ ...baseEnv, GROGONI_SHOP_ID: "shop-two" })).toThrow(
      /matching GROGONI_SHOP_ID/u
    );
  });

  it("uses the repository OpenAI fast-model default and always requires approval", () => {
    const config = loadHarnessConfig(baseEnv);
    expect(config.model).toBe("gpt-5-mini");
    expect(makeMcpTool(config)).toMatchObject({
      type: "mcp",
      server_label: "grogoni_shop",
      authorization: "grogoni-test-secret",
      require_approval: "always"
    });
  });

  it("extracts discovered tools, output text, catalogue envelopes, and runtime state", () => {
    const response = {
      output: [
        {
          type: "mcp_list_tools",
          tools: [{ name: "grogoni.query_catalogue" }, { name: "grogoni.list_shops" }]
        },
        { type: "message", content: [{ type: "output_text", text: "done" }] }
      ]
    };
    expect(discoveredToolNames(response)).toEqual([
      "grogoni.list_shops",
      "grogoni.query_catalogue"
    ]);
    expect(responseText(response)).toBe("done");

    const catalogue = catalogueProducts({
      type: "mcp_call",
      name: "grogoni.query_catalogue",
      status: "completed",
      output: JSON.stringify({
        content: [{ type: "text", text: '{"products":[]}' }],
        structuredContent: { products: [] },
        isError: false
      })
    });
    expect(catalogue).toMatchObject({
      parsed: { hasContent: true, hasStructuredContent: true, isError: false },
      products: []
    });

    expect(
      runtimeState({
        type: "mcp_call",
        name: "grogoni.runtime_turn",
        status: "completed",
        output: JSON.stringify({
          structuredContent: {
            session: { id: "runtime-session" },
            turn: {
              status: "needs_confirmation",
              plan: { toolName: "product.update", confirmationToken: "confirmation" }
            }
          },
          isError: false
        })
      })
    ).toMatchObject({
      status: "needs_confirmation",
      runtimeSessionId: "runtime-session",
      confirmationToken: "confirmation",
      toolName: "product.update"
    });
  });

  it("parses fenced model JSON and derives isolated invalid URLs", () => {
    expect(parseModelJson('```json\n{"products":[]}\n```')).toEqual({ products: [] });
    expect(replaceShopId(baseEnv.GROGONI_MCP_SERVER_URL, "foreign-shop")).toContain(
      "shopId=foreign-shop"
    );
    expect(invalidMcpUrl(baseEnv.GROGONI_MCP_SERVER_URL)).toContain(
      "/mcp/__openai_mcp_verification_missing__"
    );
  });

  it("redacts exact secrets, Grogoni token shapes, and Authorization headers", () => {
    const redact = makeRedactor(["openai-test-secret", "grogoni_mcp_live_abc123"]);
    const output = redact(
      "openai-test-secret grogoni_mcp_live_abc123 Authorization: Bearer visible-token"
    );
    expect(output).not.toContain("openai-test-secret");
    expect(output).not.toContain("live_abc123");
    expect(output).not.toContain("visible-token");
    expect(() => assertNoSecretLeak(output, ["openai-test-secret"])).not.toThrow();
    expect(() => assertNoSecretLeak("leaked openai-test-secret", ["openai-test-secret"])).toThrow(
      /configured secret/u
    );
  });
});
