import Fastify from "../services/api/node_modules/fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "../services/api/node_modules/pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app.js";
import { createCp2Store } from "../services/api/src/cp2/store.js";
import { createMemoryConversationAttachmentBlobStore } from "../services/api/src/cp2/conversation-attachment-blob-store.js";
import { buildDaemonGateway } from "../services/api/src/daemon/gateway.js";
import {
  createDaemonExecutor,
  readDaemonCapabilities
} from "../services/api/src/daemon/executor.js";
import { runDaemonWorker } from "../services/api/src/daemon/worker.js";
import {
  createPostgresDaemonTaskStore,
  daemonQueueMigrations
} from "../services/api/src/daemon/task-store.js";
import { LinkedDaemonClient } from "../services/api/src/messaging/whatsapp-linked/daemon-client.js";
import { registerLinkedWhatsAppRoutes } from "../services/api/src/messaging/whatsapp-linked/routes.js";
import type {
  LinkedDriver,
  LinkedInbound
} from "../services/api/src/messaging/whatsapp-linked/connector.js";

/**
 * The whole assistant-reply bridge with nothing but the edges mocked: a fake WhatsApp socket on
 * one side, a stubbed OpenRouter HTTP endpoint on the other. Between them everything is real:
 * the connector's automation decision and admission cap, the routes' respond/deliver bridge, the
 * LinkedDaemonClient, the Daemon gateway, the PostgreSQL task queue, the worker, the executor
 * with the Grogoni engine, and the canonical inbox and outbound delivery journal.
 */
const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const token = "d".repeat(32);
const openRouterUrl = "https://openrouter.ai/api/v1/chat/completions";
const reply = "Karibu! The owner will confirm stock and price shortly.";

describe.skipIf(!url)("WhatsApp Linked Devices assistant replies through the Daemon", () => {
  const schema = `wa_linked_e2e_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url ?? "" });
  const pool = new pg.Pool({ connectionString: url ?? "", options: `-c search_path=${schema}` });
  const tasks = createPostgresDaemonTaskStore(pool);
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    for (const file of daemonQueueMigrations)
      await pool.query(
        await readFile(new URL(`../infra/db/migrations/${file}`, import.meta.url), "utf8")
      );
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  });

  async function setup(
    options: {
      model?: (body: Record<string, unknown>) => Response;
      gatewayDown?: boolean;
    } = {}
  ) {
    await pool.query("truncate grogoni_daemon_tasks");
    // OpenRouter is the only network edge the executor touches; anything else is a test bug.
    const modelRequests: Array<Record<string, unknown>> = [];
    const model = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) !== openRouterUrl) throw new Error(`Unexpected network call: ${input}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      modelRequests.push(body);
      return (
        options.model?.(body) ??
        Response.json({
          model: "openai/gpt-6-luna",
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify({ type: "response", message: reply }) }
            }
          ],
          usage: { prompt_tokens: 40, completion_tokens: 12 }
        })
      );
    });
    vi.stubGlobal("fetch", model);

    const daemonEnvironment = { OPENROUTER_API_KEY: "test-only", DAEMON_SERVICE_TOKEN: token };
    const gateway = buildDaemonGateway({
      store: tasks,
      token,
      ready: () => true,
      defaults: { modelId: "gpt-6-luna", agentAdapterId: "grogoni" },
      refusal: readDaemonCapabilities(daemonEnvironment, "gpt-6-luna").refusal
    });
    await gateway.ready();
    const stopWorker = new AbortController();
    const worker = runDaemonWorker({
      store: tasks,
      execute: createDaemonExecutor(daemonEnvironment),
      signal: stopWorker.signal,
      pollMs: 5
    });
    cleanups.push(async () => {
      stopWorker.abort();
      await worker;
      await gateway.close();
    });

    // The client's only transport: Fastify inject into the in-process gateway, no sockets.
    const daemonCalls: string[] = [];
    const daemonFetcher: typeof fetch = async (input, init) => {
      const target = new URL(String(input));
      daemonCalls.push(`${init?.method ?? "GET"} ${target.pathname}`);
      if (options.gatewayDown) return new Response("unavailable", { status: 503 });
      const response = await gateway.inject({
        method: (init?.method ?? "GET") as "GET" | "POST",
        url: target.pathname,
        headers: init?.headers as Record<string, string>,
        ...(init?.body ? { payload: String(init.body) } : {})
      });
      return new Response(response.rawPayload, {
        status: response.statusCode,
        headers: { "content-type": "application/json" }
      });
    };
    const daemonClient = new LinkedDaemonClient({
      url: "https://daemon.test",
      token,
      fetcher: daemonFetcher,
      pollMs: 5,
      timeoutMs: 20_000
    });

    const root = mkdtempSync(join(tmpdir(), "wa-daemon-e2e-"));
    const store = createCp2Store({
      conversationAttachmentBlobStore: createMemoryConversationAttachmentBlobStore()
    });
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
      payload: { name: "Daemon reply shop", language: "en" }
    });
    expect(created.statusCode, created.body).toBe(200);
    const businessId = created.json().business.id as string;
    const ownerId = store
      .snapshot()
      .memberships.find(
        (entry) => entry.businessId === businessId && entry.role === "owner"
      )!.userId;

    const callbacks: Parameters<LinkedDriver["open"]>[0][] = [];
    const send = vi.fn(async (_chat: string, _text: string, id: string) => id);
    const driver: LinkedDriver = {
      open: vi.fn(async (input) => {
        callbacks.push(input);
        return {
          pairingCode: async () => "CODE1234",
          groups: async () => [{ chat: "123456789@g.us", name: "Approved test group" }],
          send,
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
        WHATSAPP_LINKED_SESSION_DIR: root,
        WHATSAPP_LINKED_SESSION_KEY: "02".repeat(32)
      },
      driver,
      { daemonClient }
    );
    await app.ready();
    cleanups.push(async () => {
      await app.close();
      await main.close();
      rmSync(root, { recursive: true, force: true });
    });

    const path = `/businesses/${businessId}/channels/whatsapp-linked`;
    const connected = await app.inject({
      method: "POST",
      url: `${path}/connect`,
      headers: { cookie },
      payload: { phone: "254700000000", consent: true }
    });
    expect(connected.statusCode, connected.body).toBe(200);
    callbacks[0]!.state("open");
    const approve = async (chat: string) => {
      const approved = await app.inject({
        method: "POST",
        url: `${path}/scopes`,
        headers: { cookie },
        payload: { chat, approved: true, automation: true }
      });
      expect(approved.statusCode, approved.body).toBe(200);
      expect(approved.json().scopes.find((s: { chat: string }) => s.chat === chat).automation).toBe(
        true
      );
    };
    const inbound = (message: Partial<LinkedInbound> & { id: string; chat: string }) =>
      callbacks[0]!.inbound({
        sender: message.chat,
        text: "Do you have maize flour?",
        timestamp: new Date().toISOString(),
        fromMe: false,
        mentioned: false,
        ...message
      });
    const canonical = (id: string) =>
      store.snapshot().conversationMessages.find((entry) => entry.providerMessageId === id);
    const queued = async () =>
      (
        await pool.query<{ status: string; error_code: string | null; owner_user_id: string }>(
          "select status, error_code, owner_user_id::text from grogoni_daemon_tasks order by created_at"
        )
      ).rows;
    const status = async () =>
      (await app.inject({ url: path, headers: { cookie } })).json() as { state: string };
    return {
      store,
      ownerId,
      send,
      model,
      modelRequests,
      daemonCalls,
      approve,
      inbound,
      canonical,
      queued,
      status
    };
  }
  /** Lets every in-flight drain, poll and worker cycle finish before a negative assertion. */
  const quiesce = () => new Promise<void>((resolve) => setTimeout(resolve, 150));
  const contact = "254711111111@s.whatsapp.net";

  it("delivers the Luna reply from a Daemon owner task to the socket exactly once", async () => {
    const f = await setup();
    await f.approve(contact);
    f.inbound({ id: "maize-question", chat: contact });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(f.send).toHaveBeenCalledWith(contact, reply, expect.any(String), undefined, undefined);

    // The OpenRouter request names Luna and carries no tools for a WhatsApp contact.
    expect(f.modelRequests).toHaveLength(1);
    expect(f.modelRequests[0]!.model).toBe("openai/gpt-6-luna");
    expect(f.modelRequests[0]!.tools).toBeUndefined();
    expect(JSON.stringify(f.modelRequests[0]!.messages)).toContain("Do you have maize flour?");

    // One immediate owner task, run by the server lane of the real queue.
    expect(await f.queued()).toEqual([
      { status: "completed", error_code: null, owner_user_id: f.ownerId }
    ]);
    expect(f.daemonCalls[0]).toBe("POST /v1/tasks");
    expect(
      f.daemonCalls.slice(1).every((call) => /^GET \/v1\/tasks\/[0-9a-f-]{36}$/.test(call))
    ).toBe(true);

    // Canonical inbox holds the inbound message and the agent-authored reply.
    expect(f.canonical("maize-question")?.content).toMatchObject({
      type: "text",
      text: "Do you have maize flour?"
    });
    const outbound = f.store
      .snapshot()
      .conversationMessages.filter((entry) => entry.author === "agent");
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.content).toMatchObject({ text: reply });

    // A provider redelivery of the same event neither re-runs the model nor re-sends.
    f.inbound({ id: "maize-question", chat: contact });
    await quiesce();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.model).toHaveBeenCalledTimes(1);
    expect(await f.queued()).toHaveLength(1);
  }, 20_000);

  it("suppresses replies after STOP while still ingesting the conversation", async () => {
    const f = await setup();
    await f.approve(contact);
    f.inbound({ id: "opt-out", chat: contact, text: "STOP" });
    await vi.waitFor(() => expect(f.canonical("opt-out")).toBeDefined());
    f.inbound({ id: "after-opt-out", chat: contact, text: "Still selling maize?" });
    await vi.waitFor(() => expect(f.canonical("after-opt-out")).toBeDefined());
    await quiesce();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.model).not.toHaveBeenCalled();
    expect(f.daemonCalls).toEqual([]);
    expect(await f.queued()).toEqual([]);
    expect((await f.status()).state).toBe("CONNECTED");
  }, 20_000);

  it("ignores an unmentioned group message and answers only an explicit mention", async () => {
    const f = await setup();
    const group = "123456789@g.us";
    await f.approve(group);
    f.inbound({ id: "group-chatter", chat: group, sender: contact, text: "Who has maize?" });
    await vi.waitFor(() => expect(f.canonical("group-chatter")).toBeDefined());
    await quiesce();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.daemonCalls).toEqual([]);
    expect(await f.queued()).toEqual([]);

    // Control: the same group does trigger once the assistant is mentioned.
    f.inbound({ id: "group-mention", chat: group, sender: contact, mentioned: true });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(f.send).toHaveBeenCalledWith(group, reply, expect.any(String), undefined, undefined);
    expect(f.modelRequests).toHaveLength(1);
  }, 20_000);

  it("admits at most 60 assistant replies per hour and still ingests the 61st message", async () => {
    const f = await setup();
    await f.approve(contact);
    for (let index = 0; index < 61; index += 1)
      f.inbound({ id: `burst-${index}`, chat: contact, text: `Question ${index}` });
    await vi.waitFor(() => expect(f.canonical("burst-60")).toBeDefined(), { timeout: 60_000 });
    await quiesce();
    expect(f.send).toHaveBeenCalledTimes(60);
    expect(f.model).toHaveBeenCalledTimes(60);
    const rows = await f.queued();
    expect(rows).toHaveLength(60);
    expect(rows.every((row) => row.status === "completed")).toBe(true);
    // The over-cap message never reached the model.
    expect(JSON.stringify(f.modelRequests)).not.toContain("Question 60");
    expect(JSON.stringify(f.modelRequests)).toContain("Question 59");
  }, 90_000);

  it("keeps canonical ingestion and sends nothing when the Daemon task fails", async () => {
    const f = await setup({ model: () => new Response("denied", { status: 401 }) });
    await f.approve(contact);
    f.inbound({ id: "model-fails", chat: contact });
    await vi.waitFor(async () => expect((await f.queued())[0]?.status).toBe("failed"), {
      timeout: 10_000
    });
    await quiesce();
    expect((await f.queued())[0]).toMatchObject({ error_code: "PROVIDER_AUTH_FAILED" });
    expect(f.model).toHaveBeenCalledTimes(1);
    expect(f.canonical("model-fails")).toBeDefined();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.store.snapshot().conversationMessages.some((m) => m.author === "agent")).toBe(false);
    // A failed task is a clean "no reply": the connection stays up for the next message.
    expect((await f.status()).state).toBe("CONNECTED");
  }, 20_000);

  it("keeps canonical ingestion and sends nothing when the Daemon gateway is unavailable", async () => {
    const f = await setup({ gatewayDown: true });
    await f.approve(contact);
    f.inbound({ id: "gateway-down", chat: contact });
    await vi.waitFor(() => expect(f.daemonCalls).toEqual(["POST /v1/tasks"]));
    await vi.waitFor(async () => expect((await f.status()).state).toBe("RECONNECTING"));
    expect(f.canonical("gateway-down")).toBeDefined();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.model).not.toHaveBeenCalled();
    expect(await f.queued()).toEqual([]);
  }, 20_000);
});
