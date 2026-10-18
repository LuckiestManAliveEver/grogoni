import { describe, expect, it } from "vitest";
import {
  createRuntimePlan,
  createRuntimeResponse,
  createRuntimeVerification
} from "../services/api/src/cp2/domains/agent-runtime/shared";

function reply(toolResult: unknown) {
  return createRuntimeResponse({
    plan: createRuntimePlan({
      toolName: "reports.summary",
      input: {},
      validationErrors: [],
      confirmationToken: null,
      status: "safe_to_execute"
    }),
    proposalReason: "Explicit chat capability #reports.summary.",
    verification: createRuntimeVerification({
      requiresConfirmation: false,
      confirmationSatisfied: false,
      roleAllowed: true,
      rateLimited: false,
      errors: []
    }),
    toolResult
  });
}

describe("explicit hashtag read results", () => {
  it("shows returned fields in chat instead of a generic completion", () => {
    expect(reply({ totalSales: 570, lowStockCount: 2 })).toBe(
      "#reports.summary\nTotal Sales: 570\nLow Stock Count: 2"
    );
    expect(reply([])).toContain("Results: none.");
  });

  it("bounds results and omits credential fields", () => {
    const response = reply({
      accessToken: "private-token",
      businessId: "internal-business",
      blocks: [{ text: "internal OCR details" }],
      nested: { password: "private-password" },
      rows: Array.from({ length: 100 }, (_, i) => ({ name: `Product ${i}` }))
    });
    expect(response).not.toContain("private-");
    expect(response).not.toContain("internal-");
    expect(response).not.toContain("internal OCR");
    expect(response).toContain("Product 0");
    expect(response).toContain("90 more results.");
    expect(response).not.toContain("Product 99");
  });
});
