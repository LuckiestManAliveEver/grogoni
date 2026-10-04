import { type RuntimeModelProviderName } from "@grogoni/shared-types";
import { createMetrics, type Metrics } from "@grogoni/observability";
import { Pool } from "pg";
import { buildApi } from "./app.js";
import { readEnvironment } from "./config.js";
import { buildPgPoolConfig } from "./db-pool-config.js";
import {
  DEFAULT_DATABASE_STARTUP_RETRY,
  retryDatabaseStartup,
  retryInBackground,
  transientReason
} from "./db-startup-retry.js";
import { positiveIntegerFromEnv } from "@grogoni/resource-control";
import {
  createOllamaInferenceClient,
  createOllamaModelAdapter,
  type ModelRuntimeAdapter
} from "./inference/model-runtime.js";
import { OwnerNodeBroker } from "./inference/owner-node-broker.js";
import { readInferenceEnvironment } from "./inference/providers/environment.js";
import { createInferencePlatform } from "./inference/providers/platform.js";
import {
  assertInferenceSchema,
  createPostgresInferenceRepositories
} from "./inference/providers/postgres-repositories.js";
import { createMemoryInferenceRepositories } from "./inference/providers/repositories.js";
import { createMemoryRequestRateLimiter } from "./inference/providers/usage-policy.js";
import {
  startAccountDeletionRunner,
  type AccountDeletionRunner
} from "./cp2/account-deletion-runner.js";
import {
  startConversationRecycleBinRunner,
  type ConversationRecycleBinRunner
} from "./cp2/conversation-recycle-bin-runner.js";
import {
  startAgentOwnerCorrectionRetentionRunner,
  type AgentOwnerCorrectionRetentionRunner
} from "./cp2/agent-owner-correction-retention-runner.js";
import {
  startRuntimeExperienceRetentionRunner,
  type RuntimeExperienceRetentionRunner
} from "./cp2/runtime-experience-retention-runner.js";
import { readAccountDeletionProcessors } from "./cp2/account-deletion-processors.js";
import { createPostgresCp2Store } from "./cp2/postgres-store.js";
import { RETIRED_EXECUTION_FABRIC_TABLES } from "./cp2/retired-execution-fabric-tables.js";
import { RETIRED_LEGACY_BINDING_TABLES } from "./cp2/retired-legacy-binding-tables.js";
import { readBuildManifest } from "./build-manifest.js";
import { createCp2Store } from "./cp2/store.js";
import { createWebPushSender, readWebPushConfiguration } from "./cp2/push.js";
import { createEmailProviderFromEnvironment } from "./cp2/email-provider.js";
import { createNetworkInviteSenderFromEnvironment } from "./cp2/network-invite-provider.js";
import {
  startNotificationDeliveryRunner,
  type NotificationDeliveryRunner
} from "./cp2/notification-delivery-runner.js";
import {
  startConnectedMailboxSyncRunner,
  type ConnectedMailboxSyncRunner
} from "./cp2/connected-mailbox-sync-runner.js";
import {
  startGrogoniIdCooldownRunner,
  type GrogoniIdCooldownRunner
} from "./cp2/grogoniid-cooldown-runner.js";
import { createBinaryUploadPipelineFromEnvironment } from "./cp2/binary-upload-pipeline.js";
import { createChannelGatewayFromEnvironment } from "./messaging/channel-gateway.js";
import { createEmailMailboxProviderClient } from "./messaging/email-provider-client.js";
import { createIntervalRunner, type IntervalRunner } from "./cp2/interval-runner.js";
import {
  assertFulfillmentSchema,
  createPostgresFulfillmentService,
  fulfillmentDepsFromStore,
  type FulfillmentService
} from "./cp2/domains/fulfillment/service.js";

const config = readEnvironment();
// First measure: memory, CPU, and event-loop lag come from prom-client's Node defaults for free;
// HTTP/DB/model latency percentiles are computed at query time via histogram_quantile() over the
// histograms instrumented below. See docs/observability.md and docs/single-instance-store-ceiling.md
// ("monitor process RSS in production" - step 1 of that doc's recommended path).
const metrics = createMetrics({ serviceName: "api" });

const modelRuntimeAdapters = new Map<string, ModelRuntimeAdapter>();
let primaryInferenceAdapter: ModelRuntimeAdapter | undefined;
const client = createOllamaInferenceClient({
  baseUrl: config.ollamaBaseUrl,
  model: config.ollamaModel,
  timeoutMs: config.inferenceTimeoutMs
});
const adapter = instrumentModelAdapter(
  createOllamaModelAdapter({
    modelId: config.platformDefaultRuntime.modelId,
    ollamaModel: config.ollamaModel,
    client
  }),
  metrics
);
modelRuntimeAdapters.set(`local:${config.platformDefaultRuntime.modelId}`, adapter);
primaryInferenceAdapter = adapter;
const modelRuntimeAdapterResolver = (input: {
  modelId: string;
  executionTarget: ModelRuntimeAdapter["executionTarget"];
}) => modelRuntimeAdapters.get(`${input.executionTarget}:${input.modelId}`);
const cp2StoreMode = process.env.CP2_STORE?.trim().toLowerCase();
const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
const webPushConfiguration = readWebPushConfiguration();
const pushNotificationSender =
  webPushConfiguration === null ? undefined : createWebPushSender(webPushConfiguration);
const emailProvider = createEmailProviderFromEnvironment();
const messageWebBaseUrl = (process.env.WEB_PUBLIC_URL ?? "https://grogoni.com").trim();
const accountDeletionProcessors = readAccountDeletionProcessors();
const networkInviteSender = createNetworkInviteSenderFromEnvironment();
const binaryUploadPipeline = createBinaryUploadPipelineFromEnvironment();
const channelGateway = createChannelGatewayFromEnvironment();
const emailMailboxProviderClient = createEmailMailboxProviderClient();
const ownerNodeSigningSecret = process.env.INFERENCE_JOB_SIGNING_SECRET?.trim() ?? "";
if (config.inferenceOwnerNodeEnabled && ownerNodeSigningSecret.length < 32) {
  throw new Error(
    "INFERENCE_JOB_SIGNING_SECRET must contain at least 32 characters when owner-node inference is enabled."
  );
}
const ownerNodeBroker =
  !config.inferenceOwnerNodeEnabled || ownerNodeSigningSecret.length < 32
    ? undefined
    : new OwnerNodeBroker({
        signingSecret: ownerNodeSigningSecret,
        jobTimeoutMs: config.inferenceJobTimeoutMs
      });

if (process.env.NODE_ENV === "production" && cp2StoreMode !== "memory" && databaseUrl === "") {
  throw new Error("DATABASE_URL is required in production unless CP2_STORE=memory is explicit.");
}

const shouldUsePostgresStore =
  cp2StoreMode === "postgres" || (cp2StoreMode !== "memory" && databaseUrl !== "");

// Multi-provider inference router (docs/architecture/multi-provider-inference-implementation.md).
// Environment variables configure Grogoni-managed providers/credentials only; BYOK keys, provider
// overrides, usage telemetry and budgets are Postgres-authoritative on the module's own pool, the
// same own-pool shape corridor fulfillment uses. No provider is required to boot: with nothing
// configured, provider-routed models simply report CREDENTIAL_MISSING / unconfigured.
const inferenceEnvironment = readInferenceEnvironment(process.env);
// A flaky resolver or a Neon compute waking from suspend must not crash boot (db-startup-retry.ts).
const databaseStartupRetry = {
  ...DEFAULT_DATABASE_STARTUP_RETRY,
  maxAttempts: positiveIntegerFromEnv(
    "DB_STARTUP_MAX_ATTEMPTS",
    DEFAULT_DATABASE_STARTUP_RETRY.maxAttempts
  )
};
let inferencePool: Pool | undefined;
if (shouldUsePostgresStore) {
  inferencePool = new Pool(
    buildPgPoolConfig(config.databaseUrl, {
      max: positiveIntegerFromEnv("DB_INFERENCE_POOL_MAX", 2)
    })
  );
  metrics.instrumentPgPool(inferencePool, { poolName: "inference" });
  // pg-pool emits "error" when an idle client's connection dies (network reset, Neon compute
  // restart); without a listener that is an unhandled 'error' event and the process exits.
  inferencePool.on("error", (error) => {
    console.error("Unexpected PostgreSQL inference pool error.", error);
  });
  const schemaPool = inferencePool;
  await retryDatabaseStartup(
    "inference_schema",
    () => assertInferenceSchema(schemaPool),
    databaseStartupRetry
  );
}
const inferencePlatform = createInferencePlatform({
  environment: inferenceEnvironment,
  repositories:
    inferencePool === undefined
      ? createMemoryInferenceRepositories()
      : createPostgresInferenceRepositories(inferencePool),
  metrics,
  rateLimiter: createMemoryRequestRateLimiter(),
  // Callers pass already-redacted fields (inference-router.ts runs redactRecord first).
  log: (event, fields) => console.log({ event, ...fields })
});
// Background retries for boot work that may finish after startup; stopped on shutdown, and never
// started once shutdown has begun.
let backgroundRetriesStopped = false;
let stopCredentialKeyRotationRetry: (() => void) | undefined;
let stopInferenceRefreshRetry: (() => void) | undefined;
const backgroundRetry = { initialDelayMs: 5_000, maxDelayMs: 60_000 };
// Re-encrypt BYOK credentials still on an older INFERENCE_CREDENTIAL_KEYS version. Idempotent and
// off the boot path: a slow or failing rotation never delays or blocks startup, and a failed one
// keeps retrying in the background so credentials do not stay on the old key until a restart.
const rotateCredentialKeys = () =>
  inferencePlatform.rotateCredentialKeys().then((result) => {
    if (result.rotated > 0 || result.failed > 0) {
      console.log({ event: "inference.credential_keys_rotated", ...result });
    }
  });
void rotateCredentialKeys().catch((error: unknown) => {
  console.error({
    event: "inference.credential_key_rotation_failed",
    reason: error instanceof Error ? error.name : "unknown",
    code: transientReason(error) ?? (error as { code?: unknown } | null)?.code ?? null
  });
  if (backgroundRetriesStopped) return;
  stopCredentialKeyRotationRetry = retryInBackground(
    "inference_key_rotation",
    () => rotateCredentialKeys(),
    backgroundRetry
  );
});
// Loads the DB-configured providers. Boot may continue without them, but never silently for good:
// once the startup retries are exhausted the refresh keeps retrying in the background.
await retryDatabaseStartup(
  "inference_refresh",
  () => inferencePlatform.refresh(),
  databaseStartupRetry
).catch((error: unknown) => {
  console.error({
    event: "inference.provider_refresh_failed",
    reason: error instanceof Error ? error.name : "unknown",
    code: transientReason(error) ?? (error as { code?: unknown } | null)?.code ?? null
  });
  if (backgroundRetriesStopped) return;
  stopInferenceRefreshRetry = retryInBackground(
    "inference_refresh",
    () => inferencePlatform.refresh(),
    backgroundRetry
  );
});
const cp2StoreOptions = {
  channelGateway,
  zeroClawGateway: null,
  emailMailboxProviderClient,
  metrics,
  modelRuntimeAdapterResolver,
  inferencePlatform,
  platformDefaultRuntime: config.platformDefaultRuntime,
  ...(pushNotificationSender === undefined ? {} : { pushNotificationSender }),
  messageEmailNotificationSender:
    emailProvider.sendEncryptedMessageNotification.bind(emailProvider),
  ...(networkInviteSender === undefined ? {} : { networkInviteSender }),
  messageWebBaseUrl,
  workspaceDeliveryMaxFileBytes: config.workspaceDeliveryMaxFileBytes,
  ...(config.workspaceRoot === "" ? {} : { workspaceRoot: config.workspaceRoot }),
  ...(accountDeletionProcessors.length === 0 ? {} : { accountDeletionProcessors })
};

// Runtime resources remain provider-neutral and independently swappable. Deployments that promise
// zero-setup AI set INFERENCE_REQUIRED=true, making /health/ready fail unless the configured
// Vercel execution host can reach the selected model artifact.
// Corridor fulfillment is Postgres-authoritative (docs/architecture/corridor-fulfillment.md §5):
// its own instrumented pool, per-request transactions, and no participation in the in-memory
// snapshot. Memory mode gets no service, so its routes answer 503 fulfillment_requires_postgres.
// Its schema check runs alongside CP2 store hydration and is awaited before the service is built.
let fulfillmentPool: Pool | undefined;
let fulfillmentSchemaCheck: Promise<unknown> = Promise.resolve(null);
if (shouldUsePostgresStore) {
  fulfillmentPool = new Pool(
    buildPgPoolConfig(config.databaseUrl, {
      max: positiveIntegerFromEnv("DB_FULFILLMENT_POOL_MAX", 3)
    })
  );
  metrics.instrumentPgPool(fulfillmentPool, { poolName: "fulfillment" });
  // pg-pool emits "error" when an idle client's connection dies (network reset, Neon compute
  // restart); without a listener that is an unhandled 'error' event and the process exits.
  fulfillmentPool.on("error", (error) => {
    console.error("Unexpected PostgreSQL fulfillment pool error.", error);
  });
  const schemaPool = fulfillmentPool;
  fulfillmentSchemaCheck = retryDatabaseStartup(
    "fulfillment_schema",
    () => assertFulfillmentSchema(schemaPool),
    databaseStartupRetry
  ).then(
    () => null,
    (error: unknown) => error
  );
}
const cp2Store = await createCp2StoreOrExplainSchemaFailure();
// Cp2Store attaches its database-backed model catalog to the provider router during construction.
// Resolve the default only after that late binding, otherwise a provider-routed default appears
// disabled to readiness even though both its catalog model and provider are configured.
primaryInferenceAdapter ??= inferencePlatform.adapterFor({
  modelId: config.platformDefaultRuntime.modelId,
  executionTarget: config.platformDefaultRuntime.executionTarget
});
let fulfillmentService: FulfillmentService | undefined;
if (fulfillmentPool !== undefined) {
  const fulfillmentSchemaError = await fulfillmentSchemaCheck;
  if (fulfillmentSchemaError !== null) throw fulfillmentSchemaError;
  fulfillmentService = createPostgresFulfillmentService({
    pool: fulfillmentPool,
    deps: fulfillmentDepsFromStore(cp2Store),
    idempotencyRetentionHours: positiveIntegerFromEnv(
      "FULFILLMENT_IDEMPOTENCY_RETENTION_HOURS",
      24
    ),
    deliverOutboxEvent: (event) => cp2Store.deliverFulfillmentNotification(event)
  });
  // Orders enter fulfillment when they become deliverable (docs/architecture/corridor-fulfillment.md
  // §5.3). The reconciler runner below catches any intake this misses.
  const intakeService = fulfillmentService;
  cp2Store.setFulfillmentIntakeListener((input) => intakeService.intakeOrder(input));
  // A member who leaves or loses the delivery role is released from their open trips (§16).
  cp2Store.setMembershipChangedListener((input) => intakeService.releaseDriverAssignments(input));
}
const apiOptions = {
  allowedCorsOrigins: config.allowedCorsOrigins,
  bodyLimit: Math.max(
    15_000_000,
    Math.ceil((config.workspaceDeliveryMaxFileBytes * 4) / 3) + 1_000_000
  ),
  inferenceRequired: config.inferenceRequired,
  metrics,
  ...(config.metricsAuthToken === "" ? {} : { metricsAuthToken: config.metricsAuthToken }),
  cp2: {
    store: cp2Store,
    emailProvider,
    webPublicUrl: messageWebBaseUrl,
    telegramBotUsername: "",
    ...(ownerNodeBroker === undefined ? {} : { ownerNodeBroker }),
    ...(binaryUploadPipeline === undefined ? {} : { binaryUploadPipeline }),
    ...(fulfillmentService === undefined ? {} : { fulfillmentService }),
    ...(webPushConfiguration === null ? {} : { vapidPublicKey: webPushConfiguration.publicKey })
  }
};
const app = buildApi(
  isHealthyStore(cp2Store)
    ? {
        ...apiOptions,
        databaseHealth: () => cp2Store.health(),
        ...(hasInferenceDiagnostic()
          ? { agentRuntimeDiagnostic: (runInference: boolean) => runtimeDiagnostic(runInference) }
          : {}),
        ...(isFlushableStore(cp2Store) ? { mutationPersistenceFlush: () => cp2Store.flush() } : {})
      }
    : {
        ...apiOptions,
        ...(hasInferenceDiagnostic()
          ? { agentRuntimeDiagnostic: (runInference: boolean) => runtimeDiagnostic(runInference) }
          : {}),
        ...(isFlushableStore(cp2Store) ? { mutationPersistenceFlush: () => cp2Store.flush() } : {})
      }
);

const buildManifest = readBuildManifest();
app.log.info(
  {
    event: "runtime_schema_boot",
    runtimeArchitecture: "native",
    store: shouldUsePostgresStore ? "postgres" : "memory",
    schemaCompatibility: "verified",
    redisConfigured: false,
    ...(buildManifest === null
      ? {}
      : { gitCommitSha: buildManifest.gitCommitSha, buildTimestamp: buildManifest.buildTimestamp })
  },
  "Runtime schema boot diagnostic."
);

let accountDeletionRunner: AccountDeletionRunner | null = null;
let notificationDeliveryRunner: NotificationDeliveryRunner | null = null;
let connectedMailboxSyncRunner: ConnectedMailboxSyncRunner | null = null;
let grogoniIdCooldownRunner: GrogoniIdCooldownRunner | null = null;
let conversationRecycleBinRunner: ConversationRecycleBinRunner | null = null;
let agentOwnerCorrectionRetentionRunner: AgentOwnerCorrectionRetentionRunner | null = null;
let runtimeExperienceRetentionRunner: RuntimeExperienceRetentionRunner | null = null;
let fulfillmentIdempotencyRetentionRunner: IntervalRunner<number> | null = null;
let fulfillmentIntakeReconcileRunner: IntervalRunner<{
  takenIn: number;
  orphaned: number;
  failed: number;
}> | null = null;
let fulfillmentDispatchEvaluationRunner: IntervalRunner<{
  evaluated: number;
  skipped: number;
  failed: number;
}> | null = null;
let fulfillmentOutboxRunner: IntervalRunner<{ delivered: number; failed: number }> | null = null;
const connectedMailboxSyncIntervalMs = readOptionalPositiveInteger(
  process.env.CONNECTED_MAILBOX_SYNC_INTERVAL_MS
);
const grogoniIdCooldownIntervalMs = readOptionalPositiveInteger(
  process.env.GROGONI_ID_COOLDOWN_RUNNER_INTERVAL_MS
);
const grogoniIdCooldownMs = readOptionalPositiveInteger(process.env.GROGONI_ID_COOLDOWN_MS);
app.addHook("onClose", async () => {
  backgroundRetriesStopped = true;
  stopCredentialKeyRotationRetry?.();
  stopInferenceRefreshRetry?.();
  await grogoniIdCooldownRunner?.stop();
  await connectedMailboxSyncRunner?.stop();
  await notificationDeliveryRunner?.stop();
  await accountDeletionRunner?.stop();
  await conversationRecycleBinRunner?.stop();
  await agentOwnerCorrectionRetentionRunner?.stop();
  await runtimeExperienceRetentionRunner?.stop();

  await fulfillmentIdempotencyRetentionRunner?.stop();
  await fulfillmentIntakeReconcileRunner?.stop();
  await fulfillmentDispatchEvaluationRunner?.stop();
  await fulfillmentOutboxRunner?.stop();
  await fulfillmentPool?.end();
  await inferencePool?.end();
  if (isClosableStore(cp2Store)) {
    await cp2Store.close();
  }
});

if (process.env.ENABLE_CONNECTED_MAILBOX_SYNC_RUNNER !== "false") {
  connectedMailboxSyncRunner = startConnectedMailboxSyncRunner({
    store: cp2Store,
    timeScheduledJob: metrics.timeScheduledJob,
    ...(connectedMailboxSyncIntervalMs === undefined
      ? {}
      : { intervalMs: connectedMailboxSyncIntervalMs }),
    onResult: (result) => {
      if (result.checked > 0) {
        app.log.info({ event: "mailbox_background_sync_completed", ...result });
      }
    },
    onError: (error) => app.log.error({ error }, "Connected mailbox sync run failed.")
  });
}

if (process.env.ENABLE_NOTIFICATION_DELIVERY_RUNNER !== "false") {
  notificationDeliveryRunner = startNotificationDeliveryRunner({
    store: cp2Store,
    timeScheduledJob: metrics.timeScheduledJob,
    onResult: (result) => {
      if (result.checked > 0) {
        app.log.info({ result }, "Message notification delivery run completed.");
      }
    },
    onError: (error) => app.log.error({ error }, "Message notification delivery run failed.")
  });
}

if (process.env.ENABLE_CONVERSATION_RECYCLE_BIN_RUNNER !== "false") {
  conversationRecycleBinRunner = startConversationRecycleBinRunner({
    store: cp2Store,
    timeScheduledJob: metrics.timeScheduledJob,
    onResult: (purged) => {
      if (purged > 0) {
        app.log.info(
          { event: "conversation_recycle_bin_purged", purged },
          "Recycle bin purge run completed."
        );
      }
    },
    onError: (error) => app.log.error({ error }, "Recycle bin purge run failed.")
  });
}

if (process.env.ENABLE_AGENT_OWNER_CORRECTION_RETENTION_RUNNER !== "false") {
  agentOwnerCorrectionRetentionRunner = startAgentOwnerCorrectionRetentionRunner({
    store: cp2Store,
    timeScheduledJob: metrics.timeScheduledJob,
    onResult: (disabled) => {
      if (disabled > 0) {
        app.log.info(
          { event: "agent_owner_correction_retention_swept", disabled },
          "Owner correction retention sweep completed."
        );
      }
    },
    onError: (error) => app.log.error({ error }, "Owner correction retention sweep failed.")
  });
}

if (process.env.ENABLE_RUNTIME_EXPERIENCE_RETENTION_RUNNER !== "false") {
  runtimeExperienceRetentionRunner = startRuntimeExperienceRetentionRunner({
    store: cp2Store,
    timeScheduledJob: metrics.timeScheduledJob,
    onResult: (deprecated) => {
      if (deprecated > 0) {
        app.log.info(
          { event: "runtime_experience_retention_swept", deprecated },
          "Runtime experience retention sweep completed."
        );
      }
    },
    onError: (error) => app.log.error({ error }, "Runtime experience retention sweep failed.")
  });
}

if (fulfillmentService !== undefined) {
  const service = fulfillmentService;
  fulfillmentIdempotencyRetentionRunner = createIntervalRunner({
    job: "fulfillment_idempotency_retention",
    intervalMs: positiveIntegerFromEnv("FULFILLMENT_IDEMPOTENCY_PURGE_INTERVAL_MS", 3_600_000),
    run: () => service.purgeExpiredIdempotencyRecords({}),
    timeScheduledJob: metrics.timeScheduledJob,
    onResult: (purged) => {
      if (purged > 0) {
        app.log.info(
          { event: "fulfillment_idempotency_records_purged", purged },
          "Expired fulfillment idempotency records purged."
        );
      }
    },
    onError: (error) => app.log.error({ error }, "Fulfillment idempotency retention sweep failed.")
  });
  fulfillmentIntakeReconcileRunner = createIntervalRunner({
    job: "fulfillment_intake_reconcile",
    intervalMs: positiveIntegerFromEnv("FULFILLMENT_INTAKE_RECONCILE_INTERVAL_MS", 300_000),
    run: () => service.reconcileIntake(),
    timeScheduledJob: metrics.timeScheduledJob,
    onResult: (result) => {
      if (result.takenIn + result.orphaned + result.failed > 0) {
        app.log.info(
          { event: "fulfillment_intake_reconciled", ...result },
          "Fulfillment intake reconciled."
        );
      }
    },
    onError: (error) => app.log.error({ error }, "Fulfillment intake reconcile failed.")
  });
  fulfillmentDispatchEvaluationRunner = createIntervalRunner({
    job: "fulfillment_dispatch_evaluation",
    intervalMs: positiveIntegerFromEnv("FULFILLMENT_DISPATCH_EVALUATION_INTERVAL_MS", 300_000),
    run: () => service.evaluateDueDispatches(),
    timeScheduledJob: metrics.timeScheduledJob,
    onResult: (result) => {
      if (result.evaluated + result.failed > 0) {
        app.log.info(
          { event: "fulfillment_dispatch_evaluated", ...result },
          "Due corridor dispatch policies evaluated."
        );
      }
    },
    onError: (error) => app.log.error({ error }, "Fulfillment dispatch evaluation failed.")
  });
  fulfillmentOutboxRunner = createIntervalRunner({
    job: "fulfillment_outbox_delivery",
    intervalMs: positiveIntegerFromEnv("FULFILLMENT_OUTBOX_INTERVAL_MS", 30_000),
    run: () => service.deliverPendingOutboxEvents(),
    timeScheduledJob: metrics.timeScheduledJob,
    onResult: (result) => {
      if (result.delivered + result.failed > 0) {
        app.log.info(
          { event: "fulfillment_outbox_processed", ...result },
          "Fulfillment outbox processed."
        );
      }
    },
    onError: (error) => app.log.error({ error }, "Fulfillment outbox delivery failed.")
  });
}

if (process.env.ENABLE_GROGONI_ID_COOLDOWN_RUNNER !== "false") {
  grogoniIdCooldownRunner = startGrogoniIdCooldownRunner({
    store: cp2Store,
    timeScheduledJob: metrics.timeScheduledJob,
    ...(grogoniIdCooldownIntervalMs === undefined
      ? {}
      : { intervalMs: grogoniIdCooldownIntervalMs }),
    ...(grogoniIdCooldownMs === undefined ? {} : { cooldownMs: grogoniIdCooldownMs }),
    onResult: (released) => {
      if (released > 0) {
        app.log.info(
          { event: "grogoni_id_cooldown_released", released },
          "Retired grogoniIds released."
        );
      }
    },
    onError: (error) => app.log.error({ error }, "GrogoniId cooldown run failed.")
  });
}

try {
  await app.listen({
    host: config.apiHost,
    port: config.apiPort
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

const shutdownGraceMs = readOptionalPositiveInteger(process.env.SHUTDOWN_GRACE_MS) ?? 25_000;
let shutdownPromise: Promise<void> | undefined;
const shutdown = (signal: NodeJS.Signals) => {
  if (shutdownPromise !== undefined) return;
  app.log.info({ signal, shutdownGraceMs }, "Shutdown signal received; draining API server.");
  const forceExitTimer = setTimeout(() => {
    app.log.error({ signal, shutdownGraceMs }, "Graceful shutdown timed out; exiting.");
    process.exit(1);
  }, shutdownGraceMs);
  forceExitTimer.unref();
  shutdownPromise = app
    .close()
    .then(() => {
      clearTimeout(forceExitTimer);
      app.log.info({ signal }, "API server drained and closed.");
      process.exit(0);
    })
    .catch((error: unknown) => {
      clearTimeout(forceExitTimer);
      app.log.error({ error, signal }, "API server shutdown failed.");
      process.exit(1);
    });
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

if (process.env.ENABLE_ACCOUNT_DELETION_RUNNER === "true") {
  accountDeletionRunner = startAccountDeletionRunner({
    store: cp2Store,
    timeScheduledJob: metrics.timeScheduledJob,
    onResult: (result) => app.log.info({ result }, "Account deletion purge completed."),
    onError: (error) => app.log.error({ error }, "Account deletion purge failed.")
  });
}

// Structurally, nothing in normalizedCollections (postgres-store.ts) names a retired Execution
// Fabric table any more, so this branch should be unreachable in a correctly built process. It
// exists as a defense-in-depth diagnostic: if a stale or reverted build somehow ships a query
// against one of those tables anyway, this turns an opaque `relation ... does not exist` (42P01)
// into a message that names the real problem instead of one query failure among many. See
// docs/architecture/native-runtime-deployment.md.
async function createCp2StoreOrExplainSchemaFailure() {
  try {
    return shouldUsePostgresStore
      ? await retryDatabaseStartup(
          "cp2_store",
          () =>
            createPostgresCp2Store({
              databaseUrl: config.databaseUrl,
              ...cp2StoreOptions
            }),
          databaseStartupRetry
        )
      : createCp2Store(cp2StoreOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retiredFabricTable = RETIRED_EXECUTION_FABRIC_TABLES.find((table) =>
      message.includes(table)
    );
    if (retiredFabricTable !== undefined) {
      throw new Error(
        `Native runtime schema compatibility failure: expected cp2_native_runtime_bindings, ` +
          `retired ${retiredFabricTable} must not be used. This process is running a build that is ` +
          `stale relative to the deployed schema (infra/db/migrations/065_retire_execution_fabric.sql); ` +
          `redeploy from a clean build.`,
        { cause: error }
      );
    }
    const retiredBindingTable = RETIRED_LEGACY_BINDING_TABLES.find((table) =>
      message.includes(table)
    );
    if (retiredBindingTable !== undefined) {
      throw new Error(
        `Native runtime schema compatibility failure: expected cp2_native_runtime_bindings, ` +
          `retired ${retiredBindingTable} must not be used. This process is running a build that ` +
          `is stale relative to the deployed schema (infra/db/migrations/` +
          `076_drop_legacy_agent_model_bindings.sql); redeploy from a clean build.`,
        { cause: error }
      );
    }
    throw error;
  }
}

// Wraps every call the adapter can make - canRun/healthCheck never throw (they catch internally
// and return an unavailable result), only generate() can - so "outcome" here means "the request
// completed" rather than "inference succeeded"; that distinction matters when reading the metric.
function instrumentModelAdapter(
  adapter: ModelRuntimeAdapter,
  metrics: Metrics
): ModelRuntimeAdapter {
  const labels = { provider: adapter.provider, executionTarget: adapter.executionTarget };
  return {
    provider: adapter.provider,
    executionTarget: adapter.executionTarget,
    canRun: (context) =>
      metrics.timeModelRequest({ ...labels, model: context.modelId }, () =>
        adapter.canRun(context)
      ),
    healthCheck: (context) =>
      metrics.timeModelRequest({ ...labels, model: context.modelId }, () =>
        adapter.healthCheck(context)
      ),
    generate: (input) =>
      metrics.timeModelRequest({ ...labels, model: input.context.modelId }, () =>
        adapter.generate(input)
      )
  };
}

function isClosableStore(store: unknown): store is { close: () => Promise<void> } {
  return typeof (store as { close?: unknown }).close === "function";
}

function readOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("CONNECTED_MAILBOX_SYNC_INTERVAL_MS must be a positive integer.");
  }
  return parsed;
}

function isHealthyStore(
  store: unknown
): store is { health: () => Promise<Record<string, unknown>> } {
  return typeof (store as { health?: unknown }).health === "function";
}

function isFlushableStore(store: unknown): store is { flush: () => Promise<void> } {
  return typeof (store as { flush?: unknown }).flush === "function";
}

function hasInferenceDiagnostic(): boolean {
  return primaryInferenceAdapter !== undefined;
}

async function runtimeDiagnostic(runInference: boolean) {
  if (primaryInferenceAdapter !== undefined) {
    const context = {
      agentId: "health-check",
      shopId: "health-check",
      modelId: config.platformDefaultRuntime.modelId
    };
    const result = runInference
      ? await primaryInferenceAdapter.healthCheck(context)
      : await primaryInferenceAdapter.canRun(context);
    return {
      provider: primaryInferenceAdapter.provider as RuntimeModelProviderName,
      status: result.available ? ("ready" as const) : ("unavailable" as const),
      model: config.platformDefaultRuntime.modelId,
      modelAvailable: result.available,
      inferenceAvailable: runInference ? result.available : null,
      errorCode: result.errorCode,
      checkedAt: new Date().toISOString()
    };
  }
  return {
    provider: "llama.cpp" as const,
    status: "unavailable" as const,
    model: config.platformDefaultRuntime.modelId,
    modelAvailable: false,
    inferenceAvailable: false,
    errorCode: "INFERENCE_SERVICE_UNCONFIGURED",
    checkedAt: new Date().toISOString()
  };
}
