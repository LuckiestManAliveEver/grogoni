import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type {
  McpAccessScope,
  RuntimePlannedAction,
  RuntimeTurnSummary
} from "@grogoni/shared-types";
import { buildApi } from "../../app.js";
import { createCp2Store, type Cp2Snapshot, type Cp2Store } from "../../cp2/store.js";
import { registerLinkedWhatsAppRoutes, type LinkedWhatsAppRoutesHandle } from "./routes.js";
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
import type { RuntimeApprovalStore } from "../../cp2/domains/agent-runtime/runtime-approval-store.js";
import type { PendingRuntimeAction } from "../../cp2/domains/agent-runtime/shared.js";
import { Cp2Error } from "../../cp2/cp2-error.js";

const chat = "254711111111@s.whatsapp.net";
const token = "t".repeat(32);
const sessionKey = "01".repeat(32);

/**
 * Pending approvals live outside the CP2 snapshot (Postgres `business_runtime_approvals` in
 * production). Both API hosts share this one, as they share that table.
 */
function sharedApprovals(): RuntimeApprovalStore {
  const pending = new Map<string, PendingRuntimeAction>();
  const take = (input: Parameters<RuntimeApprovalStore["claim"]>[0]) => {
    const found = pending.get(input.token);
    if (
      !found ||
      found.businessId !== input.businessId ||
      found.sessionId !== input.runtimeSessionId
    )
      throw new Cp2Error(
        404,
        "runtime_confirmation_not_found",
        "Runtime confirmation was not found."
      );
    pending.delete(input.token);
    return found;
  };
  return {
    deleteScope: async () => 0,
    purgeExpired: async () => 0,
    put: async (token, action) => void pending.set(token, structuredClone(action)),
    claim: async (input) => take(input),
    reject: async (input) => take(input).action
  };
}

type Send = (
  chat: string,
  text: string,
  id: string,
  media?: unknown,
  quote?: { id: string; sender: string | null; fromMe: boolean; text: string }
) => Promise<string>;

/**
 * One Node connector host (store + linked routes + mocked WhatsApp socket) and, on demand, an
 * "Edge" API: a second store hydrated from the same data with no connector at all, standing in
 * for the Supabase Edge function. Shared storage between them is modelled the way Postgres does
 * it: the Node host reads the Edge store's pending outbox rows on every drain pass.
 */
async function setup(
  options: {
    root?: string;
    snapshot?: Cp2Snapshot;
    daemon?: { reply: () => Promise<string> };
    approvals?: RuntimeApprovalStore;
  } = {}
) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "wa-result-"));
  const approvals = options.approvals ?? sharedApprovals();
  const store = createCp2Store({ runtimeApprovalStore: approvals });
  if (options.snapshot) store.hydrateSnapshot(structuredClone(options.snapshot));
  const main = buildApi({ cp2: { store } });
  const callbacks: Parameters<LinkedDriver["open"]>[0][] = [];
  const send = vi.fn<Send>(async (_chat, _text, id) => id);
  const driver: LinkedDriver = {
    open: vi.fn(async (input) => {
      callbacks.push(input);
      return {
        pairingCode: async () => "CODE1234",
        groups: async () => [],
        send: send as never,
        downloadMedia: async () => Buffer.alloc(0),
        close: vi.fn(),
        logout: async () => undefined
      };
    })
  };
  const app = Fastify();
  const handle = registerLinkedWhatsAppRoutes(
    app,
    store,
    {
      WHATSAPP_LINKED_ENABLED: "true",
      WHATSAPP_LINKED_DAEMON_URL: "https://daemon.example",
      DAEMON_SERVICE_TOKEN: token,
      WHATSAPP_LINKED_SESSION_DIR: root,
      WHATSAPP_LINKED_SESSION_KEY: sessionKey
    },
    driver,
    { transcriber: null, ...(options.daemon ? { daemonClient: options.daemon } : {}) }
  ) as LinkedWhatsAppRoutesHandle;
  await app.ready();
  const close = async () => {
    await app.close();
    await main.close();
  };
  return { store, main, app, handle, send, callbacks, root, approvals, close };
}

async function linkedShop(options: Parameters<typeof setup>[0] = {}) {
  const host = await setup(options);
  const signup = await host.main.inject({
    method: "POST",
    url: "/auth/pin/signup",
    payload: { method: "phone", contact: "254700009881", pin: "1771" }
  });
  expect(signup.statusCode, signup.body).toBe(200);
  const header = signup.headers["set-cookie"];
  const cookie = (Array.isArray(header) ? header[0]! : header!).split(";")[0]!;
  const created = await host.main.inject({
    method: "POST",
    url: "/businesses",
    headers: { cookie },
    payload: { name: "WhatsApp result shop", language: "en" }
  });
  expect(created.statusCode, created.body).toBe(200);
  const businessId = created.json().business.id as string;
  const ownerId = host.store
    .snapshot()
    .memberships.find((entry) => entry.businessId === businessId && entry.role === "owner")!.userId;
  const headers = { cookie };
  const path = `/businesses/${businessId}/channels/whatsapp-linked`;
  await host.app.inject({
    method: "POST",
    url: `${path}/connect`,
    headers,
    payload: { phone: "254700000000", consent: true }
  });
  // A paired session: WhatsApp hands back credentials, which makes it restorable on restart.
  host.callbacks[0]!.save(JSON.stringify({ paired: true }));
  host.callbacks[0]!.state("open");
  const scoped = await host.app.inject({
    method: "POST",
    url: `${path}/scopes`,
    headers,
    payload: { chat, approved: true, automation: true }
  });
  expect(scoped.statusCode, scoped.body).toBe(200);
  const grantTools = async (tools: string[]) => {
    const response = await host.app.inject({
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
    await host.store.ingestLinkedWhatsAppMessage({
      businessId,
      ownerId,
      chat,
      sender: chat,
      id,
      text,
      timestamp: new Date().toISOString()
    });
    const prepared = await host.app.inject({
      method: "POST",
      url: "/internal/whatsapp-linked/turn",
      headers: { authorization: `Bearer ${token}` },
      payload: { businessId, ownerId, chat, sender: chat, messageId: id, grantId }
    });
    expect(prepared.statusCode, prepared.body).toBe(200);
    expect(prepared.json().text).toContain("owner's approval");
    const proposal = host.store
      .snapshot()
      .runtimeTurns.filter(
        (turn) => turn.status === "needs_confirmation" && turn.plan.channelDelegation
      )
      .at(-1)!;
    const card = host.store
      .snapshot()
      .conversationMessages.find(
        (message) => message.idempotencyKey === `whatsapp-approval:${proposal.id}`
      )!;
    return { proposal, conversationId: card.conversationId, providerMessageId: id };
  };
  type Api = typeof host.main;
  const approve = (proposal: RuntimeTurnSummary, conversationId: string, api: Api = host.main) =>
    api.inject({
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
  const reject = (proposal: RuntimeTurnSummary, conversationId: string, api: Api = host.main) =>
    api.inject({
      method: "POST",
      url: `/businesses/${businessId}/runtime/approvals/reject`,
      headers,
      payload: {
        runtimeSessionId: proposal.sessionId,
        conversationId,
        confirmationToken: proposal.plan.confirmationToken
      }
    });
  const resultMessages = (store: Cp2Store = host.store) =>
    store
      .snapshot()
      .conversationMessages.filter((message) =>
        message.idempotencyKey?.startsWith("whatsapp-result:")
      );
  const resultAudits = (store: Cp2Store = host.store) =>
    store
      .snapshot()
      .auditEvents.filter(
        (event) =>
          event.type.startsWith("whatsapp_linked.delegated_result") &&
          event.type !== "whatsapp_linked.delegated_result_queued"
      );
  /** The Edge API: same data, no WhatsApp connector, its own process memory. */
  const edge = () => {
    const edgeStore = createCp2Store({ runtimeApprovalStore: host.approvals });
    edgeStore.hydrateSnapshot(structuredClone(host.store.snapshot()));
    const api = buildApi({ cp2: { store: edgeStore } });
    (
      host.store as Cp2Store & { loadPendingLinkedDelegationResults?: () => Promise<unknown[]> }
    ).loadPendingLinkedDelegationResults = async () =>
      structuredClone(edgeStore.snapshot().whatsappLinkedDelegationResults ?? []);
    return { store: edgeStore, api };
  };
  const cleanup = async () => {
    await host.close();
    rmSync(host.root, { recursive: true, force: true });
  };
  return {
    ...host,
    headers,
    businessId,
    ownerId,
    requestWrite,
    approve,
    reject,
    edge,
    resultMessages,
    resultAudits,
    drain: () => host.handle.drainDelegationResults(),
    regrant: async (tools: string[]) => {
      grantId = await grantTools(tools);
      return grantId;
    },
    cleanup
  };
}

// Each case signs up an owner (PIN hashing) and drives full HTTP flows; allow for a loaded host.
describe("WhatsApp delegated action outcome after owner resolution", { timeout: 30_000 }, () => {
  it("sends exactly one quoted outcome to the originating chat when the owner approves", async () => {
    const f = await linkedShop();
    try {
      const { proposal, conversationId, providerMessageId } = await f.requestWrite();
      expect(f.send).not.toHaveBeenCalled();
      const accepted = await f.approve(proposal, conversationId);
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json().turn.status).toBe("completed");
      expect(f.store.snapshot().products).toHaveLength(1);
      await f.drain();
      await f.drain();
      expect(f.send).toHaveBeenCalledTimes(1);
      const [sentChat, sentText, , , quote] = f.send.mock.calls[0]!;
      expect(sentChat).toBe(chat);
      expect(sentText).toBe("Done: the new catalogue item was added.");
      // Threaded as a WhatsApp reply to the participant's original request.
      expect(quote).toMatchObject({ id: providerMessageId, fromMe: false });
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
        payload: { outcome: "executed", tool: "product.create", messageId: message!.id }
      });
      expect(f.store.linkedDelegationResultEntries(f.businessId)).toEqual([
        expect.objectContaining({
          id: `whatsapp-result:${proposal.id}`,
          status: "sent",
          messageId: message!.id,
          attempts: 0
        })
      ]);
    } finally {
      await f.cleanup();
    }
  });

  it("answers the owner's approval without waiting for the WhatsApp send", async () => {
    const f = await linkedShop();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      let release!: () => void;
      f.send.mockImplementationOnce(
        (_chat, _text, id) => new Promise((resolve) => (release = () => resolve(id)))
      );
      const accepted = await f.approve(proposal, conversationId);
      expect(accepted.statusCode, accepted.body).toBe(200);
      // The approval is answered while the send is still outstanding.
      await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
      expect(f.store.linkedDelegationResultEntries()[0]!.status).toBe("pending");
      release();
      await vi.waitFor(() =>
        expect(f.store.linkedDelegationResultEntries()[0]!.status).toBe("sent")
      );
    } finally {
      await f.cleanup();
    }
  });

  it("delivers an Edge-host approval exactly once from the Node connector host", async () => {
    const f = await linkedShop();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      const edge = f.edge();
      const accepted = await f.approve(proposal, conversationId, edge.api);
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json().turn.status).toBe("completed");
      // The Edge host has no connector: it records the outcome and sends nothing.
      expect(f.send).not.toHaveBeenCalled();
      expect(edge.store.linkedDelegationResultEntries()).toEqual([
        expect.objectContaining({ status: "pending", outcome: "executed", attempts: 0 })
      ]);
      expect(f.resultMessages(edge.store)).toHaveLength(0);
      expect(f.resultAudits(edge.store)).toHaveLength(0);
      // The Node host has not seen the entry until it reads shared storage.
      expect(f.store.linkedDelegationResultEntries()).toHaveLength(0);
      const report = await f.drain();
      expect(report).toMatchObject({ sent: 1, suppressed: 0, failed: 0 });
      // Shared storage still shows the stale pending row; the settled copy wins.
      await f.drain();
      await f.drain();
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.send.mock.calls[0]![1]).toBe("Done: the new catalogue item was added.");
      expect(f.store.linkedDelegationResultEntries()[0]).toMatchObject({ status: "sent" });
      expect(f.resultMessages()).toHaveLength(1);
      await edge.api.close();
    } finally {
      await f.cleanup();
    }
  });

  it("tells the chat the owner declined when the owner rejects", async () => {
    const f = await linkedShop();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      const rejected = await f.reject(proposal, conversationId);
      expect(rejected.statusCode, rejected.body).toBe(200);
      expect(rejected.json()).toEqual({ status: "REJECTED" });
      await f.drain();
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
      await f.cleanup();
    }
  });

  it("queues the outcome for the owner's phone when the phone hosts the session (Edge)", async () => {
    const f = await linkedShop();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      // The owner resolves on Edge, and their phone, not a server, now hosts the session.
      const edge = f.edge();
      const rejected = await f.reject(proposal, conversationId, edge.api);
      expect(rejected.statusCode, rejected.body).toBe(200);
      edge.store.recordLinkedWhatsAppDeviceState({
        businessId: f.businessId,
        ownerId: f.ownerId,
        state: "CONNECTED"
      });
      const sessionId = f.headers.cookie.split("=")[1]!;
      const pulled = await edge.store.pullLinkedWhatsAppDeviceOutbox({
        sessionId,
        businessId: f.businessId,
        ownerId: f.ownerId
      });
      expect(pulled.sends).toEqual([
        expect.objectContaining({
          chat,
          idempotencyKey: `whatsapp-result:${proposal.id}`,
          text: "The shop owner declined this request."
        })
      ]);
      expect(f.resultAudits(edge.store)[0]).toMatchObject({
        type: "whatsapp_linked.delegated_result_sent"
      });
      // Pulling again hands out nothing new, and the server connector never sent it.
      expect(
        (
          await edge.store.pullLinkedWhatsAppDeviceOutbox({
            sessionId,
            businessId: f.businessId,
            ownerId: f.ownerId
          })
        ).sends
      ).toEqual([]);
      expect(f.send).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it("sends nothing and audits why when the grant is revoked before approval", async () => {
    const f = await linkedShop();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      await f.regrant([]);
      const denied = await f.approve(proposal, conversationId);
      // Execution re-checks the grant, so the approved write is blocked rather than run.
      expect(denied.statusCode, denied.body).toBe(200);
      expect(denied.json().turn.status).toBe("blocked");
      await f.drain();
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
      await f.cleanup();
    }
  });

  it("suppresses a queued result when the grant is revoked between approval and drain", async () => {
    const f = await linkedShop();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      const edge = f.edge();
      expect((await f.approve(proposal, conversationId, edge.api)).statusCode).toBe(200);
      // Re-granting the same tools issues a new grant id: the original authority is gone.
      await f.regrant(["products.list", "product.create"]);
      expect(await f.drain()).toMatchObject({ sent: 0, suppressed: 1 });
      expect(f.send).not.toHaveBeenCalled();
      expect(f.resultMessages()).toHaveLength(0);
      expect(f.resultAudits()).toEqual([
        expect.objectContaining({
          type: "whatsapp_linked.delegated_result_suppressed",
          payload: expect.objectContaining({
            reason: "whatsapp_tool_grant_revoked",
            outcome: "executed"
          })
        })
      ]);
      // Settled: later passes neither send nor audit again.
      await f.drain();
      expect(f.send).not.toHaveBeenCalled();
      expect(f.resultAudits()).toHaveLength(1);
      await edge.api.close();
    } finally {
      await f.cleanup();
    }
  });

  it("honours a STOP that arrives between approval and drain", async () => {
    const f = await linkedShop();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      const edge = f.edge();
      expect((await f.reject(proposal, conversationId, edge.api)).statusCode).toBe(200);
      await f.store.ingestLinkedWhatsAppMessage({
        businessId: f.businessId,
        ownerId: f.ownerId,
        chat,
        sender: chat,
        id: "stop",
        text: "STOP",
        timestamp: new Date().toISOString()
      });
      expect(await f.drain()).toMatchObject({ suppressed: 1 });
      expect(f.send).not.toHaveBeenCalled();
      expect(f.resultAudits()).toEqual([
        expect.objectContaining({
          type: "whatsapp_linked.delegated_result_suppressed",
          payload: expect.objectContaining({ reason: "recipient_opted_out" })
        })
      ]);
      await edge.api.close();
    } finally {
      await f.cleanup();
    }
  });

  it("suppresses a queued result when the conversation approval is withdrawn", async () => {
    const f = await linkedShop();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      const edge = f.edge();
      expect((await f.approve(proposal, conversationId, edge.api)).statusCode).toBe(200);
      const revoked = await f.app.inject({
        method: "POST",
        url: `/businesses/${f.businessId}/channels/whatsapp-linked/scopes`,
        headers: f.headers,
        payload: { chat, approved: false }
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect(await f.drain()).toMatchObject({ sent: 0, suppressed: 1 });
      expect(f.send).not.toHaveBeenCalled();
      await edge.api.close();
    } finally {
      await f.cleanup();
    }
  });

  it("never sends a second WhatsApp message after a crash between send and settle", async () => {
    const f = await linkedShop();
    let restarted: Awaited<ReturnType<typeof setup>> | undefined;
    try {
      const { proposal, conversationId } = await f.requestWrite();
      // What durable storage holds right after the approval recorded the entry: pending, and no
      // result message yet. A crash after the send loses everything after this point.
      let recorded: Cp2Snapshot | undefined;
      f.store.onLinkedDelegationResultQueued(() => (recorded = f.store.snapshot()));
      expect((await f.approve(proposal, conversationId)).statusCode).toBe(200);
      await f.drain();
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(recorded!.whatsappLinkedDelegationResults).toEqual([
        expect.objectContaining({ status: "pending" })
      ]);
      expect(
        recorded!.conversationMessages.some((message) =>
          message.idempotencyKey.startsWith("whatsapp-result:")
        )
      ).toBe(false);
      await f.close();
      // Restart on the same encrypted session volume with the pre-send canonical state.
      restarted = await setup({ root: f.root, snapshot: recorded! });
      await vi.waitFor(() => expect(restarted!.callbacks).toHaveLength(1));
      restarted.callbacks[0]!.state("open");
      await vi.waitFor(() =>
        expect(restarted!.store.linkedDelegationResultEntries()[0]!.status).not.toBe("pending")
      );
      await restarted.handle.drainDelegationResults();
      // The connector's delivery journal recognises the key: WhatsApp is not called again.
      expect(restarted.send).not.toHaveBeenCalled();
      expect(restarted.store.linkedDelegationResultEntries()[0]).toMatchObject({ status: "sent" });
    } finally {
      await restarted?.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("redelivers once after a crash before the send reached WhatsApp", async () => {
    const f = await linkedShop();
    let restarted: Awaited<ReturnType<typeof setup>> | undefined;
    try {
      const { proposal, conversationId } = await f.requestWrite();
      const edge = f.edge();
      expect((await f.approve(proposal, conversationId, edge.api)).statusCode).toBe(200);
      await edge.api.close();
      // The Node host dies before its next drain: nothing was sent.
      const durable = f.store.snapshot();
      durable.whatsappLinkedDelegationResults =
        edge.store.snapshot().whatsappLinkedDelegationResults ?? [];
      await f.close();
      expect(f.send).not.toHaveBeenCalled();
      restarted = await setup({ root: f.root, snapshot: durable });
      await vi.waitFor(() => expect(restarted!.callbacks).toHaveLength(1));
      restarted.callbacks[0]!.state("open");
      await vi.waitFor(() => expect(restarted!.send).toHaveBeenCalledTimes(1));
      await restarted.handle.drainDelegationResults();
      await restarted.handle.drainDelegationResults();
      expect(restarted.send).toHaveBeenCalledTimes(1);
      expect(restarted.store.linkedDelegationResultEntries()[0]).toMatchObject({ status: "sent" });
    } finally {
      await restarted?.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("never sends a duplicate when the same approval is resolved again", async () => {
    const f = await linkedShop();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      expect((await f.approve(proposal, conversationId)).statusCode).toBe(200);
      expect([403, 404]).toContain((await f.approve(proposal, conversationId)).statusCode);
      expect([403, 404]).toContain((await f.reject(proposal, conversationId)).statusCode);
      await f.drain();
      expect(f.send).toHaveBeenCalledTimes(1);
      // A replayed resolution for the same originating turn is absorbed by the idempotency key.
      await f.store.deliverLinkedDelegationResult({
        businessId: f.businessId,
        turnId: proposal.id,
        delegation: proposal.plan.channelDelegation!,
        toolName: "product.create",
        outcome: "rejected",
        resolvedBy: f.ownerId
      });
      await f.drain();
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.resultMessages()).toHaveLength(1);
      expect(f.store.linkedDelegationResultEntries()).toEqual([
        expect.objectContaining({ outcome: "executed", status: "sent" })
      ]);
    } finally {
      await f.cleanup();
    }
  });

  it("waits while the connector is offline and sends once it reconnects", async () => {
    const f = await linkedShop();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      f.callbacks[0]!.state("close", "restart");
      expect((await f.approve(proposal, conversationId)).statusCode).toBe(200);
      expect(await f.drain()).toMatchObject({ sent: 0, deferred: 0 });
      expect(f.store.linkedDelegationResultEntries()[0]).toMatchObject({
        status: "pending",
        attempts: 0
      });
      expect(f.send).not.toHaveBeenCalled();
      // The connector reopens on its own backoff timer; reconnecting drains the outbox.
      await vi.waitFor(() => expect(f.callbacks).toHaveLength(2), { timeout: 5000 });
      f.callbacks[1]!.state("open");
      await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(f.store.linkedDelegationResultEntries()[0]!.status).toBe("sent")
      );
    } finally {
      await f.cleanup();
    }
  });

  it("leaves owner-originated (non-delegated) approvals untouched", async () => {
    const f = await linkedShop();
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
      await f.drain();
      expect(f.send).not.toHaveBeenCalled();
      expect(f.store.linkedDelegationResultEntries()).toHaveLength(0);
      expect(conversationId).toBeTruthy();
    } finally {
      await f.cleanup();
    }
  });
});

describe("delegated result retries", { timeout: 30_000 }, () => {
  it("backs off while nothing reached WhatsApp, then settles as failed", async () => {
    const f = await linkedShop();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      f.callbacks[0]!.state("close", "revoked");
      expect((await f.approve(proposal, conversationId)).statusCode).toBe(200);
      // Force passes the connector would refuse (it is unavailable): the gateway rejects the send
      // before any message exists, so each pass is a retry, never a send.
      let now = Date.now();
      const delays: number[] = [];
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        const report = await f.store.drainLinkedDelegationResults({
          ready: () => true,
          now: () => new Date(now)
        });
        const [entry] = f.store.linkedDelegationResultEntries();
        if (attempt < 6) {
          expect(report).toMatchObject({ deferred: 1 });
          expect(entry).toMatchObject({ status: "pending", attempts: attempt });
          delays.push(Date.parse(entry!.nextAttemptAt) - now);
          // Not due yet: a pass in between does nothing.
          expect(
            await f.store.drainLinkedDelegationResults({
              ready: () => true,
              now: () => new Date(now + 1000)
            })
          ).toMatchObject({ deferred: 0, failed: 0 });
          now = Date.parse(entry!.nextAttemptAt);
        } else {
          expect(report).toMatchObject({ failed: 1 });
          expect(entry).toMatchObject({
            status: "failed",
            reason: "retries_exhausted",
            attempts: 6
          });
        }
      }
      expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
      expect(f.send).not.toHaveBeenCalled();
      expect(f.resultMessages()).toHaveLength(0);
      expect(f.resultAudits()).toEqual([
        expect.objectContaining({
          type: "whatsapp_linked.delegated_result_failed",
          payload: expect.objectContaining({ reason: "retries_exhausted" })
        })
      ]);
    } finally {
      await f.cleanup();
    }
  });

  it("never retries a send whose outcome is uncertain", async () => {
    const f = await linkedShop();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      f.send.mockRejectedValueOnce(new Error("socket reset mid-send"));
      expect((await f.approve(proposal, conversationId)).statusCode).toBe(200);
      await f.drain();
      expect(f.store.linkedDelegationResultEntries()[0]).toMatchObject({
        status: "failed",
        reason: "delivery_failed"
      });
      await f.drain();
      await f.store.drainLinkedDelegationResults({
        ready: () => true,
        now: () => new Date(Date.now() + 3_600_000)
      });
      expect(f.send).toHaveBeenCalledTimes(1);
    } finally {
      await f.cleanup();
    }
  });

  it("settles a result that waited a day as failed instead of sending it late", async () => {
    const f = await linkedShop();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      f.callbacks[0]!.state("close", "revoked");
      expect((await f.approve(proposal, conversationId)).statusCode).toBe(200);
      const created = Date.parse(f.store.linkedDelegationResultEntries()[0]!.createdAt);
      expect(
        await f.store.drainLinkedDelegationResults({
          ready: () => true,
          now: () => new Date(created + 24 * 3_600_000)
        })
      ).toMatchObject({ failed: 1 });
      expect(f.store.linkedDelegationResultEntries()[0]).toMatchObject({
        status: "failed",
        reason: "expired"
      });
      // Settled entries are pruned after the retention window.
      await f.store.drainLinkedDelegationResults({
        ready: () => true,
        now: () => new Date(created + 9 * 24 * 3_600_000)
      });
      expect(f.store.linkedDelegationResultEntries()).toHaveLength(0);
      expect(f.send).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });
});

describe("delegated result drain configuration", () => {
  it("rejects an invalid drain interval before locking the session volume", async () => {
    const root = mkdtempSync(join(tmpdir(), "wa-result-config-"));
    const environment = {
      WHATSAPP_LINKED_ENABLED: "true",
      WHATSAPP_LINKED_SESSION_DIR: root,
      WHATSAPP_LINKED_SESSION_KEY: sessionKey
    };
    const driver: LinkedDriver = { open: vi.fn() };
    try {
      expect(() =>
        registerLinkedWhatsAppRoutes(
          Fastify(),
          createCp2Store(),
          { ...environment, WHATSAPP_LINKED_RESULT_DRAIN_MS: "10" },
          driver
        )
      ).toThrow("WHATSAPP_LINKED_RESULT_DRAIN_MS");
      // The volume was not left locked: a correctly configured host starts on it.
      const app = Fastify();
      expect(
        registerLinkedWhatsAppRoutes(app, createCp2Store(), environment, driver)
      ).toBeDefined();
      await app.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("delegated results share the 60/hour automatic-reply cap", { timeout: 60_000 }, () => {
  /** Spend the business's whole automatic budget on assistant replies. */
  async function exhaust(f: Awaited<ReturnType<typeof linkedShop>>) {
    for (let index = 0; index < 60; index += 1)
      await f.store.deliverLinkedWhatsAppReply({
        businessId: f.businessId,
        ownerId: f.ownerId,
        chat,
        text: `Assistant reply ${index}`,
        idempotencyKey: `whatsapp-reply:${index.toString(16).padStart(64, "0")}`
      });
    f.send.mockClear();
  }

  it("leaves a result pending while the budget is spent and sends it when a slot frees", async () => {
    const f = await linkedShop();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      await exhaust(f);
      expect((await f.approve(proposal, conversationId)).statusCode).toBe(200);
      expect(await f.drain()).toMatchObject({ sent: 0, deferred: 1 });
      expect(f.send).not.toHaveBeenCalled();
      const [waiting] = f.store.linkedDelegationResultEntries();
      expect(waiting).toMatchObject({ status: "pending", attempts: 0 });
      // It waits exactly until the oldest automatic send leaves the rolling hour.
      const oldest = Math.min(
        ...f.store
          .snapshot()
          .conversationMessages.filter((message) =>
            message.idempotencyKey.startsWith("whatsapp-reply:")
          )
          .map((message) => Date.parse(message.createdAt))
      );
      expect(Date.parse(waiting!.nextAttemptAt)).toBe(oldest + 3_600_000);
      // Not due yet: another pass does nothing.
      expect(await f.drain()).toMatchObject({ sent: 0, deferred: 0 });
      const later = new Date(oldest + 3_600_001);
      const report = await f.store.drainLinkedDelegationResults({
        ready: () => true,
        now: () => later
      });
      expect(report).toMatchObject({ sent: 1 });
      expect(f.send).toHaveBeenCalledTimes(1);
    } finally {
      await f.cleanup();
    }
  });

  it("refuses an assistant reply once delegated results used the last slots", async () => {
    const reply = vi.fn(async () => "Assistant answer");
    const f = await linkedShop({ daemon: { reply } });
    try {
      const inbound = (id: string) =>
        f.callbacks[0]!.inbound({
          id,
          chat,
          sender: chat,
          text: "Do you have milk?",
          timestamp: new Date().toISOString(),
          fromMe: false,
          mentioned: false
        });
      // Control: with budget left, the assistant answers.
      inbound("question-1");
      await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
      expect(reply).toHaveBeenCalledTimes(1);
      // 59 delegated-style automatic sends fill the rest of the hour's budget.
      for (let index = 0; index < 59; index += 1)
        await f.store.deliverLinkedWhatsAppReply({
          businessId: f.businessId,
          ownerId: f.ownerId,
          chat,
          text: "Done: your request was completed.",
          idempotencyKey: `whatsapp-result:filler-${index}`
        });
      f.send.mockClear();
      inbound("question-2");
      await vi.waitFor(() =>
        expect(
          f.store
            .snapshot()
            .conversationMessages.some((message) => message.providerMessageId === "question-2")
        ).toBe(true)
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The connector admitted it under its own count, but the shared budget refuses it.
      expect(reply).toHaveBeenCalledTimes(1);
      expect(f.send).not.toHaveBeenCalled();
      const now = Date.now();
      expect(f.store.admitLinkedAutomatedReply(f.businessId, "whatsapp-reply:new", now)).toEqual({
        admitted: false,
        retryAt: expect.any(Number)
      });
      // A key already counted inside the window is never charged twice.
      expect(
        f.store.admitLinkedAutomatedReply(f.businessId, "whatsapp-result:filler-0", now)
      ).toEqual({ admitted: true });
      // Other businesses keep their own budget.
      expect(f.store.admitLinkedAutomatedReply("other-business", "whatsapp-reply:x", now)).toEqual({
        admitted: true
      });
    } finally {
      await f.cleanup();
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

  it("never throws into the owner's resolution and audits a recording failure", async () => {
    const recordAuditEvent = vi.fn();
    const deliverChannelDelegationResult = vi.fn(async () => {
      throw new Error("storage unavailable");
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

describe("a WhatsApp delegation can never approve its own action", { timeout: 30_000 }, () => {
  it("refuses a delegated turn that carries a confirmation token and leaves the approval to the owner", async () => {
    const f = await linkedShop();
    try {
      const { proposal, conversationId } = await f.requestWrite();
      const token = proposal.plan.confirmationToken!;
      expect(token).toBeTruthy();
      // A fresh participant message, so the request is a new delegated turn rather than a replay.
      await f.store.ingestLinkedWhatsAppMessage({
        businessId: f.businessId,
        ownerId: f.ownerId,
        chat,
        sender: chat,
        id: "self-approval",
        text: "confirm",
        timestamp: new Date().toISOString()
      });
      const source = f.store
        .snapshot()
        .conversationMessages.find((message) => message.providerMessageId === "self-approval")!;
      const owner = f.store.snapshot().users.find((user) => user.id === f.ownerId)!;
      const principal = {
        tokenId: `whatsapp:${proposal.plan.channelDelegation!.grantId}`,
        accountId: owner.accountId,
        userId: owner.id,
        scopes: ["mcp:read", "mcp:act"] satisfies McpAccessScope[],
        shopId: f.businessId,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      };
      const delegation = { ...proposal.plan.channelDelegation!, sourceMessageId: source.id };
      const attempt = (confirmationToken?: string) =>
        f.store.createRuntimeTurnForMcp({
          principal,
          businessId: f.businessId,
          conversationId,
          runtimeSessionId: proposal.sessionId,
          message: "confirm",
          channelDelegation: delegation,
          ...(confirmationToken ? { confirmationToken } : {})
        });
      await expect(attempt(token)).rejects.toMatchObject({
        statusCode: 403,
        code: "channel_grant_invalid",
        message: "WhatsApp requests cannot approve business actions."
      });
      // Nothing ran, and the owner's pending approval was not consumed.
      expect(f.store.snapshot().products).toHaveLength(0);
      // The token is what is refused: the same delegation without one passes this check.
      const plain = await attempt().then(
        () => null,
        (error: unknown) => error
      );
      expect(plain).not.toMatchObject({ code: "channel_grant_invalid" });
      const approved = await f.approve(proposal, conversationId);
      expect(approved.statusCode, approved.body).toBe(200);
      expect(approved.json().turn.status).toBe("completed");
      expect(f.store.snapshot().products).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });
});
