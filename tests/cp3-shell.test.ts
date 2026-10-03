import { describe, expect, it } from "vitest";
import {
  createInitialChatMessages,
  emptyStates,
  getEmptyState,
  quickActions
} from "../apps/web/src/app-shell";

describe("owner shell contract", () => {
  it("exposes chat, POS, records, suppliers, invoices, sync, runtime, payments, imports, reports, logistics, compliance, beta, and launch views", () => {
    expect(quickActions.map((action) => action.id)).toEqual([
      "home",
      "chat",
      "products",
      "suppliers",
      "customers",
      "pos",
      "invoices",
      "network",
      "sync",
      "runtime",
      "payments",
      "imports",
      "logistics",
      "compliance",
      "beta",
      "launch",
      "reports",
      "notifications"
    ]);

    expect(emptyStates.map((state) => state.id)).toEqual([
      "products",
      "suppliers",
      "customers",
      "pos",
      "invoices",
      "network",
      "sync",
      "runtime",
      "payments",
      "imports",
      "logistics",
      "compliance",
      "beta",
      "launch",
      "reports",
      "notifications"
    ]);
    expect(getEmptyState("chat")).toBeUndefined();
    expect(getEmptyState("products")?.body).toContain("product record");
    expect(getEmptyState("suppliers")?.body).toContain("supplier contact");
    expect(getEmptyState("pos")?.body).toContain("point-of-sale transaction");
    expect(getEmptyState("invoices")?.body).toContain("invoice draft");
    expect(getEmptyState("network")?.body).toContain("trusted commerce graph");
    expect(getEmptyState("sync")?.body).toContain("offline mutations");
    expect(getEmptyState("runtime")?.body).toContain("runtime sessions");
    expect(getEmptyState("payments")?.body).toContain("payment records");
    expect(getEmptyState("imports")?.body).toContain("supplier records");
    expect(getEmptyState("logistics")?.body).toContain("pickup and delivery");
    expect(getEmptyState("compliance")?.body).toContain("export, verification");
    expect(getEmptyState("beta")?.body).toContain("Beta readiness");
    expect(getEmptyState("launch")?.body).toContain("Launch readiness");
    expect(getEmptyState("reports")?.body).toContain("Reports summarize");
    expect(getEmptyState("notifications")?.body).toContain("In-app alerts");
  });

  it("creates the initial unified marketplace and seller welcome message", () => {
    expect(createInitialChatMessages("Jane's Shop")[0]).toMatchObject({
      author: "grogoniclaw",
      body: expect.stringMatching(/What do you need\?.*running Jane's Shop/u)
    });
  });
});
