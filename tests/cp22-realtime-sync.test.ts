import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { SyncRealtimeChangesAvailableEvent, SyncRealtimeEvent } from "@grogoni/shared-types";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

interface SessionResponse {
  account: { id: string };
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("CP22 realtime sync", () => {
  it("rejects unauthenticated and untrusted-origin upgrades", async () => {
    const app = trackedApi();
    await app.ready();
    await expect(app.injectWS("/v1/realtime")).rejects.toThrow(/401/);

    const owner = await createSession(app, "254700000221");
    await expect(
      app.injectWS("/v1/realtime", {
        headers: { cookie: owner.cookie, origin: "https://attacker.invalid" }
      })
    ).rejects.toThrow(/403/);
  });

  it("delivers change hints only to the authenticated account", async () => {
    const app = trackedApi();
    await app.ready();
    const owner = await createSession(app, "254700000222");
    const stranger = await createSession(app, "254700000223");
    const ownerConnection = await connectRealtime(app, owner.cookie);
    const strangerConnection = await connectRealtime(app, stranger.cookie);
    const ownerSocket = ownerConnection.socket;
    const strangerSocket = strangerConnection.socket;

    const ownerReady = await ownerConnection.ready;
    const strangerReady = await strangerConnection.ready;
    expect(ownerReady).toMatchObject({
      type: "realtime.ready",
      protocolVersion: 1,
      accountId: owner.accountId
    });
    expect(strangerReady).toMatchObject({
      type: "realtime.ready",
      accountId: stranger.accountId
    });

    const strangerEvents: SyncRealtimeEvent[] = [];
    strangerSocket.on("message", (data) => strangerEvents.push(JSON.parse(data.toString())));
    const ownerChangePromise = nextEvent(ownerSocket);
    await postJson(app, "/businesses", { name: "Realtime Shop", language: "en" }, owner.cookie);
    const ownerChange = await ownerChangePromise;

    expect(ownerChange).toMatchObject({
      type: "sync.changes_available",
      protocolVersion: 1,
      accountId: owner.accountId,
      collection: "shops"
    });
    expect(typeof ownerChange.cursor).toBe("string");
    expect(typeof ownerChange.sequence).toBe("number");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(strangerEvents).toEqual([]);

    ownerSocket.close();
    strangerSocket.close();
  });

  it("forwards externally published durable hints to local account subscribers", async () => {
    const store = createCp2Store();
    const app = trackedApi(store);
    await app.ready();
    const owner = await createSession(app, "254700000224");
    const connection = await connectRealtime(app, owner.cookie);
    await connection.ready;
    const event: SyncRealtimeChangesAvailableEvent = {
      type: "sync.changes_available",
      protocolVersion: 1,
      accountId: owner.accountId,
      cursor: crypto.randomUUID(),
      sequence: 42,
      collection: "conversation_messages",
      emittedAt: new Date().toISOString()
    };
    const received = nextEvent(connection.socket);

    store.publishExternalSyncChange(event);

    await expect(received).resolves.toEqual(event);
    connection.socket.close();
  });
});

function trackedApi(store = createCp2Store()): FastifyInstance {
  const app = buildApi({ cp2: { store } });
  apps.push(app);
  return app;
}

function nextEvent(socket: WebSocket): Promise<SyncRealtimeEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for realtime event.")),
      500
    );
    socket.once("message", (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()) as SyncRealtimeEvent);
    });
  });
}

async function connectRealtime(
  app: FastifyInstance,
  cookie: string
): Promise<{ socket: WebSocket; ready: Promise<SyncRealtimeEvent> }> {
  let resolveReady: (event: SyncRealtimeEvent) => void = () => undefined;
  const ready = new Promise<SyncRealtimeEvent>((resolve) => {
    resolveReady = resolve;
  });
  const socket = await app.injectWS(
    "/v1/realtime",
    { headers: { cookie, origin: "http://localhost:5173" } },
    {
      onInit: (initializingSocket) => {
        initializingSocket.once("message", (data) => {
          resolveReady(JSON.parse(data.toString()) as SyncRealtimeEvent);
        });
      }
    }
  );
  return { socket, ready };
}

async function createSession(
  app: FastifyInstance,
  destination: string
): Promise<{ accountId: string; cookie: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: destination, pin: "1234" })
  });
  expect(response.statusCode).toBe(200);
  const session = response.json<SessionResponse>();
  return { accountId: session.account.id, cookie: extractCookie(response.headers["set-cookie"]) };
}

async function postJson<T = unknown>(
  app: FastifyInstance,
  url: string,
  payload: unknown,
  cookie?: string
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie })
    },
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

function extractCookie(header: string | string[] | number | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  expect(typeof value).toBe("string");
  return String(value).split(";")[0] ?? "";
}
