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
  rebaseLoadNormalizedCollections,
  saveTransactionalCp2Snapshot
} from "./cp2/postgres-store.js";

import { transactionPool } from "./edge-transaction-pool.js";
import {
  createEdgeSnapshotScope,
  allocateOfflineSequences,
  offlineSequenceHighWater,
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
  grogoniIdFromCommerceAddress,
  normalizeCommerceAddress,
  normalizeStorefrontLookupId
} from "./cp2/text-normalization.js";
import {
  createEdgeDaemon,
  DaemonHttpError,
  maintenanceFromJobRunner,
  type EdgeDaemon
} from "./daemon/edge-lane.js";
import { createPostgresWakeHint } from "./daemon/wake-hint.js";
import type { DaemonPool, DaemonQueryable } from "./daemon/task-store.js";
import {
  createEdgeGuestIntentRoutes,
  createGuestIntentService,
  readGuestIntentConfiguration
} from "./guest-intent/service.js";
import { createPostgresGuestIntentLimiter } from "./guest-intent/rate-limit.js";

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
  /**
   * The guest intent classifier (services/api/src/guest-intent/README.md); absent means
   * /v1/guest/intent is not served and guests are routed by rules.
   */
  guestIntent?: {
    /** The signed-in session, or null. Must commit and release its connection before returning. */
    findSession: (request: Request) => Promise<{ sessionId: string } | null>;
    /** Autocommit queries for the per-session counter; no store lock. */
    counter: DaemonQueryable;
  };
}

/** Shop creation and storefront-ID renames: the routes that pick a new grogoniId. */
export function claimsGrogoniId(method: string, path: string): boolean {
  return (
    (method === "POST" && path === "/businesses") ||
    ((method === "PUT" || method === "PATCH" || method === "POST") &&
      /^\/businesses\/[^/]+\/grogoni-id$/u.test(path))
  );
}

/** Every storefront ID in use or in its post-rename cooldown, across all tenants. */
/**
 * Storefront IDs held by any tenant. `only` limits the scan to one ID: the public availability
 * check asks about a single address and must not read every business on each call.
 */
async function loadTakenGrogoniIds(client: PoolClient, only?: string): Promise<Set<string>> {
  const result = await client.query<{ id: string }>(
    `select grogoni_id as id from businesses
     where grogoni_id is not null and ($1::text is null or lower(grogoni_id) = $1)
     union
     select record->>'grogoniId' from cp2_grogoni_id_history
     where record->>'grogoniId' is not null and record->>'releasedAt' is null
       and ($1::text is null or lower(record->>'grogoniId') = $1)`,
    [only ?? null]
  );
  return new Set(result.rows.map((row) => normalizeStorefrontLookupId(row.id)));
}

/** The one storefront ID an availability check asks about, or null when the address is invalid. */
function availabilityGrogoniId(url: URL): string | null {
  try {
    const address = normalizeCommerceAddress(url.searchParams.get("address") ?? "");
    return normalizeStorefrontLookupId(grogoniIdFromCommerceAddress(address));
  } catch {
    return null;
  }
}

/** What one attempt at a request did outside its own transaction. */
interface RequestAttempt {
  independentWork: boolean;
}

/**
 * Whether a failed request may run again. Never when the attempt did work in an independent
 * transaction: that committed and would be repeated. A lost optimistic-save race (40001) reruns
 * only a GET or HEAD on an allowlisted read (retryableReads); nothing else is replayed, since a
 * model call, an email, or a redeemed OAuth code inside the rolled-back transaction would repeat. A storefront ID claim that hit the unique
 * index (23505) reruns: it lost a race to the same new ID and nothing else happened.
 */
export function mayRetryRequest(
  method: string,
  path: string,
  attempt: RequestAttempt,
  error: unknown
): boolean {
  if (attempt.independentWork) return false;
  const code = (error as { code?: unknown } | null)?.code;
  // Two creates raced to the same new storefront ID: nothing committed, and the rerun reloads the
  // taken IDs and picks the next free one.
  if (code === "23505") return claimsGrogoniId(method, path);
  return (
    code === "40001" &&
    (method === "GET" || method === "HEAD") &&
    retryableReads.some((pattern) => pattern.test(path))
  );
}

/**
 * Reads that may rerun after losing a save race: the app's own polling and listing routes, which
 * touch only this database. An allowlist on purpose: a GET outside it (an OAuth or mailbox
 * callback redeeming a single-use code, a search that calls a connector) may reach a third party,
 * and a new route is not retried until someone checks that it cannot.
 */
const retryableReads: readonly RegExp[] = [
  /^\/v1\/(?:shops|session\/context|sync\/changes)$/u,
  /^\/v1\/conversations(?:\/recycle-bin|\/[^/]+(?:\/encryption-devices|\/messages\/[^/]+\/delivery-attempts)?)?$/u,
  /^\/businesses\/[^/]+\/(?:presence|agent-profile|products(?:\/fields)?|customers|suppliers|invoices)$/u,
  /^\/public\/storefronts(?:\/[^/]+)?$/u,
  /^\/public\/commerce-identities\/[^/]+$/u,
  /^\/network(?:\/(?:connections|direct|extended))?$/u
];

/** The database as one attempt sees it: independent transactions are recorded on the attempt. */
export function trackIndependentWork(
  database: EdgeDomainDatabase,
  attempt: RequestAttempt
): EdgeDomainDatabase {
  const independent = database.approvalTransaction;
  if (independent === undefined) return database;
  return {
    ...database,
    approvalTransaction: (action) => {
      attempt.independentWork = true;
      return independent(action);
    }
  };
}

async function retryReadOnConflict<T>(
  method: string,
  path: string,
  run: (attempt: RequestAttempt) => Promise<T>
): Promise<T> {
  for (let tries = 1; ; tries++) {
    const attempt: RequestAttempt = { independentWork: false };
    try {
      return await run(attempt);
    } catch (error) {
      if (tries >= 3 || !mayRetryRequest(method, path, attempt, error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * tries + Math.random() * 40));
    }
  }
}

export async function createEdgeDomainRoutes(edgeDatabase: EdgeDomainDatabase) {
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
    return retryReadOnConflict(request.method, path, (attempt) => {
      const database = trackIndependentWork(edgeDatabase, attempt);
      return database.transaction(async (client) => {
        const scope = await createEdgeSnapshotScope(client, request, path, payload);
        if (request.method !== "GET" && request.method !== "HEAD") {
          await client.query("set local lock_timeout = '10s'");
          if (scope.accountId)
            await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
              `edge:account:${scope.accountId}`
            ]);
          await client.query(
            `${scope.withClause} select pg_advisory_xact_lock(hashtextextended('edge:business:' || id, 0)) from edge_business_ids order by id`
          );
        }
        const pool = transactionPool(client);
        // Only requests that can claim a storefront ID load the global set of taken IDs.
        const takenGrogoniIds = claimsGrogoniId(request.method, path)
          ? await loadTakenGrogoniIds(client)
          : request.method === "GET" && path === "/public/commerce-identities/availability"
            ? await loadTakenGrogoniIds(client, availabilityGrogoniId(url) ?? "")
            : null;
        const nativeRecords =
          database.approvalTransaction === undefined
            ? pool
            : {
                query: <R extends QueryResultRow>(sql: string, values: unknown[]) =>
                  database.approvalTransaction!((recordClient) =>
                    recordClient.query<R>(sql, values)
                  )
              };
        const store: Cp2Store = createCp2Store({
          ...storeDependencies,
          ...(takenGrogoniIds === null
            ? {}
            : { externalGrogoniIdTaken: (id: string) => takenGrogoniIds.has(id) }),
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
        // Final offline change sequence numbers given in this request (allocateOfflineSequences).
        const offlineSequences = new Map<string, number>();
        const saveWithOfflineSequences = async (
          target: PoolClient,
          next: typeof snapshot,
          previous: typeof snapshot
        ) => {
          await allocateOfflineSequences(target, next, previous, offlineSequences);
          await saveTransactionalCp2Snapshot(target, next, previous);
        };
        // A write may allocate offline change sequences, which are unique across all shops.
        store.hydrateSnapshot(
          prepareEdgeHydration(
            snapshot,
            request.method === "GET" || request.method === "HEAD"
              ? 0
              : await offlineSequenceHighWater(client)
          )
        );
        // Loading fills message defaults; that alone must not count as this request's change.
        baseline = rebaseLoadNormalizedCollections(snapshot, store.snapshot(), [
          "conversationMessages"
        ]);
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
                    saveWithOfflineSequences(recordClient, next, baseline)
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
            oauthAllowedRedirectOrigins: (process.env.WEB_ORIGINS ?? "https://grogoni.com").split(
              ","
            )
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
                  saveWithOfflineSequences(recordClient, next, previous)
                )
              : saveWithOfflineSequences(client, next, previous);
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
    });
  };
  const runJob = (jobName: string): Promise<EdgeJobOutcome> => {
    const { jobTransaction } = edgeDatabase;
    if (jobTransaction === undefined)
      throw new Error("Background jobs need a jobTransaction on the Edge database.");
    return runEdgeJob({ jobTransaction }, jobName, {
      storeDependencies,
      ...(daemon === null ? {} : { daemon })
    });
  };
  const daemonDatabase = edgeDatabase.daemon;
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
  const guestIntentRoutes = startGuestIntent(edgeDatabase.guestIntent);
  return {
    routes,
    inventory,
    /** POST /v1/guest/intent, outside any snapshot transaction; null for every other path. */
    guestIntentRoutes: async (request: Request, path: string) =>
      guestIntentRoutes === null ? null : guestIntentRoutes(request, path),
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

/** A bad GUEST_INTENT_* setting disables the classifier (guests use the rules), never the API. */
function startGuestIntent(database: EdgeDomainDatabase["guestIntent"]) {
  if (database === undefined) return null;
  try {
    const configuration = readGuestIntentConfiguration(process.env);
    if (configuration.disabledReason !== null)
      console.log(
        JSON.stringify({ event: "guest_intent_disabled", reason: configuration.disabledReason })
      );
    return createEdgeGuestIntentRoutes({
      service: createGuestIntentService({
        classifier: configuration.classifier,
        limiter: createPostgresGuestIntentLimiter(database.counter, configuration.ratePolicy)
      }),
      findSession: database.findSession
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "guest_intent_config_invalid",
        message: error instanceof Error ? error.message : "Guest intent configuration failed."
      })
    );
    return null;
  }
}
