import { executeDaemonBusinessSkill } from "./daemon/business-skills.js";
import { loadDaemonConversationHistory } from "./daemon/conversation-history.js";
import { readWebPushConfiguration } from "./cp2/push.js";
import { registerCommerceRoutes } from "./cp2/domains/commerce/routes.js";
import { registerChatImageRoutes } from "./cp2/chat-image-routes.js";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { registerMcpRoutes, createMcpRouteState } from "./mcp/routes.js";
import { isValidTurnId, turnContext } from "./inference/turn-stream.js";
import { Cp2Error } from "./cp2/cp2-error.js";
import { createEmailProviderFromEnvironment } from "./cp2/email-provider.js";
import type { PoolClient, QueryResultRow } from "pg";
import { registerCp2Routes } from "./cp2/routes.js";
import { createPostgresBusinessTaskStore } from "./cp2/domains/agent-runtime/business-task-store.js";
import { createPostgresRuntimeApprovalStore } from "./cp2/domains/agent-runtime/runtime-approval-store.js";
import { createCp2Store, readSessionCookie, type Cp2Store } from "./cp2/store.js";
import { createInventoryProcurementStore } from "./cp2/domains/agent-runtime/inventory-procurement-store.js";
import { createBusinessTaskEvaluationReader } from "./cp2/domains/agent-runtime/business-task-evaluation-reader.js";
import { createInventoryTaskController } from "./cp2/domains/agent-runtime/inventory-task-controller.js";
import {
  createPostgresAccountAiAssetStore,
  createPostgresAttachmentBlobStore,
  loadTransactionalCp2Snapshot,
  saveTransactionalCp2Snapshot
} from "./cp2/postgres-store.js";

import { transactionPool } from "./edge-transaction-pool.js";
import {
  createEdgeSnapshotScope,
  prepareEdgeHydration,
  prepareEdgePersistence
} from "./cp2/edge-snapshot-scope.js";
import {
  createEdgeFulfillmentService,
  createEdgeStoreDependencies,
  readFulfillmentRetentionHours
} from "./edge-store-dependencies.js";
import { runEdgeJob, type EdgeJobDatabase, type EdgeJobOutcome } from "./edge-job-runner.js";
import {
  createEdgeDaemon,
  DaemonHttpError,
  maintenanceFromJobRunner,
  type EdgeDaemon
} from "./daemon/edge-lane.js";
import { createPostgresWakeHint } from "./daemon/wake-hint.js";
import { toPublicDaemonTask, type DaemonPool, type DaemonQueryable } from "./daemon/task-store.js";

export interface EdgeDomainDatabase {
  transaction: <T>(action: (client: PoolClient) => Promise<T>) => Promise<T>;
  /** Required to run background jobs; see EdgeJobDatabase. */
  jobTransaction?: EdgeJobDatabase["jobTransaction"];
  /** Independent connection/commit with no snapshot coordination lock. */
  approvalTransaction?: EdgeDomainDatabase["transaction"];
  /** Daemon lanes (docs/deployment/daemon-lanes.md); absent means /v1/daemon is not served. */
  daemon?: {
    /** The queue database; every statement commits on its own, with no store lock. */
    queue: DaemonPool;
    /** Supabase's own Postgres, holding the wake hint; null when SUPABASE_DB_URL is unset. */
    hint: DaemonQueryable | null;
    /** The signed-in user, or null. Must not hold any lock after it returns. */
    findUser: (request: Request) => Promise<{ userId: string } | null>;
  };
}

export async function createEdgeDomainRoutes(database: EdgeDomainDatabase) {
  // Push, email, SMS and mailbox providers, built once from the environment like the Node API's.
  const storeDependencies = createEdgeStoreDependencies();
  // Parsed once: an invalid value fails startup (readiness), not every request.
  const fulfillmentRetentionHours = readFulfillmentRetentionHours();
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

  // A model call must not keep snapshot/account/business locks or a Neon connection open.
  // The session lookup commits first; receipt drafts are persisted by a separate short request.
  const imageReader = database.daemon ? Fastify({ logger: false, bodyLimit: 14_000_000 }) : null;
  if (imageReader) {
    registerChatImageRoutes(imageReader, null, undefined, async (request) => {
      const user = await database.daemon!.findUser(
        new Request("https://grogoni.com/v1/chat/images/read", {
          headers: { cookie: request.headers.cookie ?? "" }
        })
      );
      return user ? {} : null;
    });
    await imageReader.ready();
  }
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
    const requestBody =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : Buffer.from(await request.arrayBuffer());
    const payload = requestBody?.length ? requestBody : undefined;
    if (payload && payload.length > 15_000_000)
      return Response.json({ code: "request_too_large" }, { status: 413 });
    if (path === "/v1/chat/images/read" && imageReader) {
      const result = await imageReader.inject({
        method: "POST",
        url: path,
        headers: {
          cookie: request.headers.get("cookie") ?? "",
          "content-type": request.headers.get("content-type") ?? "application/json"
        },
        ...(payload ? { payload } : {})
      });
      return new Response(result.body, {
        status: result.statusCode,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store"
        }
      });
    }
    // Buyer browsing is read-only outside our own checkout review. Model/browser calls must
    // not hold a database connection or account lock; only load and CAS-persist in short phases.
    let shoppingMessage = "";
    if (path === "/buy/assistant" && payload) {
      try {
        shoppingMessage = String(JSON.parse(payload.toString()).message ?? "")
          .trim()
          .toLowerCase()
          .replace(/[.!]+$/u, "");
      } catch {
        /* Route validates JSON. */
      }
    }
    if (
      path === "/buy/assistant" &&
      !["confirm checkout", "cancel checkout"].includes(shoppingMessage)
    ) {
      const loaded = await database.transaction(async (client) => {
        const scope = await createEdgeSnapshotScope(client, request, path, payload);
        return { scope, snapshot: await loadTransactionalCp2Snapshot(client, scope) };
      });
      const store = createCp2Store({
        ...storeDependencies,
        buyerShoppingSearch: async ({ sessionId, query }) => {
          const searchRequest = new Request(
            `https://grogoni.com/buy/search?query=${encodeURIComponent(query.slice(0, 120))}`,
            { headers: request.headers }
          );
          const found = await database.transaction(async (client) => {
            const scope = await createEdgeSnapshotScope(client, searchRequest, "/buy/search");
            return loadTransactionalCp2Snapshot(client, scope);
          });
          const catalogue = createCp2Store(storeDependencies);
          catalogue.hydrateSnapshot(prepareEdgeHydration(found));
          return {
            feed: catalogue.searchBuyFeed({ sessionId, query }),
            businesses: found.businesses,
            products: found.products
          };
        }
      });
      store.hydrateSnapshot(prepareEdgeHydration(loaded.snapshot));
      const shoppingApp = Fastify({ logger: false, bodyLimit: 64000 });
      registerCommerceRoutes(shoppingApp, store, undefined);
      try {
        const headers = Object.fromEntries(request.headers);
        delete headers["content-length"];
        const result = await shoppingApp.inject({
          method: "POST",
          url: path,
          headers,
          ...(payload ? { payload } : {})
        });
        if (result.statusCode >= 400)
          return new Response(result.body, {
            status: result.statusCode,
            headers: { "content-type": "application/json", "cache-control": "no-store" }
          });
        const next = prepareEdgePersistence(store.snapshot(), loaded.snapshot);
        await database.transaction(async (client) => {
          const current = await createEdgeSnapshotScope(client, request, path, payload);
          if (!current.accountId || current.accountId !== loaded.scope.accountId) {
            throw new Cp2Error(401, "session_expired", "Sign in again to continue shopping.");
          }
          await saveTransactionalCp2Snapshot(client, next, loaded.snapshot);
        });
        return new Response(result.body, {
          status: result.statusCode,
          headers: { "content-type": "application/json", "cache-control": "no-store" }
        });
      } catch (error) {
        if (error instanceof Cp2Error)
          return Response.json(
            { code: error.code, message: error.message },
            { status: error.statusCode }
          );
        if ((error as { code?: string }).code === "40001") {
          return Response.json(
            {
              code: "buyer_shopping_concurrent_update",
              message: "This shopping chat changed in another tab. Please send your request again."
            },
            { status: 409 }
          );
        }
        throw error;
      } finally {
        await shoppingApp.close();
      }
    }
    return database.transaction(async (client) => {
      const scope = await createEdgeSnapshotScope(client, request, path, payload);
      // GET handlers also refresh sessions, mark messages read and initialize runtime defaults.
      // Their snapshots must be loaded after the same tenant locks as explicit writes.
      {
        await client.query("set local lock_timeout = '10s'");
        if (scope.modelSelectionLock)
          await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
            scope.modelSelectionLock
          ]);
        if (scope.directPairLock)
          await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
            scope.directPairLock
          ]);
        if (scope.accountId)
          await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
            `edge:account:${scope.accountId}`
          ]);
        await client.query(
          `${scope.withClause} select pg_advisory_xact_lock(hashtextextended('edge:business:' || id, 0)) from edge_business_ids order by id`
        );
      }
      const pool = transactionPool(client);
      const nativeRecords =
        database.approvalTransaction === undefined
          ? pool
          : {
              query: <R extends QueryResultRow>(sql: string, values: unknown[]) =>
                database.approvalTransaction!((recordClient) => recordClient.query<R>(sql, values))
            };
      const store: Cp2Store = createCp2Store({
        ...storeDependencies,
        businessTaskEvaluations: createBusinessTaskEvaluationReader(nativeRecords, (input) =>
          store.authorizeBusinessPermission(input)
        ),
        // Independent transaction: rolling back this request must not reopen an executed approval.
        ...(database.approvalTransaction === undefined
          ? {}
          : {
              inventoryProcurement: createInventoryProcurementStore(
                database.approvalTransaction,
                (input) => store.authorizeBusinessPermission(input),
                {
                  check: (actor, input) => store.purchaseOrderDelivery().check(actor, input),
                  send: (actor, input, order) =>
                    store.purchaseOrderDelivery().send(actor, input, order)
                }
              ),
              runtimeApprovalStore: createPostgresRuntimeApprovalStore(nativeRecords)
            }),
        workspaceRoot: "/tmp/grogoni-workspace",
        conversationAttachmentBlobStore: createPostgresAttachmentBlobStore(pool),
        accountAiAssetStore: createPostgresAccountAiAssetStore(pool)
      });
      const snapshot = await loadTransactionalCp2Snapshot(client, scope);
      let baseline = snapshot;
      let independentlyCommitted = false;
      store.hydrateSnapshot(prepareEdgeHydration(snapshot));
      const inventoryTaskController =
        database.approvalTransaction === undefined
          ? undefined
          : createInventoryTaskController(
              store,
              (work) =>
                database.approvalTransaction!(async (recordClient) => {
                  await recordClient.query("set local statement_timeout = '15s'");
                  return work(transactionPool(recordClient));
                }),
              async () => {
                const next = prepareEdgePersistence(store.snapshot(), baseline);
                await database.approvalTransaction!((recordClient) =>
                  saveTransactionalCp2Snapshot(recordClient, next, baseline)
                );
                baseline = next;
                independentlyCommitted = true;
              }
            );
      if (inventoryTaskController) store.setInventoryTaskController(inventoryTaskController);
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
      app.addHook("onError", async (failedRequest, reply, error) => {
        if ((error.statusCode ?? 500) < 500) return;
        const requestId = crypto.randomUUID();
        reply.header("x-request-id", requestId);
        console.error(
          JSON.stringify({
            event: "edge_domain_route_failed",
            requestId,
            method: failedRequest.method,
            route: failedRequest.routeOptions.url,
            errorType: error.name,
            code: error.code ?? null
          })
        );
      });
      try {
        await app.register(websocket);
        const fulfillment = createEdgeFulfillmentService(pool, store, fulfillmentRetentionHours);
        const pendingActions: (() => Promise<unknown>)[] = [];
        store.setFulfillmentIntakeListener(async (input) => {
          pendingActions.push(() => fulfillment.intakeOrder(input));
        });
        store.setMembershipChangedListener(async (input) => {
          pendingActions.push(() => fulfillment.releaseDriverAssignments(input));
        });
        registerCp2Routes(app, {
          store,
          ...(readWebPushConfiguration()
            ? { vapidPublicKey: readWebPushConfiguration()!.publicKey }
            : {}),
          ...(inventoryTaskController === undefined ? {} : { inventoryTaskController }),
          businessTaskStore: createPostgresBusinessTaskStore(pool, (input) =>
            store.authorizeBusinessPermission(input)
          ),
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
          await client.query(
            "select pg_advisory_xact_lock(hashtextextended('edge:mcp-protocol', 0))"
          );
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
        if (payload === undefined) delete headers["content-type"];
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
        const afterRoutes = prepareEdgePersistence(store.snapshot(), baseline);
        // OAuth start/callback and session maintenance can mutate state on GET as well.
        // A repeatable-read outer snapshot cannot CAS rows committed by the task's own
        // independent transaction. Keep its final chat acknowledgement on that same path.
        const saveRequestSnapshot = (next: typeof snapshot, previous: typeof snapshot) =>
          independentlyCommitted
            ? database.approvalTransaction!((recordClient) =>
                saveTransactionalCp2Snapshot(recordClient, next, previous)
              )
            : saveTransactionalCp2Snapshot(client, next, previous);
        await saveRequestSnapshot(afterRoutes, baseline);
        for (const action of pendingActions) await action();
        if (pendingActions.length)
          await saveRequestSnapshot(
            prepareEdgePersistence(store.snapshot(), afterRoutes),
            afterRoutes
          );
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
  const runJob = (jobName: string): Promise<EdgeJobOutcome> => {
    const { jobTransaction } = database;
    if (jobTransaction === undefined)
      throw new Error("Background jobs need a jobTransaction on the Edge database.");
    return runEdgeJob({ jobTransaction }, jobName, {
      storeDependencies,
      ...(daemon === null ? {} : { daemon })
    });
  };
  const daemonDatabase = database.daemon;
  // A bad DAEMON_* setting disables the daemon lanes, never the whole API.
  let daemonStartupError: string | null = null;
  const startDaemon = (): EdgeDaemon | null => {
    if (daemonDatabase === undefined) return null;
    try {
      return createEdgeDaemon({
        queue: daemonDatabase.queue,
        hint: daemonDatabase.hint === null ? null : createPostgresWakeHint(daemonDatabase.hint),
        authenticate: async (request) => {
          const user = await daemonDatabase.findUser(request);
          if (user === null)
            throw new DaemonHttpError(401, "auth_required", "Authentication is required.");
          return user;
        },
        deliverConversationTask: async (task) => {
          if (!task.owner_user_id || task.payload.kind !== "agent" || !task.payload.conversation)
            return;
          const origin = task.payload.conversation;
          const internal = new Request(`https://grogoni.com/v1/conversations/${origin.id}`);
          await database.transaction(async (client) => {
            const scope = await createEdgeSnapshotScope(
              client,
              internal,
              `/v1/conversations/${origin.id}`,
              undefined,
              { daemonOwnerUserId: task.owner_user_id! }
            );
            if (!scope.accountId) return; // Deleted account: no further delivery authority.
            await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
              `edge:account:${scope.accountId}`
            ]);
            const previous = await loadTransactionalCp2Snapshot(client, scope);
            const store = createCp2Store(storeDependencies);
            store.hydrateSnapshot(prepareEdgeHydration(previous));
            try {
              store.deliverDaemonTask(toPublicDaemonTask(task), task.owner_user_id!);
            } catch (error) {
              if (error instanceof Cp2Error && error.statusCode === 404) return;
              throw error;
            }
            await store.deliverPendingMessageNotifications();
            await saveTransactionalCp2Snapshot(
              client,
              prepareEdgePersistence(store.snapshot(), previous),
              previous
            );
          });
        },
        runBusinessSkill: (task, businessId, message, signal) =>
          executeDaemonBusinessSkill({
            task,
            businessId,
            message,
            signal,
            load: () =>
              database.transaction(async (client) => {
                if (
                  !task.owner_user_id ||
                  task.payload.kind !== "agent" ||
                  !task.payload.conversation
                )
                  throw new Error("Missing skill identity.");
                const internal = new Request(
                  `https://grogoni.com/v1/conversations/${task.payload.conversation.id}`
                );
                const scope = await createEdgeSnapshotScope(
                  client,
                  internal,
                  new URL(internal.url).pathname,
                  undefined,
                  { daemonOwnerUserId: task.owner_user_id }
                );
                return prepareEdgeHydration(await loadTransactionalCp2Snapshot(client, scope));
              }),
            send: (request) => routes(request, "/v1/messages")
          }),
        loadConversationHistory: (task) =>
          database.transaction((client) => loadDaemonConversationHistory(client, task)),
        authorizeConversation: async (request, conversationId) => {
          const path = `/v1/conversations/${conversationId}`;
          return database.transaction(async (client) => {
            const scope = await createEdgeSnapshotScope(client, request, path);
            const snapshot = await loadTransactionalCp2Snapshot(client, scope);
            const store = createCp2Store(storeDependencies);
            store.hydrateSnapshot(prepareEdgeHydration(snapshot));
            const sessionId =
              (request.headers.get("cookie") ?? "").match(
                /(?:^|;\s*)grogoni_session=([^;]+)/u
              )?.[1] ?? null;
            let view;
            try {
              view = store.getConversation({ sessionId, conversationId });
            } catch {
              throw new DaemonHttpError(
                404,
                "conversation_not_found",
                "Conversation was not found."
              );
            }
            if (view.conversation.conversationType !== "DAEMON")
              throw new DaemonHttpError(
                403,
                "task_conversation_invalid",
                "Background assistant tasks require your daemon conversation."
              );
            try {
              const runtime = store.resolveRuntimeBinding(conversationId);
              return { modelId: runtime.selected.model.id };
            } catch {
              throw new DaemonHttpError(
                503,
                "conversation_model_unavailable",
                "The selected conversation model is unavailable."
              );
            }
          });
        },
        environment: process.env,
        // A queued maintenance task runs the same job in-process, under its own job lock.
        runMaintenance: maintenanceFromJobRunner(runJob),
        report: (event) => console.log(JSON.stringify({ event: "daemon", ...event }))
      });
    } catch (error) {
      daemonStartupError = error instanceof Error ? error.message : "Daemon configuration failed.";
      console.error(
        JSON.stringify({ event: "daemon_config_invalid", message: daemonStartupError })
      );
      return null;
    }
  };
  const daemon = startDaemon();
  return {
    routes,
    inventory,
    daemonRoutes: async (request: Request, path: string) =>
      daemon !== null
        ? daemon.routes(request, path)
        : daemonStartupError !== null
          ? Response.json(
              {
                code: "daemon_unavailable",
                message: "Background tasks are not available right now."
              },
              { status: 503 }
            )
          : null,
    runJob
  };
}
