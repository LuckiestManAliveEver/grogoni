import { describe, expect, it } from "vitest";
import {
  createRuntimePlan,
  createRuntimeResponse,
  createRuntimeVerification
} from "../services/api/src/cp2/domains/agent-runtime/shared";

// When the agent chooses a read tool itself, the reply is the result. Seen in
// scripts/eval-agent-turn-split.ts: "How many of it are left?" ran products.list and answered
// "Check the authoritative inventory record for Blueband 500g. Done." with the stock dropped.
const verification = createRuntimeVerification({
  requiresConfirmation: false,
  confirmationSatisfied: false,
  roleAllowed: true,
  rateLimited: false,
  errors: []
});
const respond = (
  toolName: string,
  input: Record<string, unknown>,
  toolResult: unknown,
  reason: string
) =>
  createRuntimeResponse({
    plan: createRuntimePlan({
      toolName: toolName as never,
      input,
      validationErrors: [],
      confirmationToken: null,
      status: "safe_to_execute"
    }),
    proposalReason: reason,
    toolResult,
    verification
  });

describe("replies to read tools the agent chose", () => {
  it("answers a product list with each product's stock and price", () => {
    const reply = respond(
      "products.list",
      {},
      [
        { name: "Blueband 500g", quantity: 12, unit: "item", sellingPrice: 250 },
        { name: "Sugar 2kg", quantity: 0, unit: "item", sellingPrice: null }
      ],
      "Check the authoritative inventory record for Blueband 500g."
    );
    expect(reply).toBe(
      "• Blueband 500g: 12 item in stock, selling price 250\n• Sugar 2kg: 0 item in stock"
    );
    expect(reply).not.toMatch(/Done\./u);
  });

  it("says when the shop has no products, and shortens a long list", () => {
    expect(respond("products.list", {}, [], "List products.")).toBe(
      "There are no products in this shop yet."
    );
    const many = Array.from({ length: 13 }, (_, index) => ({
      name: `P${index}`,
      quantity: index,
      unit: "item",
      sellingPrice: 10
    }));
    const reply = respond("products.list", {}, many, "List products.");
    expect(reply.split("\n")).toHaveLength(11);
    expect(reply).toMatch(/and 3 more\.$/u);
  });

  it("lists matched catalogue products with their availability", () => {
    const reply = respond(
      "products.list",
      { query: "blueband" },
      {
        query: "blueband",
        total: 1,
        products: [
          {
            productId: "p1",
            businessId: "b1",
            name: "Blueband 500g",
            unit: "item",
            sellingPrice: 250,
            availability: "in_stock",
            image: null
          }
        ]
      },
      "Search the catalogue."
    );
    expect(reply).toBe(
      'Found 1 verified catalogue product for "blueband".\n• Blueband 500g: in stock, selling price 250'
    );
  });

  it("answers any other read with its result, not the plan and Done.", () => {
    const reply = respond(
      "invoices.list",
      {},
      [{ number: "INV-7", total: 1200 }],
      "Look up the invoices."
    );
    expect(reply).not.toMatch(/Done\.|Look up the invoices/u);
    expect(reply).toContain("INV-7");
    expect(reply).not.toMatch(/^#invoices\.list/u);
  });

  it("keeps the #tool header for an explicit command", () => {
    const reply = respond(
      "invoices.list",
      {},
      [{ number: "INV-7" }],
      "Explicit chat capability #invoices.list"
    );
    expect(reply.split("\n")[0]).toBe("#invoices.list");
  });
});
