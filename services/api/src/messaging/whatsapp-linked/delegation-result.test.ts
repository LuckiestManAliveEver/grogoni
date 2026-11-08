import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { RuntimePlannedAction, RuntimeTurnSummary } from "@grogoni/shared-types";
import { buildApi } from "../../app.js";
import { createCp2Store } from "../../cp2/store.js";
import { registerLinkedWhatsAppRoutes } from "./routes.js";
import type { LinkedDriver } from "./connector.js";
import {
  linkedDelegationResultMaxLength,
  linkedDelegationResultText
} from "./delegation-result.js";
import { linkedToolChoices } from "./tool-grants.js";
import {
  originatingDelegatedTurn,
  reportChannelDelegationResolution,
  reportConfirmedChannelDelegation
} from "../../cp2/domains/agent-runtime/channel-delegation-result.js";
import { rejectRuntimeApproval } from "../../cp2/domains/agent-runtime/runtime-approval-rejection.js";

const chat = "254711111111@s.whatsapp.net";
const token = "t".repeat(32);

/** Same harness shape as routes.test.ts in this directory. */
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "wa-result-"));
  const store = createCp2Store();
  const main = buildApi({ cp2: { store } });
  const signup = await main.inject({
    method: "POST",
    url: "/auth/pin/signup",
    payload: { method: "phone", contact: "254700009881", pin: "1771" }
  });
  expect(signup.statusCode, signup.body).toBe(200);
  const header = signup.headers["set-cookie"];
  const cookie = (Array.isArray(header) ? header[0]! : header!).split(";")[0]!;
  const created = await main.inject({
    method: "POST",
    url: "/businesses",
    headers: { cookie },
    payload: { name: "WhatsApp result shop", language: "en" }
  });
  expect(created.statusCode, created.body).toBe(200);
  const businessId = created.json().business.id as string;
  const ownerId = store
    .snapshot()
    .memberships.find((entry) => entry.businessId === businessId && entry.role === "owner")!.userId;
  const callbacks: Parameters<LinkedDriver["open"]>[0][] = [];
  const send = vi.fn(async (_chat: string, _text: string, id: string) => id);
  const driver: LinkedDriver = {
    open: vi.fn(async (input) => {
      callbacks.push(input);
      return {
        pairingCode: async () => "CODE1234",
        groups: async () => [],
        send,
        downloadMedia: async () => Buffer.alloc(0),
        close: vi.fn(),
        logout: async () => undefined
      };
    })
  };
  const app = Fastify();
  registerLinkedWhatsAppRoutes(
    app,
    store,
    {
      WHATSAPP_LINKED_ENABLED: "true",
      WHATSAPP_LINKED_DAEMON_URL: "https://daemon.example",
      DAEMON_SERVICE_TOKEN: token,
      WHATSAPP_LINKED_SESSION_DIR: root,
      WHATSAPP_LINKED_SESSION_KEY: "01".repeat(32)
    },
    driver
  );
  await app.ready();
  const headers = { cookie };
  const path = `/businesses/${businessId}/channels/whatsapp-linked`;
  await app.inject({
    method: "POST",
    url: `${path}/connect`,
    headers,
    payload: { phone: "254700000000", consent: true }
  });
  callbacks[0]!.state("open");
  const scoped = await app.inject({
    method: "POST",
    url: `${path}/scopes`,
    headers,
    payload: { chat, approved: true, automation: true }
  });
  expect(scoped.statusCode, scoped.body).toBe(200);
  const grantTools = async (tools: string[]) => {
    const response = await app.inject({
      method: "POST",
      url: `${path}/tools`,
      headers,
      payload: { chat, consent: true, tools }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().id as string;
  };
  let grantId = await grantTools(["products.list", "product.create"]);
  let counter = 0;
  /** A WhatsApp participant asks for a write; returns the owner-facing proposal and its card. */
  const requestWrite = async (text = "Add 3 packets of milk at 100 each") => {
    const id = `request-${++counter}`;
    await store.ingestLinkedWhatsAppMessage({
      businessId,
      ownerId,
      chat,
      sender: chat,
      id,
      text,
      timestamp: new Date().toISOString()
    });
    const prepared = await app.inject({
      method: "POST",
      url: "/internal/whatsapp-linked/turn",
      headers: { authorization: `Bearer ${token}` },
      payload: { businessId, ownerId, chat, sender: chat, messageId: id, grantId }
    });
    expect(prepared.statusCode, prepared.body).toBe(200);
    expect(prepared.json().text).toContain("owner's approval");
    const proposal = store
      .snapshot()
      .runtimeTurns.filter(
        (turn) => turn.status === "needs_confirmation" && turn.plan.channelDelegation
      )
      .at(-1)!;
    const card = store
      .snapshot()
      .conversationMessages.find(
        (message) => message.idempotencyKey === `whatsapp-approval:${proposal.id}`
      )!;
    return { proposal, conversationId: card.conversationId };
  };
  const approve = (proposal: RuntimeTurnSummary, conversationId: string) =>
    main.inject({
      method: "POST",
      url: `/businesses/${businessId}/runtime/turns`,
      headers,
      payload: {
        runtimeSessionId: proposal.sessionId,
        conversationId,
        message: "confirm",
        confirmationToken: proposal.plan.confirmationToken
      }
    });
  const reject = (proposal: RuntimeTurnSummary, conversationId: string) =>
    main.inject({
      method: "POST",
      url: `/businesses/${businessId}/runtime/approvals/reject`,
      headers,
      payload: {
        runtimeSessionId: proposal.sessionId,
        conversationId,
        confirmationToken: proposal.plan.confirmationToken
      }
    });
  const resultMessages = () =>
    store
      .snapshot()
      .conversationMessages.filter((message) =>
        message.idempotencyKey?.startsWith("whatsapp-result:")
      );
  const resultAudits = () =>
    store
      .snapshot()
      .auditEvents.filter((event) => event.type.startsWith("whatsapp_linked.delegated_result"));
  return {
    store,
    app,
    main,
    headers,
    businessId,
    ownerId,
    send,
    requestWrite,
    approve,
    reject,
    resultMessages,
    resultAudits,
    regrant: async (tools: string[]) => {
      grantId = await grantTools(tools);
      return grantId;
    },
    close: async () => {
      await app.close();
      await main.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

// Each case signs up an owner (PIN hashing) and drives full HTTP flows; allow for a loaded host.
describe("WhatsApp delegated action outcome after owner resolution", { timeout: 30_000 }, () => {
  it("sends exactly one outcome to the originating chat when the owner approves", async () => {
    const f = await setup();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      expect(f.send).not.toHaveBeenCalled();
      const accepted = await f.approve(proposal, conversationId);
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json().turn.status).toBe("completed");
      expect(f.store.snapshot().products).toHaveLength(1);
      expect(f.send).toHaveBeenCalledTimes(1);
      const [sentChat, sentText] = f.send.mock.calls[0]!;
      expect(sentChat).toBe(chat);
      expect(sentText).toBe("Done: the new catalogue item was added.");
      const [message] = f.resultMessages();
      expect(f.resultMessages()).toHaveLength(1);
      expect(message).toMatchObject({
        idempotencyKey: `whatsapp-result:${proposal.id}`,
        conversationId,
        direction: "outbound",
        provider: "whatsapp_linked"
      });
      // No owner-only context: no confirmation token, no tool input, no product id.
      const product = f.store.snapshot().products[0]!;
      expect(sentText).not.toContain(proposal.plan.confirmationToken!);
      expect(sentText).not.toContain(product.id);
      expect(sentText).not.toContain("100");
      expect(f.resultAudits().map((event) => event.type)).toEqual([
        "whatsapp_linked.delegated_result_sent"
      ]);
      expect(f.resultAudits()[0]).toMatchObject({
        aggregateId: proposal.id,
        actorId: f.ownerId,
        payload: { outcome: "executed", tool: "product.create" }
      });
    } finally {
      await f.close();
    }
  });

  it("tells the chat the owner declined when the owner rejects", async () => {
    const f = await setup();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      const rejected = await f.reject(proposal, conversationId);
      expect(rejected.statusCode, rejected.body).toBe(200);
      expect(rejected.json()).toEqual({ status: "REJECTED" });
      expect(f.store.snapshot().products).toHaveLength(0);
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.send.mock.calls[0]!.slice(0, 2)).toEqual([
        chat,
        "The shop owner declined this request."
      ]);
      expect(f.resultMessages()[0]!.idempotencyKey).toBe(`whatsapp-result:${proposal.id}`);
      expect(f.resultAudits()[0]).toMatchObject({
        type: "whatsapp_linked.delegated_result_sent",
        payload: { outcome: "rejected" }
      });
    } finally {
      await f.close();
    }
  });

  it("sends nothing and audits why when the grant is revoked before approval", async () => {
    const f = await setup();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      await f.regrant([]);
      const denied = await f.approve(proposal, conversationId);
      // Execution re-checks the grant, so the approved write is blocked rather than run.
      expect(denied.statusCode, denied.body).toBe(200);
      expect(denied.json().turn.status).toBe("blocked");
      expect(f.store.snapshot().products).toHaveLength(0);
      expect(f.send).not.toHaveBeenCalled();
      expect(f.resultMessages()).toHaveLength(0);
      expect(f.resultAudits()).toEqual([
        expect.objectContaining({
          type: "whatsapp_linked.delegated_result_suppressed",
          aggregateId: proposal.id,
          payload: expect.objectContaining({
            reason: "whatsapp_tool_grant_revoked",
            outcome: "failed"
          })
        })
      ]);
    } finally {
      await f.close();
    }
  });

  it("sends nothing on rejection when the grant was revoked, and audits the reason", async () => {
    const f = await setup();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      // Re-granting the same tools issues a new grant id: the original authority is gone.
      await f.regrant(["products.list", "product.create"]);
      expect((await f.reject(proposal, conversationId)).statusCode).toBe(200);
      expect(f.send).not.toHaveBeenCalled();
      expect(f.resultAudits()).toEqual([
        expect.objectContaining({
          type: "whatsapp_linked.delegated_result_suppressed",
          payload: expect.objectContaining({
            reason: "whatsapp_tool_grant_revoked",
            outcome: "rejected"
          })
        })
      ]);
    } finally {
      await f.close();
    }
  });

  it("honours the recipient's STOP: no outcome is sent after they opt out", async () => {
    const f = await setup();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      await f.store.ingestLinkedWhatsAppMessage({
        businessId: f.businessId,
        ownerId: f.ownerId,
        chat,
        sender: chat,
        id: "stop",
        text: "STOP",
        timestamp: new Date().toISOString()
      });
      expect((await f.reject(proposal, conversationId)).statusCode).toBe(200);
      expect(f.send).not.toHaveBeenCalled();
      expect(f.resultAudits()).toEqual([
        expect.objectContaining({
          type: "whatsapp_linked.delegated_result_suppressed",
          payload: expect.objectContaining({ reason: "recipient_opted_out" })
        })
      ]);
    } finally {
      await f.close();
    }
  });

  it("never sends a duplicate when the same approval is resolved again", async () => {
    const f = await setup();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      expect((await f.approve(proposal, conversationId)).statusCode).toBe(200);
      expect([403, 404]).toContain((await f.approve(proposal, conversationId)).statusCode);
      expect([403, 404]).toContain((await f.reject(proposal, conversationId)).statusCode);
      expect(f.send).toHaveBeenCalledTimes(1);
      // Even a replayed delivery for the same originating turn is absorbed by the idempotency key.
      await f.store.deliverLinkedDelegationResult({
        businessId: f.businessId,
        turnId: proposal.id,
        delegation: proposal.plan.channelDelegation!,
        toolName: "product.create",
        outcome: "executed",
        resolvedBy: f.ownerId
      });
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.resultMessages()).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("leaves owner-originated (non-delegated) approvals untouched", async () => {
    const f = await setup();
    try {
      const { conversationId } = await f.requestWrite();
      const created = await f.main.inject({
        method: "POST",
        url: `/businesses/${f.businessId}/runtime/sessions`,
        headers: f.headers,
        payload: {}
      });
      expect(created.statusCode, created.body).toBe(200);
      const runtimeSessionId = (created.json().session ?? created.json()).id as string;
      const owned = await f.main.inject({
        method: "POST",
        url: `/businesses/${f.businessId}/runtime/turns`,
        headers: f.headers,
        payload: { runtimeSessionId, message: "Add 2 packets of sugar at 150 each" }
      });
      expect(owned.statusCode, owned.body).toBe(200);
      // Owners run their own writes directly; nothing is reported to any WhatsApp chat.
      const turn = owned.json().turn as RuntimeTurnSummary;
      expect(turn.status).toBe("completed");
      expect(turn.plan.channelDelegation).toBeUndefined();
      expect(f.send).not.toHaveBeenCalled();
      expect(f.resultAudits()).toHaveLength(0);
      expect(conversationId).toBeTruthy();
    } finally {
      await f.close();
    }
  });
});

describe("delegated outcome text and routing", () => {
  it("uses fixed, bounded text for every delegable tool and outcome", () => {
    for (const tool of [...linkedToolChoices, "unknown.tool"])
      for (const outcome of ["executed", "failed", "rejected"] as const) {
        const text = linkedDelegationResultText(outcome, tool);
        expect(text.length).toBeLessThanOrEqual(linkedDelegationResultMaxLength);
        expect(text).not.toContain(tool);
      }
    expect(linkedDelegationResultText("executed", "__proto__")).toBe(
      "Done: your request was completed."
    );
    expect(linkedDelegationResultText("rejected", "product.create")).toBe(
      "The shop owner declined this request."
    );
  });

  const delegation = {
    channelId: "channel",
    grantId: "grant",
    ownerId: "owner",
    sourceMessageId: "source",
    actorId: chat
  };
  const action = {
    id: "action",
    toolName: "product.create",
    channelDelegation: delegation
  } as RuntimePlannedAction;
  const origin = {
    id: "origin",
    businessId: "business",
    sourceMessageId: "source",
    plan: action
  } as RuntimeTurnSummary;
  const { sourceMessageId: _source, ...unsourced } = origin;
  const confirmation = { ...unsourced, id: "confirmation" } as RuntimeTurnSummary;
  const { channelDelegation: _delegation, ...plainAction } = action;
  const plain = plainAction as RuntimePlannedAction;
  void [_source, _delegation];

  it("routes to the originating proposal turn, never the confirmation turn", () => {
    expect(originatingDelegatedTurn([confirmation, origin], "business", action)?.id).toBe("origin");
    expect(originatingDelegatedTurn([origin], "other-business", action)).toBeUndefined();
    expect(originatingDelegatedTurn([origin], "business", plain)).toBeUndefined();
  });

  it("never throws into the owner's resolution and audits a delivery failure", async () => {
    const recordAuditEvent = vi.fn();
    const deliverChannelDelegationResult = vi.fn(async () => {
      throw new Error("socket closed");
    });
    const input = {
      businessId: "business",
      action,
      outcome: "rejected" as const,
      resolvedBy: "owner",
      now: new Date("2026-11-08T00:00:00Z")
    };
    await expect(
      reportChannelDelegationResolution(
        { recordAuditEvent, deliverChannelDelegationResult },
        [origin],
        input
      )
    ).resolves.toBeUndefined();
    expect(deliverChannelDelegationResult).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: "origin", outcome: "rejected" })
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "runtime.channel_delegation_result_undelivered",
        payload: expect.objectContaining({ reason: "delivery_failed" })
      })
    );
    recordAuditEvent.mockClear();
    deliverChannelDelegationResult.mockClear();
    await reportChannelDelegationResolution(
      { recordAuditEvent, deliverChannelDelegationResult },
      [],
      input
    );
    expect(deliverChannelDelegationResult).not.toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ reason: "originating_turn_not_found" })
      })
    );
  });

  it("ignores non-delegated confirmations and rejections", async () => {
    const deliverChannelDelegationResult = vi.fn(async () => undefined);
    const recordAuditEvent = vi.fn();
    const deps = { deliverChannelDelegationResult, recordAuditEvent };
    await reportConfirmedChannelDelegation(deps, [origin], {
      ...origin,
      plan: plain,
      status: "completed",
      actorId: "owner",
      createdAt: new Date().toISOString()
    } as RuntimeTurnSummary);
    const now = new Date("2026-11-08T00:00:00Z");
    const pending = new Map([
      [
        "token",
        {
          sessionId: "runtime",
          businessId: "business",
          actorId: "owner",
          conversationId: null,
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
          intent: "add_product" as const,
          action: plain
        }
      ]
    ]);
    const sessions = new Map([
      [
        "runtime",
        {
          id: "runtime",
          businessId: "business",
          userId: "owner",
          status: "active" as const,
          turnCount: 0,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString()
        }
      ]
    ]);
    await expect(
      rejectRuntimeApproval(
        {
          ...deps,
          requireAuthorizedSession: () =>
            ({ user: { id: "owner" } }) as ReturnType<
              Parameters<typeof rejectRuntimeApproval>[0]["requireAuthorizedSession"]
            >
        },
        sessions,
        pending,
        {
          sessionId: "auth",
          businessId: "business",
          runtimeSessionId: "runtime",
          confirmationToken: "token",
          now
        },
        [origin]
      )
    ).resolves.toEqual({ status: "REJECTED" });
    expect(pending.size).toBe(0);
    expect(deliverChannelDelegationResult).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});
