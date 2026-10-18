import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedActorView, RuntimeSessionSummary } from "@grogoni/shared-types";
import { rejectRuntimeApproval } from "./runtime-approval-rejection.js";
import type { PendingRuntimeAction } from "./shared.js";

describe("authorized runtime approval rejection", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const input = {
    sessionId: "auth",
    businessId: "business",
    runtimeSessionId: "runtime",
    confirmationToken: "token",
    now
  };
  const sessions = () =>
    new Map<string, RuntimeSessionSummary>([
      [
        "runtime",
        {
          id: "runtime",
          businessId: "business",
          userId: "actor",
          status: "active",
          turnCount: 0,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString()
        }
      ]
    ]);
  const authorize = () => ({ user: { id: "actor" } }) as AuthenticatedActorView;
  const proposal = (): PendingRuntimeAction => ({
    businessId: "business",
    actorId: "actor",
    sessionId: "runtime",
    conversationId: null,
    intent: "add_product",
    expiresAt: new Date(now.getTime() + 60000).toISOString(),
    action: {
      id: "action",
      toolName: "product.create",
      risk: "medium",
      requiresConfirmation: true,
      status: "needs_confirmation",
      input: {},
      validationErrors: [],
      confirmationToken: "token",
      executedAt: null
    }
  });
  it("removes only the matching ephemeral approval without needing a model host", async () => {
    const pending = new Map([["token", proposal()]]);
    await expect(
      rejectRuntimeApproval({ requireAuthorizedSession: authorize }, sessions(), pending, input)
    ).resolves.toEqual({ status: "REJECTED" });
    expect(pending.size).toBe(0);
    await expect(
      rejectRuntimeApproval({ requireAuthorizedSession: authorize }, sessions(), pending, input)
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  it.each([
    { businessId: "foreign" },
    { runtimeSessionId: "foreign" },
    { conversationId: "foreign" },
    { now: new Date(now.getTime() + 60001) }
  ])("does not consume mismatched or expired ephemeral approvals: %j", async (override) => {
    const pending = new Map([["token", proposal()]]);
    await expect(
      rejectRuntimeApproval({ requireAuthorizedSession: authorize }, sessions(), pending, {
        ...input,
        ...override
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(pending.size).toBe(1);
  });
  it("reauthorizes before changing approval state", async () => {
    const pending = new Map([["token", proposal()]]);
    const requireAuthorizedSession = vi.fn(() => {
      throw new Error("Access revoked");
    });
    await expect(
      rejectRuntimeApproval({ requireAuthorizedSession }, sessions(), pending, input)
    ).rejects.toThrow("Access revoked");
    expect(requireAuthorizedSession).toHaveBeenCalledWith("auth", "business", "business:read", now);
    expect(pending.size).toBe(1);
  });
});
