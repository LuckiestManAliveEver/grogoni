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
  rebaseLoadNormalizedCollections,
  saveTransactionalCp2Snapshot
} from "./cp2/postgres-store.js";

import { transactionPool } from "./edge-transaction-pool.js";
import {
  enqueueAgentTurn,
  findAgentTurnByMessage,
  settleAnsweredAgentTurn,
  completeAgentTurn,
  type AgentTurnRecord
} from "./edge-agent-turns.js";
import { createAgentTurnWorker } from "./edge-agent-turn-worker.js";
import {
  AttemptNeedsModelCall,
  ModelCallDeferredError,
  ModelCallLedger,
  suppressAfterDeferral
} from "./edge-model-deferral.js";
import { ModelRuntimeError } from "./inference/model-runtime.js";
import {
  createEdgeSnapshotScope,
  allocateAccountSyncSequences,
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
import { toPublicDaemonTask, type DaemonPool, type DaemonQueryable } from "./daemon/task-store.js";
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

/**
 * Writes that change only the caller's own rows: read markers and conversation settings
 * (PATCH /v1/conversations/:id: participant row, read flags of others' messages, the title) and
 * typing. They skip the account and business locks, so they never wait on another write of the
 * same account, and their rows are guarded by the save's own compare-and-set; journal numbers come
 * from allocateAccountSyncSequences. A lost race (40001) reruns them: they call no model and
 * nothing outside this database.
 */
export function isEdgeFastPathWrite(method: string, path: string): boolean {
  return (
    (method === "PATCH" &&
      /^\/v1\/conversations\/[^/]+$/u.test(path) &&
      path !== "/v1/conversations/recycle-bin") ||
    (method === "POST" && /^\/v1\/conversations\/[^/]+\/typing$/u.test(path))
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
  if (code === "40001" && isEdgeFastPathWrite(method, path)) return true;
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
  attempt: RequestAttempt,
  ledger?: { readonly pending: unknown }
): EdgeDomainDatabase {
  const independent = database.approvalTransaction;
  if (independent === undefined) return database;
  return {
    ...database,
    approvalTransaction: (action) => {
      // An attempt waiting for a model call is rolled back: it must commit nothing on the side.
      if (ledger !== undefined && ledger.pending !== null)
        return Promise.reject(new ModelCallDeferredError());
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

/** What the host runtime offers background work. */
export interface EdgeDomainRuntime {
  /**
   * Keeps work alive after its response was sent: Supabase's EdgeRuntime.waitUntil. Without it
   * (the local Deno stand-in, tests) the work simply continues in the running process.
   */
  waitUntil?: (work: Promise<unknown>) => void;
}

/** Whether a POST /v1/messages body asks for an agent reply. */
function requestsAgentTurn(payload: Buffer | undefined): boolean {
  if (payload === undefined) return false;
  try {
    const body = JSON.parse(payload.toString()) as { agent?: unknown } | null;
    return typeof body?.agent === "object" && body.agent !== null;
  } catch {
    return false;
  }
}

export async function createEdgeDomainRoutes(
  edgeDatabase: EdgeDomainDatabase,
  runtime: EdgeDomainRuntime = {}
) {
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
  const imageReader = edgeDatabase.daemon
    ? Fastify({ logger: false, bodyLimit: 14_000_000 })
    : null;
  if (imageReader) {
    registerChatImageRoutes(imageReader, null, undefined, async (request) => {
      const user = await edgeDatabase.daemon!.findUser(
        new Request("https://grogoni.com/v1/chat/images/read", {
          headers: { cookie: request.headers.cookie ?? "" }
        })
      );
      return user ? {} : null;
    });
    await imageReader.ready();
  }
  /** One attempt's store dependencies: model calls deferred, sends stopped once one is. */
  const realResolver = storeDependencies.modelRuntimeAdapterResolver ?? (() => undefined);
  const newLedger = (streamTurnId: string | null) =>
    new ModelCallLedger(realResolver, { streamTurnId });
  const attemptDependencies = (ledger: ModelCallLedger): typeof storeDependencies => {
    const {
      modelRuntimeAdapterResolver,
      pushNotificationSender,
      messageEmailNotificationSender,
      networkInviteSender,
      channelGateway,
      emailMailboxProviderClient,
      ...rest
    } = storeDependencies;
    return {
      ...rest,
      ...(modelRuntimeAdapterResolver === undefined
        ? {}
        : { modelRuntimeAdapterResolver: ledger.resolver() }),
      ...(pushNotificationSender === undefined
        ? {}
        : { pushNotificationSender: suppressAfterDeferral(pushNotificationSender, ledger) }),
      ...(messageEmailNotificationSender === undefined
        ? {}
        : {
            messageEmailNotificationSender: suppressAfterDeferral(
              messageEmailNotificationSender,
              ledger
            )
          }),
      ...(networkInviteSender === undefined
        ? {}
        : { networkInviteSender: suppressAfterDeferral(networkInviteSender, ledger) }),
      ...(channelGateway === undefined
        ? {}
        : { channelGateway: suppressAfterDeferral(channelGateway, ledger) }),
      ...(emailMailboxProviderClient === undefined
        ? {}
        : { emailMailboxProviderClient: suppressAfterDeferral(emailMailboxProviderClient, ledger) })
    };
  };

  interface AttemptInput {
    request: Request;
    path: string;
    url: URL;
    payload: Buffer | undefined;
    attempt: RequestAttempt;
    ledger: ModelCallLedger;
    /** POST /v1/messages with `agent`: how its turn runs, and the turns to start after commit. */
    turns: {
      dispatch: string[];
      streamTurnId: string | null;
    } | null;
    /** A background agent turn: runs this instead of an HTTP route; null means it needs a model. */
    worker?: (
      store: Cp2Store,
      pool: ReturnType<typeof transactionPool>
    ) => Promise<Record<string, unknown> | null>;
  }

  /** One attempt of a request, in one transaction. */
  const runAttempt = (input: AttemptInput): Promise<Response> => {
    const { request, path, url, payload, attempt, ledger } = input;
    ledger.beginAttempt();
    const database = trackIndependentWork(edgeDatabase, attempt, ledger);

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
        if (!isEdgeFastPathWrite(request.method, path)) {
          if (scope.accountId)
            await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
              `edge:account:${scope.accountId}`
            ]);
          await client.query(
            `${scope.withClause} select pg_advisory_xact_lock(hashtextextended('edge:business:' || id, 0)) from edge_business_ids order by id`
          );
        }
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
                database.approvalTransaction!((recordClient) => recordClient.query<R>(sql, values))
            };
      const store: Cp2Store = createCp2Store({
        ...attemptDependencies(ledger),
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
      // Final account sync journal numbers given in this request (allocateAccountSyncSequences).
      const syncSequences = new Map<string, number>();
      const saveWithOfflineSequences = async (
        target: PoolClient,
        next: typeof snapshot,
        previous: typeof snapshot
      ) => {
        await allocateOfflineSequences(target, next, previous, offlineSequences);
        await allocateAccountSyncSequences(target, next, previous, syncSequences);
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
      const turns = input.turns;
      if (turns !== null)
        store.setAgentTurnQueue({
          find: async (messageId) => {
            const turn = await findAgentTurnByMessage(pool, messageId);
            // A queued turn whose start was lost gets another start; claiming it is atomic.
            if (turn?.status === "pending") turns.dispatch.push(turn.id);
            return turn;
          },
          enqueue: async (turnInput) => {
            const turn = await enqueueAgentTurn(pool, {
              ...turnInput,
              streamTurnId: turns.streamTurnId
            });
            if (turn.status === "pending") turns.dispatch.push(turn.id);
            return turn;
          },
          settle: (messageId, result) => settleAnsweredAgentTurn(pool, messageId, result)
        });
      // Saves what this attempt changed, then the follow-up work its writes queued.
      const persistAttempt = async (pendingActions: (() => Promise<unknown>)[]) => {
        const afterRoutes = prepareEdgePersistence(store.snapshot(), baseline);
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
      };
      if (input.worker !== undefined) {
        const fulfillment = createEdgeFulfillmentService(pool, store, fulfillmentRetentionHours);
        const pendingActions: (() => Promise<unknown>)[] = [];
        store.setFulfillmentIntakeListener(async (intake) => {
          pendingActions.push(() => fulfillment.intakeOrder(intake));
        });
        store.setMembershipChangedListener(async (change) => {
          pendingActions.push(() => fulfillment.releaseDriverAssignments(change));
        });
        const body = await input.worker(store, pool);
        if (ledger.pending !== null || body === null)
          throw new AttemptNeedsModelCall(attempt.independentWork);
        await persistAttempt(pendingActions);
        return Response.json(body);
      }
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
          emailProvider: suppressAfterDeferral(
            createEmailProviderFromEnvironment({
              ...process.env,
              NODE_ENV: "production"
            }),
            ledger
          ),
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
        // The route needed a model call it had no answer for: roll everything back (nothing is
        // saved), make the call with no transaction open, and run the request again.
        if (ledger.pending !== null) throw new AttemptNeedsModelCall(attempt.independentWork);
        // OAuth start/callback and session maintenance can mutate state on GET as well.
        await persistAttempt(pendingActions);
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

  const routes = async (request: Request, path: string): Promise<Response | null> => {
    const turnPoll = /^\/v1\/agent-turns\/([^/]+)$/u.exec(path);
    if (request.method === "GET" && turnPoll !== null)
      return worker.poll(request, decodeURIComponent(turnPoll[1]!));
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
      const loaded = await edgeDatabase.transaction(async (client) => {
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
          const found = await edgeDatabase.transaction(async (client) => {
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
        await edgeDatabase.transaction(async (client) => {
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
    const streamHeader = request.headers.get("x-grogoni-turn-id");
    const streamTurnId = isValidTurnId(streamHeader) ? streamHeader : null;
    const agentTurn =
      request.method === "POST" && path === "/v1/messages" && requestsAgentTurn(payload);
    const ledger = newLedger(streamTurnId);
    for (;;) {
      const dispatch: string[] = [];
      try {
        const response = await retryReadOnConflict(request.method, path, (attempt) =>
          runAttempt({
            request,
            path,
            url,
            payload,
            attempt,
            ledger,
            turns: agentTurn ? { dispatch, streamTurnId } : null
          })
        );
        // Committed: start the queued turn in the background.
        for (const turnId of dispatch) worker.dispatch(turnId);
        return response;
      } catch (error) {
        if (!(error instanceof AttemptNeedsModelCall)) throw error;
        if (error.independentWork) {
          console.error(
            JSON.stringify({ event: "edge_model_call_after_commit", method: request.method, path })
          );
          return Response.json(
            {
              code: "service_unavailable",
              message: "The service is temporarily unavailable."
            },
            { status: 503 }
          );
        }
        try {
          await ledger.callLive(request.signal);
        } catch (failure) {
          if (!(failure instanceof ModelRuntimeError)) throw failure;
          return Response.json(
            { code: failure.code, message: failure.message, retryable: failure.retryable },
            { status: 503 }
          );
        }
      }
    }
  };
  const worker = createAgentTurnWorker({
    queue: (work) => (edgeDatabase.approvalTransaction ?? edgeDatabase.transaction)(work),
    read: (work) => edgeDatabase.transaction(work),
    newLedger,
    ...(runtime.waitUntil === undefined ? {} : { waitUntil: runtime.waitUntil }),
    report: (event) => console.log(JSON.stringify(event)),
    attempt: (turn, leaseToken, ledger) => runTurnAttempt(turn, leaseToken, ledger)
  });
  /** One locked attempt of a queued turn, as the person who sent its message. */
  const runTurnAttempt = async (
    turn: AgentTurnRecord,
    leaseToken: string,
    ledger: ModelCallLedger
  ): Promise<void> => {
    if (turn.sessionId === null)
      throw new Cp2Error(401, "auth_required", "The session that sent this message ended.");
    const sessionId = turn.sessionId;
    const turnRequest = turn.request;
    const body = JSON.stringify({
      conversationId: turnRequest.conversationId,
      clientMessageId: turnRequest.clientMessageId,
      content: turnRequest.content,
      agent: { businessId: turnRequest.businessId, message: turnRequest.message }
    });
    const request = new Request("https://edge.internal/v1/messages", {
      method: "POST",
      headers: { cookie: `grogoni_session=${sessionId}`, "content-type": "application/json" },
      body
    });
    const attempt: RequestAttempt = { independentWork: false };
    try {
      await runAttempt({
        request,
        path: "/v1/messages",
        url: new URL(request.url),
        payload: Buffer.from(body),
        attempt,
        ledger,
        turns: null,
        worker: async (store, pool) => {
          const processed = await store.createAgentConversationMessage({
            sessionId,
            conversationId: turnRequest.conversationId,
            clientMessageId: turnRequest.clientMessageId,
            ...(turnRequest.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: turnRequest.idempotencyKey }),
            content: turnRequest.content as Parameters<
              Cp2Store["createAgentConversationMessage"]
            >[0]["content"],
            businessId: turnRequest.businessId,
            message: turnRequest.message,
            ...(turnRequest.runtimeSessionId === undefined
              ? {}
              : { runtimeSessionId: turnRequest.runtimeSessionId }),
            replyRightAfterMessage: true
          });
          if (ledger.pending !== null) return null;
          await store.deliverPendingMessageNotifications({ messageId: processed.message.id });
          const reply = {
            ...processed.message,
            ...(processed.agentMessage === null ? {} : { agentMessage: processed.agentMessage }),
            runtime: processed.runtime,
            processing: processed.processing
          };
          // In this transaction: the reply and the turn's completion commit together, and a
          // run whose lease was taken over rolls its reply back.
          await completeAgentTurn(pool, turn.id, leaseToken, reply);
          return reply;
        }
      });
    } catch (error) {
      if (error instanceof Error && !(error instanceof AttemptNeedsModelCall))
        Object.assign(error, { independentWork: attempt.independentWork });
      throw error;
    }
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
        deliverConversationTask: async (task) => {
          if (!task.owner_user_id || task.payload.kind !== "agent" || !task.payload.conversation)
            return;
          const origin = task.payload.conversation;
          const internal = new Request(`https://grogoni.com/v1/conversations/${origin.id}`);
          await edgeDatabase.transaction(async (client) => {
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
              edgeDatabase.transaction(async (client) => {
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
          edgeDatabase.transaction((client) => loadDaemonConversationHistory(client, task)),
        authorizeConversation: async (request, conversationId) => {
          const path = `/v1/conversations/${conversationId}`;
          return edgeDatabase.transaction(async (client) => {
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
  const guestIntentRoutes = startGuestIntent(edgeDatabase.guestIntent);
  return {
    routes,
    inventory,
    /** POST /v1/guest/intent, outside any snapshot transaction; null for every other path. */
    guestIntentRoutes: async (request: Request, path: string) =>
      guestIntentRoutes === null ? null : guestIntentRoutes(request, path),
    /** Resolves once every background agent turn started in this isolate has finished. */
    settled: worker.settled,
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
