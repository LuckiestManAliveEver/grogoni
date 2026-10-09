import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { registerMcpRoutes, createMcpRouteState } from "./mcp/routes.js";
import { isValidTurnId, turnContext } from "./inference/turn-stream.js";
import { Cp2Error } from "./cp2/cp2-error.js";
import { createEmailProviderFromEnvironment } from "./cp2/email-provider.js";
import type { Pool, PoolClient } from "pg";
import { registerCp2Routes } from "./cp2/routes.js";
import { createCp2Store, readSessionCookie } from "./cp2/store.js";
import {
  createPostgresAccountAiAssetStore,
  createPostgresAttachmentBlobStore,
  loadTransactionalCp2Snapshot,
  saveTransactionalCp2Snapshot
} from "./cp2/postgres-store.js";
import {
  createPostgresFulfillmentService,
  fulfillmentDepsFromStore
} from "./cp2/domains/fulfillment/service.js";

export interface EdgeDomainDatabase {
  transaction: <T>(action: (client: PoolClient) => Promise<T>) => Promise<T>;
}

function transactionPool(client: PoolClient): Pool {
  let sequence = 0;
  return {
    query: client.query.bind(client),
    async connect() {
      const name = `edge_domain_${++sequence}`;
      return {
        async query(sql: string, values?: unknown[]) {
          const command = sql.trim().toLowerCase();
          if (command === "begin") return client.query(`savepoint ${name}`);
          if (command === "commit") return client.query(`release savepoint ${name}`);
          if (command === "rollback") return client.query(`rollback to savepoint ${name}`);
          return client.query(sql, values);
        },
        release() {}
      };
    }
  } as unknown as Pool;
}

export async function createEdgeDomainRoutes(database: EdgeDomainDatabase) {
  // Only route metadata is shared. Every request gets fresh state and a transaction.
  const inventoryApp = Fastify({ logger: false });
  await inventoryApp.register(websocket);
  const inventory: { method: string; path: string; websocket: boolean }[] = [];
  inventoryApp.addHook("onRoute", (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method])
      inventory.push({ method, path: route.url, websocket: route.websocket === true });
  });
  const inventoryStore = registerCp2Routes(inventoryApp);
  registerMcpRoutes(inventoryApp, {
    store: inventoryStore,
    allowedOrigins: [],
    publicOrigin: "https://grogoni.com/api"
  });
  await inventoryApp.ready();
  await inventoryApp.close();
  const patterns = inventory.map((route) => ({
    ...route,
    pattern: new RegExp(
      `^${route.path
        .split("/")
        .map((part) =>
          part.startsWith(":")
            ? "[^/]+"
            : part === "*"
              ? ".*"
              : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        )
        .join("/")}$`
    )
  }));

  const routes = async (request: Request, path: string): Promise<Response | null> => {
    const route = patterns.find(
      (candidate) => candidate.method === request.method && candidate.pattern.test(path)
    );
    if (!route) return null;
    if (route.websocket)
      return Response.json(
        { code: "realtime_poll_required", eventsUrl: "/v1/realtime/events" },
        { status: 426 }
      );
    const url = new URL(request.url);
    const payload =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : Buffer.from(await request.arrayBuffer());
    if (payload && payload.length > 15_000_000)
      return Response.json({ code: "request_too_large" }, { status: 413 });
    return database.transaction(async (client) => {
      await client.query("set local lock_timeout = '10s'");
      await client.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
      const pool = transactionPool(client);
      const store = createCp2Store({
        messageWebBaseUrl: process.env.WEB_PUBLIC_URL ?? "https://grogoni.com",
        workspaceRoot: "/tmp/grogoni-workspace",
        conversationAttachmentBlobStore: createPostgresAttachmentBlobStore(pool),
        accountAiAssetStore: createPostgresAccountAiAssetStore(pool)
      });
      const snapshot = await loadTransactionalCp2Snapshot(client);
      const baseline = structuredClone(snapshot);
      store.hydrateSnapshot(snapshot);
      if (request.method === "GET" && path.startsWith("/v1/ai/turn-stream/")) {
        const turnId = path.slice("/v1/ai/turn-stream/".length);
        if (!isValidTurnId(turnId))
          return Response.json({ code: "turn_id_invalid" }, { status: 400 });
        const encoder = new TextEncoder();
        let stop = () => {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        let closed = false;
        const close = () => {
          if (!closed) {
            closed = true;
            stop();
            if (timer) clearTimeout(timer);
          }
        };
        try {
          // Authorize before opening a stream; the DB transaction ends as soon as it is returned.
          const sessionId = readSessionCookie(request.headers.get("cookie") ?? undefined);
          stop = store.subscribeAgentTurnStream({ sessionId, turnId, listener: () => {} });
          stop();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(": connected\n\n"));
              stop = store.subscribeAgentTurnStream({
                sessionId,
                turnId,
                listener: (event) => {
                  if (closed) return;
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                  if (event.type === "done") {
                    close();
                    controller.close();
                  }
                }
              });
              if (closed) stop();
              if (!closed)
                timer = setTimeout(() => {
                  close();
                  controller.close();
                }, 30000);
              request.signal.addEventListener(
                "abort",
                () => {
                  close();
                  try {
                    controller.close();
                  } catch {
                    // Cancellation may already have closed the stream.
                  }
                },
                { once: true }
              );
            },
            cancel() {
              close();
            }
          });
          return new Response(stream, {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" }
          });
        } catch (error) {
          close();
          if (error instanceof Cp2Error)
            return Response.json(
              { code: error.code, message: error.message },
              { status: error.statusCode }
            );
          throw error;
        }
      }
      const app = Fastify({ logger: false, bodyLimit: 15_000_000 });
      try {
        await app.register(websocket);
        const fulfillment = createPostgresFulfillmentService({
          pool,
          deps: fulfillmentDepsFromStore(store)
        });
        const pendingActions: (() => Promise<unknown>)[] = [];
        store.setFulfillmentIntakeListener(async (input) => {
          pendingActions.push(() => fulfillment.intakeOrder(input));
        });
        store.setMembershipChangedListener(async (input) => {
          pendingActions.push(() => fulfillment.releaseDriverAssignments(input));
        });
        registerCp2Routes(app, {
          store,
          emailProvider: createEmailProviderFromEnvironment({
            ...process.env,
            NODE_ENV: "production"
          }),
          fulfillmentService: fulfillment,
          webPublicUrl: process.env.WEB_PUBLIC_URL ?? "https://grogoni.com",
          realtimeAllowedOrigins: (process.env.WEB_ORIGINS ?? "https://grogoni.com").split(","),
          oauthAllowedRedirectOrigins: (process.env.WEB_ORIGINS ?? "https://grogoni.com").split(",")
        });
        const mcp = createMcpRouteState();
        const needsMcpState =
          path === "/mcp" ||
          path.startsWith("/oauth/") ||
          path.startsWith("/v1/mcp/") ||
          path.startsWith("/.well-known/");
        if (needsMcpState) {
          const saved = (
            await client.query(
              "select record from cp2_edge_protocol_state where entity_id = 'mcp' for update"
            )
          ).rows[0]?.record;
          const fields = {
            sessions: mcp.sessions,
            rateWindows: mcp.rateWindows,
            pendingCheckouts: mcp.pendingCheckouts,
            pendingAuthorizations: mcp.oauth.pendingAuthorizations,
            authorizationCodes: mcp.oauth.authorizationCodes
          };
          for (const [name, map] of Object.entries(fields)) {
            for (const [key, value] of saved?.[name] ?? []) {
              const expires =
                name === "rateWindows"
                  ? value.startedAt + 60000
                  : typeof value.expiresAt === "string"
                    ? Date.parse(value.expiresAt)
                    : value.expiresAt;
              if (expires > Date.now()) (map as Map<string, unknown>).set(key, value);
            }
          }
        }
        registerMcpRoutes(app, {
          store,
          state: mcp,
          fulfillmentService: fulfillment,
          allowedOrigins: (process.env.WEB_ORIGINS ?? "https://grogoni.com").split(","),
          publicOrigin: `${(process.env.WEB_PUBLIC_URL ?? "https://grogoni.com").replace(/\/+$/, "")}/api`
        });
        const headers = Object.fromEntries(request.headers);
        delete headers["content-length"];
        const inject = () =>
          app.inject({
            method: request.method as
              "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS",
            url: path + url.search,
            headers,
            ...(payload === undefined ? {} : { payload })
          });
        const turnId = request.headers.get("x-grogoni-turn-id");
        const result = isValidTurnId(turnId)
          ? await turnContext.run({ turnId }, inject)
          : await inject();
        const afterRoutes = structuredClone(store.snapshot());
        await saveTransactionalCp2Snapshot(client, afterRoutes, baseline);
        for (const action of pendingActions) await action();
        if (pendingActions.length)
          await saveTransactionalCp2Snapshot(client, store.snapshot(), afterRoutes);
        if (needsMcpState) {
          const record = Object.fromEntries(
            Object.entries({
              sessions: mcp.sessions,
              rateWindows: mcp.rateWindows,
              pendingCheckouts: mcp.pendingCheckouts,
              pendingAuthorizations: mcp.oauth.pendingAuthorizations,
              authorizationCodes: mcp.oauth.authorizationCodes
            }).map(([name, map]) => [name, [...map]])
          );
          await client.query(
            "insert into cp2_edge_protocol_state (entity_id, record) values ('mcp', $1::jsonb) on conflict (entity_id) do update set record = excluded.record, updated_at = now()",
            [JSON.stringify(record)]
          );
        }
        const outgoing = new Headers();
        for (const [name, value] of Object.entries(result.headers)) {
          if (
            value === undefined ||
            ["content-length", "transfer-encoding", "connection"].includes(name)
          )
            continue;
          for (const entry of Array.isArray(value) ? value : [String(value)])
            outgoing.append(name, entry);
        }
        return new Response(
          request.method === "HEAD" || result.statusCode === 204 || result.statusCode === 304
            ? null
            : new Uint8Array(result.rawPayload),
          { status: result.statusCode, headers: outgoing }
        );
      } finally {
        await app.close();
      }
    });
  };
  return { routes, inventory };
}
