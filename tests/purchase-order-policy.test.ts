import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import { createInventoryProcurementStore } from "../services/api/src/cp2/domains/agent-runtime/inventory-procurement-store";
import { procurementRuntimeTools } from "../packages/tool-core/src/domains/procurement";
import { validateRuntimeToolInput } from "../packages/tool-core/src/validation/runtime";

describe("canonical purchase order approval policy", () => {
  it.each(["procurement.submit", "procurement.respond"] as const)(
    "requires high-risk confirmation and supplier write for %s",
    (tool) => {
      expect(procurementRuntimeTools[tool]).toMatchObject({
        risk: "high",
        requiresConfirmation: true,
        requiredPermission: "supplier:write",
        readOnly: false,
        mcpExposable: false
      });
    }
  );
  it("rejects injected order values, arbitrary channels, recipient headers and unconsented sends", () => {
    const input = {
      draftId: "draft",
      draftDigest: "a".repeat(64),
      channel: "email",
      recipient: "supplier@example.test",
      mailboxId: "mailbox",
      optInConfirmed: true
    };
    expect(validateRuntimeToolInput("procurement.submit", input).ok).toBe(true);
    for (const changes of [
      { totalMinor: 1 },
      { recipient: "supplier@example.test\r\nBcc: attacker@example.test" },
      { channel: "sms" },
      { optInConfirmed: false },
      { draftDigest: "unknown" },
      { budgetMinor: 1 }
    ])
      expect(validateRuntimeToolInput("procurement.submit", { ...input, ...changes }).ok).toBe(
        false
      );
    expect(
      validateRuntimeToolInput("procurement.respond", {
        orderId: "order",
        revision: -1,
        decision: "ACCEPTED"
      }).ok
    ).toBe(false);
  });
  it("never calls submission before canonical confirmation and consumes the exact approval once", async () => {
    const submit = vi.fn(async () => ({ status: "SUBMITTED_IN_APP", order_id: "order" }));
    const inventoryProcurement = {
      ...createInventoryProcurementStore(
        async () => {
          throw new Error("Unexpected native operation");
        },
        () => ({ userId: "unused" })
      ),
      submit
    };
    const runtime = createCp2Store({
      inventoryProcurement,
      platformDefaultRuntime: {
        agentId: "builtin:shopkeeper:v1",
        agentName: "Shopkeeper",
        agentRuntimeAdapterId: "grogoni",
        modelId: "smollm2-360m",
        executionTarget: "local"
      }
    });
    const app = buildApi({ cp2: { store: runtime } });
    try {
      const signup = await app.inject({
        method: "POST",
        url: "/auth/pin/signup",
        payload: { method: "phone", contact: "254700009933", pin: "1234" }
      });
      expect(signup.statusCode).toBe(200);
      const cookie = String(signup.headers["set-cookie"]).split(";")[0];
      const business = await app.inject({
        method: "POST",
        url: "/businesses",
        headers: { cookie },
        payload: { name: "Buyer fixture", language: "en" }
      });
      const businessId = business.json().business.id;
      const url = `/businesses/${businessId}/runtime/turns`;
      const input = {
        draftId: "draft",
        draftDigest: "a".repeat(64),
        channel: "grogoni",
        recipient: "supplier"
      };
      const proposed = await app.inject({
        method: "POST",
        url,
        headers: { cookie },
        payload: { message: `#procurement.submit ${JSON.stringify(input)}` }
      });
      expect(proposed.statusCode, proposed.body).toBe(200);
      const proposal = proposed.json();
      expect(proposal.turn.status).toBe("needs_confirmation");
      expect(submit).not.toHaveBeenCalled();
      const payload = {
        runtimeSessionId: proposal.session.id,
        confirmationToken: proposal.turn.plan.confirmationToken,
        message: "confirm"
      };
      const confirmed = await app.inject({ method: "POST", url, headers: { cookie }, payload });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json().turn.status).toBe("completed");
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0]?.[1]).toEqual(input);
      await app.inject({ method: "POST", url, headers: { cookie }, payload });
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
