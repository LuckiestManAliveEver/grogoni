import { describe, expect, it } from "vitest";
import { interactiveResponseBudgetMs, responseBudgetClass } from "../services/api/src/app";

describe("API response latency policy", () => {
  it("keeps ordinary and shop-system APIs on the strict 150ms budget", () => {
    expect(interactiveResponseBudgetMs).toBe(150);
    expect(responseBudgetClass("GET", "/buy/search?query=rice")).toBe("interactive");
    expect(responseBudgetClass("PUT", "/v1/shop-system/catalogue")).toBe("interactive");
    expect(responseBudgetClass("GET", "/v1/shop-system/orders")).toBe("interactive");
  });

  it("labels operations that cannot honestly satisfy an interactive deadline", () => {
    expect(responseBudgetClass("POST", "/auth/pin/login")).toBe("long-running");
    expect(responseBudgetClass("POST", "/v1/inference")).toBe("long-running");
    expect(responseBudgetClass("POST", "/v1/chat/images/read")).toBe("long-running");
    expect(responseBudgetClass("POST", "/businesses/shop-1/imports")).toBe("long-running");
    expect(responseBudgetClass("POST", "/businesses/shop-1/model-templates/t/evaluations")).toBe(
      "long-running"
    );
  });
});
