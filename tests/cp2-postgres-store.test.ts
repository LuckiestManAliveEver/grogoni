import { randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_SYNC_COLLECTIONS,
  isAccountSyncCollection,
  type AgentRouteSummary,
  type AiModelSummary,
  type BetaFeatureFlagSummary,
  type BetaReadinessReportSummary,
  type BetaSupportTicketSummary,
  type BusinessNotificationSummary,
  type BuyFeedSummary,
  type ConversationMessageSummary,
  type ConversationView,
  type CountryTaxConfigSummary,
  type DeviceTrustSummary,
  type DocumentImportConfirmResult,
  type DocumentImportJobSummary,
  type InvoiceSummary,
  type LaunchChecklistItemSummary,
  type LaunchIncidentSummary,
  type LaunchReadinessReportSummary,
  type LaunchSettingsSummary,
  type LogisticsSummary,
  type NetworkGraphSummary,
  type NotificationInbox,
  type ProductCaptureJobSummary,
  type PurchaseReceiptSummary,
  type PushSubscriptionSummary,
  type ReceiptOCRJobSummary,
  type SalesAgentSummary,
  type StatusBroadcastSummary,
  type SupplierBusinessCardSummary,
  type UnifiedCheckoutSummary,
  type VerificationTierSummary
} from "../packages/shared-types/src/index";
import { buildApi } from "../services/api/src/app";
import {
  buildNormalizedSnapshotSql,
  createPostgresCp2Store,
  normalizedCollections,
  saveCollectionRecords,
  saveRelationalCoreRecords,
  upsertAccountSyncChangesBulk
} from "../services/api/src/cp2/postgres-store";
import { Cp2Store, readSessionCookie, sessionCookieName } from "../services/api/src/cp2/store";
import type { ModelArtifactStore } from "../services/api/src/inference/model-artifact-store";
import {
  createVercelInferenceClient,
  createVercelModelAdapter
} from "../services/api/src/inference/model-runtime";
import { postgresPersistenceQueueScenarios } from "./ai-eval/postgres-persistence-queue-scenarios";

interface SqlExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ): Promise<{ rows: T[] }>;
}

interface TestPool extends SqlExecutor {
  connect(): Promise<TestPoolClient>;
  end(): Promise<void>;
}

interface TestPoolClient extends SqlExecutor {
  release(destroy?: boolean): void;
}

const requireApiDependency = createRequire(resolve(process.cwd(), "services/api/package.json"));
const { Pool } = requireApiDependency("pg") as {
  Pool: new (options: { connectionString: string }) => TestPool;
};

interface CreateBusinessResponse {
  business: {
    id: string;
    grogoniId: string;
  };
}

interface ProductResponse {
  id: string;
  name: string;
}

interface SyncPageResponse {
  accountId: string;
  nextCursor: string;
  changes: Array<{ accountId: string; collection: string }>;
}

interface McpTokenResponse {
  accessToken: string;
  token: { id: string };
}

const usedTestTags = new Set<string>();
/**
 * Five random digits, unique within this run, for building `+2547${tag}NNN` test phone numbers that
 * do not collide with accounts left in a reused development database by earlier runs.
 */
function uniqueTestTag(): string {
  for (;;) {
    const tag = String(randomInt(0, 100_000)).padStart(5, "0");
    if (!usedTestTags.has(tag)) {
      usedTestTags.add(tag);
      return tag;
    }
  }
}

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres("CP2 Postgres store", () => {
  it(
    "boots createPostgresCp2Store/loadNormalizedSnapshot against the post-065 schema without " +
      "querying any retired Execution Fabric table (regression for the Render startup crash: " +
      'error: relation "cp2_model_preferences" does not exist, code 42P01)',
    async () => {
      expect(databaseUrl).toBeDefined();
      const connectionString = databaseUrl ?? "";
      const pool = new Pool({ connectionString });
      try {
        const retiredTables = await pool.query<{ table_name: string }>(
          `
            select table_name from information_schema.tables
            where table_schema = 'public'
              and table_name in ('cp2_model_preferences', 'cp2_runtime_hosts', 'cp2_runtime_model_installations')
          `
        );
        expect(retiredTables.rows).toEqual([]);

        // If loadNormalizedSnapshot (called internally by createPostgresCp2Store) still queried a
        // table migration 065 dropped, this call would reject with Postgres error 42P01 - exactly
        // the production crash this test guards against.
        const store = await createPostgresCp2Store({ databaseUrl: connectionString });
        await store.close();
      } finally {
        await pool.end();
      }
    }
  );

  it("persists platform catalog upserts and removals through the Postgres proxy", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    const phone = `+254799${Date.now().toString().slice(-6)}`;
    const modelId = `platform-catalog-persistence-${randomUUID()}`;
    let store = await createPostgresCp2Store({ databaseUrl: connectionString });
    let accountId: string | null = null;

    try {
      const actor = store.continueWithChannelPin({
        channel: "phone",
        destination: phone,
        pin: "7421"
      });
      accountId = actor.account.id;
      await store.flush();
      await store.close();

      const grant = {
        id: actor.account.id,
        accountId: actor.account.id,
        grantedAt: new Date().toISOString(),
        grantedBy: "cp2-postgres-store-test"
      };
      await pool.query(
        `insert into cp2_platform_operators (entity_id, account_id, record, updated_at)
         values ($1, $1, $2::jsonb, now())`,
        [actor.account.id, JSON.stringify(grant)]
      );

      store = await createPostgresCp2Store({ databaseUrl: connectionString });
      const model: AiModelSummary = {
        id: modelId,
        label: "Persistence regression model",
        provider: "local",
        description: "Proves platform catalog writes reach PostgreSQL.",
        capabilities: ["chat"],
        available: true,
        source: "builtin",
        format: "remote",
        license: null,
        licenseUrl: null,
        modelCardUrl: null,
        downloadUrl: null,
        fileName: null,
        fileSizeBytes: null,
        minimumMemoryGb: null,
        recommended: false,
        contextWindow: null
      };
      store.upsertModelCatalogEntry({ sessionId: actor.session.id, model });
      await store.flush();

      const persisted = await pool.query<{ record: AiModelSummary }>(
        "select record from cp2_model_catalog where entity_id = $1",
        [modelId]
      );
      expect(persisted.rows[0]?.record).toMatchObject({ id: modelId, label: model.label });

      store.removeModelCatalogEntry({ sessionId: actor.session.id, modelId });
      await store.flush();
      const removed = await pool.query(
        "select record from cp2_model_catalog where entity_id = $1",
        [modelId]
      );
      expect(removed.rows).toHaveLength(0);
    } finally {
      await store.close().catch(() => undefined);
      if (accountId !== null) {
        await pool.query("delete from cp2_platform_operators where entity_id = $1", [accountId]);
      }
      await pool.end();
    }
  }, 20_000);

  it("persists passkey ceremony creation without replacing the application snapshot", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const pool = new Pool({ connectionString });
    const sentinelId = randomUUID();
    let ceremonyId: string | null = null;

    try {
      const now = new Date();
      const sentinel = {
        id: sentinelId,
        kind: "authentication",
        purpose: "login",
        accountId: null,
        challenge: "targeted-write-sentinel",
        webauthnUserId: null,
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        createdAt: now.toISOString()
      };
      await pool.query(
        `
          insert into cp2_passkey_ceremonies
            (entity_id, business_id, account_id, user_id, parent_id, record, updated_at)
          values ($1, null, null, null, null, $2::jsonb, now())
        `,
        [sentinelId, JSON.stringify(sentinel)]
      );

      const result = await store.beginPasskeyAuthentication({
        rpId: "localhost",
        purpose: "pin_recovery"
      });
      ceremonyId = result.ceremonyId;
      await store.flush();

      const persisted = await pool.query<{ entity_id: string }>(
        "select entity_id from cp2_passkey_ceremonies where entity_id = any($1::text[]) order by entity_id",
        [[sentinelId, ceremonyId]]
      );
      expect(persisted.rows.map((row) => row.entity_id).sort()).toEqual(
        [sentinelId, ceremonyId].sort()
      );
      expect((await store.health()).persistenceQueue).toMatchObject({
        status: "ok",
        pendingCount: 0,
        queuedCount: 0,
        active: false,
        activeOperation: null,
        lastWaitDurationMs: expect.any(Number),
        lastRunDurationMs: expect.any(Number),
        lastCompletedAt: expect.any(String)
      });
    } finally {
      await pool.query("delete from cp2_passkey_ceremonies where entity_id = any($1::text[])", [
        [sentinelId, ...(ceremonyId === null ? [] : [ceremonyId])]
      ]);
      await pool.end();
      await store.close();
    }
  }, 15_000);

  for (const scenario of postgresPersistenceQueueScenarios) {
    it(`coalesces snapshot persistence: ${scenario.name}`, async () => {
      expect(databaseUrl).toBeDefined();
      const connectionString = databaseUrl ?? "";
      const store = await createPostgresCp2Store({ databaseUrl: connectionString });
      const app = buildApi({ cp2: { store } });
      const pool = new Pool({ connectionString });
      const lockClient = await pool.connect();
      let lockHeld = false;

      try {
        const owner = await createOwnerBusiness(app, `254709${Date.now().toString().slice(-6)}`);
        await store.flush();
        const sessionId = readSessionCookie(owner.sessionCookie);
        expect(sessionId).not.toBeNull();

        await lockClient.query("select pg_advisory_lock(hashtext('grogoni.cp2.normalized_store'))");
        lockHeld = true;

        store.updateGrogoniSessionContext({
          sessionId,
          mode: "seller",
          activeShopId: owner.business.id,
          activeSurface: "owner-controls"
        });
        await waitUntil(async () => (await store.health()).persistenceQueue.active);

        for (let index = 0; index < scenario.mutationsWhileSnapshotRuns; index += 1) {
          store.updateGrogoniSessionContext({
            sessionId,
            mode: "seller",
            activeShopId: owner.business.id,
            activeSurface: index % 2 === 0 ? "catalogue" : "owner-controls"
          });
        }

        const blockedHealth = await store.health();
        expect(blockedHealth.persistenceQueue.pendingCount).toBeLessThanOrEqual(
          scenario.maximumPendingSnapshots
        );
        expect(blockedHealth.persistenceQueue).toMatchObject({
          active: true,
          activeOperation: "snapshot",
          queuedCount: 0
        });

        await lockClient.query("select pg_advisory_unlock(hashtext('grogoni.cp2.normalized_store'))");
        lockHeld = false;
        await store.flush();

        const finalSnapshot = store.snapshot();
        const ownerAccountId = finalSnapshot.sessions.find(
          (session) => session.id === sessionId
        )?.accountId;
        const finalContext = finalSnapshot.sessionContexts.find(
          (context) => context.accountId === ownerAccountId
        );
        expect(finalContext).toBeDefined();
        const persisted = await pool.query<{ record: { sessionVersion: number } }>(
          "select record from cp2_session_contexts where entity_id = $1",
          [`${finalContext!.accountId}:${finalContext!.conversationId}`]
        );
        expect(persisted.rows[0]?.record.sessionVersion).toBe(finalContext!.sessionVersion);
        expect((await store.health()).persistenceQueue).toMatchObject({
          status: "ok",
          pendingCount: 0,
          queuedCount: 0,
          active: false
        });
      } finally {
        if (lockHeld) {
          await lockClient
            .query("select pg_advisory_unlock(hashtext('grogoni.cp2.normalized_store'))")
            .catch(() => undefined);
        }
        lockClient.release();
        await pool.end();
        await app.close();
        await store.close();
      }
    }, 20_000);
  }

  it("persists a registered passkey credential across store restarts", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const uniquePhone = `254708${Date.now().toString().slice(-6)}`;

    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const app = buildApi({ cp2: { store }, mutationPersistenceFlush: () => store.flush() });
    const { sessionCookie } = await createOwnerBusiness(app, uniquePhone);
    const sessionId = readSessionCookie(sessionCookie);
    expect(sessionId).not.toBeNull();

    const snapshot = store.snapshot();
    const ownerSession = snapshot.sessions.find((candidate) => candidate.id === sessionId);
    expect(ownerSession).toBeDefined();
    const ownerAccount = snapshot.accounts.find(
      (candidate) => candidate.id === ownerSession!.accountId
    );
    const ownerUser = snapshot.users.find((candidate) => candidate.accountId === ownerAccount?.id);
    expect(ownerAccount).toBeDefined();
    expect(ownerUser).toBeDefined();
    const credentialId = `postgres-passkey-${Date.now()}`;
    snapshot.passkeys = [
      ...(snapshot.passkeys ?? []),
      {
        id: credentialId,
        accountId: ownerAccount!.id,
        userId: ownerUser!.id,
        webauthnUserId: "postgres-webauthn-user",
        publicKey: "AQID",
        counter: 0,
        label: "Postgres Passkey (unsaved)",
        deviceType: "multiDevice",
        backedUp: true,
        transports: ["internal", "hybrid"],
        createdAt: new Date().toISOString(),
        lastUsedAt: null
      }
    ];
    // hydrateSnapshot() bypasses the Postgres persistence proxy's method-interception, so the
    // injected passkey above is in-memory only until a real intercepted mutating method call
    // (renamePasskey, listed in postgres-store.ts's mutatingMethodNames) triggers a full-snapshot
    // persist that picks up the current in-memory state, passkey included.
    store.hydrateSnapshot(snapshot);
    store.renamePasskey({ sessionId, credentialId, label: "Postgres Passkey" });

    await store.flush();
    await app.close();

    const restoredStore = await createPostgresCp2Store({ databaseUrl: connectionString });
    const restoredApp = buildApi({
      cp2: { store: restoredStore },
      mutationPersistenceFlush: () => restoredStore.flush()
    });

    const listed = await getJson<{ passkeys: Array<{ id: string; label: string }> }>(
      restoredApp,
      "/auth/passkeys",
      sessionCookie
    );
    expect(listed.passkeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: credentialId, label: "Postgres Passkey" })
      ])
    );

    await restoredApp.close();
  }, 30_000);

  it("persists an OAuth-linked identity and OAuth session across store restarts", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const unique = Date.now().toString();
    const uniqueEmail = `oauth-user-${unique}@example.test`;
    const uniqueState = `postgres-oauth-state-${unique}`;
    const uniqueCsrfToken = `postgres-csrf-token-${unique}`;

    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const app = buildApi({ cp2: { store }, mutationPersistenceFlush: () => store.flush() });

    const authResult = store.authenticateSocialProfile({
      provider: "google",
      email: uniqueEmail,
      displayName: "OAuth Tester"
    });
    const sessionCookie = `${sessionCookieName}=${authResult.session.id}`;

    const oauthSession = store.beginOAuthSession({
      accountSessionId: null,
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      codeChallenge: "postgres-code-challenge",
      codeVerifier: "postgres-code-verifier",
      csrfToken: uniqueCsrfToken,
      provider: "google",
      redirectUri: "https://grogoni.com/auth/oauth/google/callback",
      state: uniqueState
    });

    await store.flush();
    await app.close();

    const restoredStore = await createPostgresCp2Store({ databaseUrl: connectionString });
    const restoredApp = buildApi({
      cp2: { store: restoredStore },
      mutationPersistenceFlush: () => restoredStore.flush()
    });

    const listed = await getJson<{
      accounts: Array<{ id: string; provider: string; email: string | null }>;
    }>(restoredApp, "/auth/accounts", sessionCookie);
    expect(listed.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "google",
          email: uniqueEmail
        })
      ])
    );

    expect(oauthSession.state).toBe(uniqueState);
    const restoredExchangeData = restoredStore.getOAuthExchangeData({
      provider: "google",
      state: uniqueState,
      csrfToken: uniqueCsrfToken
    });
    expect(restoredExchangeData).toEqual({
      codeVerifier: "postgres-code-verifier",
      redirectUri: "https://grogoni.com/auth/oauth/google/callback"
    });

    await restoredApp.close();
  }, 30_000);

  it("persists an unverified OTP challenge across store restarts and completes it afterward", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const unique = Date.now().toString();
    const uniqueEmail = `otp-user-${unique}@example.test`;

    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const app = buildApi({ cp2: { store }, mutationPersistenceFlush: () => store.flush() });

    const otpResponse = await postJson<{
      challengeId: string;
      destination: string;
      devOtp: string;
    }>(app, "/auth/otp/request", { channel: "email", destination: uniqueEmail });

    await store.flush();
    await app.close();

    const restoredStore = await createPostgresCp2Store({ databaseUrl: connectionString });
    const restoredApp = buildApi({
      cp2: { store: restoredStore },
      mutationPersistenceFlush: () => restoredStore.flush()
    });

    const verifyResponse = await postJson<{
      account: { id: string };
      session: { id: string };
    }>(restoredApp, "/auth/otp/verify", {
      challengeId: otpResponse.challengeId,
      code: otpResponse.devOtp
    });
    expect(verifyResponse.account.id).toBeDefined();

    const sessionCookie = `${sessionCookieName}=${verifyResponse.session.id}`;
    const sessionCheck = await getJson<{ account: { id: string } }>(
      restoredApp,
      "/auth/session",
      sessionCookie
    );
    expect(sessionCheck.account.id).toBe(verifyResponse.account.id);

    await restoredApp.close();
  }, 30_000);

  it("does not expose retired phone verification routes", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const app = buildApi({ cp2: { store }, mutationPersistenceFlush: () => store.flush() });
    const response = await app.inject({
      method: "POST",
      url: "/auth/phone/challenges",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        phone: `+254702${Date.now().toString().slice(-6)}`,
        purpose: "signup"
      })
    });
    expect(response.statusCode).toBe(404);
    expect(store.snapshot().smsDeliveryAttempts).toHaveLength(0);
    await app.close();
  }, 15_000);

  it("persists API state in normalized Postgres tables across store restarts", async () => {
    expect(databaseUrl).toBeDefined();

    const uniquePhone = `254700${Date.now().toString().slice(-6)}`;
    const store = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const app = buildApi({ cp2: { store } });
    const { business, sessionCookie } = await createOwnerBusiness(app, uniquePhone);
    // createOwnerBusiness's /auth/pin/signup already sets the account's PIN; a second
    // /auth/pin/setup call here is redundant and now correctly rejected as pin_already_set.
    const mcpToken = await postJson<McpTokenResponse>(
      app,
      "/v1/mcp/tokens",
      {
        name: "Postgres restart token",
        scopes: ["mcp:read", "mcp:act"],
        shopId: business.id,
        expiresInSeconds: 3600
      },
      sessionCookie
    );
    const product = await postJson<ProductResponse>(
      app,
      `/businesses/${business.id}/products`,
      {
        name: "Postgres Sugar",
        quantity: 8,
        unit: "kg",
        buyingPrice: 100,
        sellingPrice: 130
      },
      sessionCookie
    );
    const initialSyncPage = await getJson<SyncPageResponse>(
      app,
      "/v1/sync/changes?limit=100",
      sessionCookie
    );
    expect(initialSyncPage.changes.map((change) => change.collection)).toContain("shops");

    await store.flush();
    await app.close();

    const restoredStore = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const restoredApp = buildApi({ cp2: { store: restoredStore } });
    expect(
      restoredStore.authenticateMcpAccessToken({ accessToken: mcpToken.accessToken })
    ).toMatchObject({ tokenId: mcpToken.token.id, shopId: business.id });
    const products = await getJson<ProductResponse[]>(
      restoredApp,
      `/businesses/${business.id}/products`,
      sessionCookie
    );

    expect(products).toEqual([expect.objectContaining({ id: product.id, name: "Postgres Sugar" })]);
    const restoredSyncPage = await getJson<SyncPageResponse>(
      restoredApp,
      "/v1/sync/changes?limit=100",
      sessionCookie
    );
    expect(restoredSyncPage.nextCursor).toBe(initialSyncPage.nextCursor);
    expect(restoredSyncPage.changes).toEqual(initialSyncPage.changes);
    expect((await restoredStore.health()).syncChangeCount).toBeGreaterThan(0);

    await restoredApp.close();
  }, 15_000);

  it("reloads an active binding from Postgres and routes chat through the Vercel adapter", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const modelId = "qwen2.5-0.5b-android";
    const inferenceCalls: string[] = [];
    const inferenceRequestIds: string[] = [];
    const artifactStore: ModelArtifactStore = {
      async resolveArtifact(requestedModelId) {
        return {
          id: `postgres-integration:${requestedModelId}`,
          modelId: requestedModelId,
          storageProvider: "neon-object-storage",
          bucket: "grogoni-model-artifacts",
          objectKey: `models/${requestedModelId}/model.gguf`,
          format: "gguf",
          quantization: "Q4_0",
          sizeBytes: 12,
          sha256: null,
          contentType: "application/octet-stream",
          status: "available",
          createdAt: "2026-08-31T00:00:00.000Z",
          updatedAt: "2026-08-31T00:00:00.000Z"
        };
      },
      async createDownloadUrl(artifact) {
        return {
          ...artifact,
          downloadUrl: "https://storage.example.neon.tech/grogoni-model-artifacts/model.gguf",
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        };
      },
      async verifyArtifact() {
        return { ok: true, sizeMatches: true, hashMatches: null, errorCode: null };
      }
    };
    const createAdapter = () =>
      createVercelModelAdapter({
        modelId,
        artifactStore,
        client: createVercelInferenceClient({
          baseUrl: "https://vercel-inference.example",
          serviceToken: "postgres-integration-token-at-least-32-chars",
          timeoutMs: 1_000,
          request: async (input, init) => {
            const url = String(input);
            inferenceCalls.push(url);
            if (url.endsWith("/health")) {
              return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            // The Vercel client rejects a result whose requestId does not echo the request's own
            // id (model-runtime.ts), so the fake runtime echoes it exactly like the real one.
            const requestId =
              typeof init?.body === "string"
                ? ((JSON.parse(init.body) as { requestId?: string }).requestId ?? "")
                : "";
            inferenceRequestIds.push(requestId);
            const events = [
              { type: "status", state: "INITIALIZING" },
              { type: "status", state: "READY", cacheHit: false },
              {
                type: "result",
                requestId,
                text: JSON.stringify({ type: "response", message: "postgres market" }),
                finishReason: "stop",
                usage: { inputTokens: 7, outputTokens: 3 },
                metrics: {}
              }
            ];
            const encoder = new TextEncoder();
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                for (const event of events) {
                  controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
                }
                controller.close();
              }
            });
            return new Response(body, {
              status: 200,
              headers: { "content-type": "application/x-ndjson" }
            });
          }
        })
      });
    const adapterResolver = ({ modelId: requestedModelId }: { modelId: string }) =>
      requestedModelId === modelId ? createAdapter() : undefined;

    const store = await createPostgresCp2Store({
      databaseUrl: connectionString,
      modelRuntimeAdapterResolver: adapterResolver
    });
    const app = buildApi({ cp2: { store }, mutationPersistenceFlush: () => store.flush() });
    const uniquePhone = `254705${Date.now().toString().slice(-6)}`;
    const { business, sessionCookie } = await createOwnerBusiness(app, uniquePhone);
    const activation = await postJson<{ binding: { id: string; modelId: string } }>(
      app,
      `/api/agents/${business.id}/models/${modelId}/activate`,
      {
        shopId: business.id,
        executionTarget: "vercel",
        executionMode: "LOCAL_FIRST",
        costResponsibility: "merchant",
        permissions: {
          allowRemoteShopDevice: false
        }
      },
      sessionCookie
    );
    await store.flush();
    await app.close();

    const restoredStore = await createPostgresCp2Store({
      databaseUrl: connectionString,
      modelRuntimeAdapterResolver: adapterResolver
    });
    const restoredApp = buildApi({
      cp2: { store: restoredStore },
      mutationPersistenceFlush: () => restoredStore.flush()
    });
    const binding = await getJson<{ binding: { id: string; modelId: string } }>(
      restoredApp,
      `/api/agents/${business.id}/model-binding?shopId=${business.id}`,
      sessionCookie
    );
    expect(binding.binding).toMatchObject({ id: activation.binding.id, modelId });

    const turn = await postJson<{
      turn: {
        response: string;
        model: { bindingId: string; modelId: string; inferenceRequestId: string };
      };
    }>(
      restoredApp,
      `/businesses/${business.id}/runtime/turns`,
      { message: "Reply with postgres market" },
      sessionCookie
    );
    expect(turn.turn).toMatchObject({
      response: "postgres market",
      model: {
        bindingId: activation.binding.id,
        modelId,
        inferenceRequestId: inferenceRequestIds.at(-1)
      }
    });
    expect(inferenceRequestIds.at(-1)).toMatch(/\S/u);
    expect(inferenceCalls.some((url) => url.endsWith("/v1/inference"))).toBe(true);

    await restoredApp.close();
  }, 30_000);

  it(
    "persists agent profile, context sources, owner corrections, feedback, and installed " +
      "models across restarts",
    async () => {
      expect(databaseUrl).toBeDefined();
      const connectionString = databaseUrl ?? "";
      const uniquePhone = `254706${Date.now().toString().slice(-6)}`;
      const deviceId = `postgres-device-${Date.now()}`;

      const store = await createPostgresCp2Store({ databaseUrl: connectionString });
      const app = buildApi({ cp2: { store }, mutationPersistenceFlush: () => store.flush() });
      const { business, sessionCookie } = await createOwnerBusiness(app, uniquePhone);
      const sessionId = readSessionCookie(sessionCookie);
      expect(sessionId).not.toBeNull();

      const profile = await putJson<{ name: string; modelId: string }>(
        app,
        `/businesses/${business.id}/agent-profile`,
        {
          name: "Postgres Runtime Agent",
          description: "Handles postgres persistence checks.",
          modelId: "qwen2.5-0.5b-android",
          role: "sales",
          language: "en",
          personality: "Friendly and concise.",
          instructions: "Always confirm quantities.",
          knowledge: "Sells household goods.",
          tools: [],
          integrations: [],
          contextScripts: [],
          status: "active"
        },
        sessionCookie
      );

      const contextSource = await postJson<{ id: string; title: string }>(
        app,
        `/businesses/${business.id}/agent-runtime/context-sources`,
        {
          type: "policy",
          title: "Return policy",
          content: "Returns accepted within 7 days with a receipt.",
          sensitivity: "internal",
          customerVisible: false,
          status: "active"
        },
        sessionCookie
      );

      const correction = await postJson<{ id: string; correction: string }>(
        app,
        `/businesses/${business.id}/agent-runtime/corrections`,
        {
          correction: "Sugar is sold by the kilogram, not the bag.",
          category: "business_fact",
          promoteToInstruction: false
        },
        sessionCookie
      );

      await postJson(
        app,
        `/businesses/${business.id}/agent-runtime/feedback`,
        { correct: true },
        sessionCookie
      );

      const runtimeSession = await postJson<{ id: string }>(
        app,
        `/businesses/${business.id}/runtime/sessions`,
        {},
        sessionCookie
      );

      const installedModel = store.registerInstalledAgentModel({
        sessionId,
        model: {
          id: `${deviceId}-model`,
          deviceId,
          modelId: "tinyllama-1.1b-chat-q4-k-m-android",
          displayName: "TinyLlama 1.1B (Q4_K_M)",
          provider: "huggingface",
          repositoryId: "postgres-test/tinyllama",
          filename: "tinyllama.gguf",
          format: "GGUF",
          quantization: "Q4_K_M",
          architecture: "llama",
          parameterCount: 1_100_000_000,
          contextLength: 2048,
          fileSizeBytes: 700_000_000,
          checksum: `sha256:${"a".repeat(64)}`,
          packageManifestVersion: null,
          packageSignature: null,
          packageSigningKeyId: null,
          license: "Apache-2.0",
          commercialUseAllowed: true,
          storageKey: `${deviceId}-storage-key`,
          runtimeBackend: "LLAMA_CPP_ANDROID",
          installationStatus: "INSTALLED",
          compatibilityStatus: "COMPATIBLE",
          installedAt: new Date().toISOString(),
          lastVerifiedAt: null,
          validationError: null
        }
      });

      await store.flush();
      await app.close();

      const restoredStore = await createPostgresCp2Store({ databaseUrl: connectionString });
      const restoredApp = buildApi({
        cp2: { store: restoredStore },
        mutationPersistenceFlush: () => restoredStore.flush()
      });

      const restoredProfile = await getJson<{ name: string; modelId: string }>(
        restoredApp,
        `/businesses/${business.id}/agent-profile`,
        sessionCookie
      );
      expect(restoredProfile).toMatchObject({ name: profile.name, modelId: profile.modelId });

      const restoredSources = await getJson<Array<{ id: string; title: string }>>(
        restoredApp,
        `/businesses/${business.id}/agent-runtime/context-sources`,
        sessionCookie
      );
      expect(restoredSources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: contextSource.id, title: contextSource.title })
        ])
      );

      const restoredCorrections = await getJson<Array<{ id: string; correction: string }>>(
        restoredApp,
        `/businesses/${business.id}/agent-runtime/corrections`,
        sessionCookie
      );
      expect(restoredCorrections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: correction.id, correction: correction.correction })
        ])
      );

      const restoredEvaluations = await getJson<{ total: number }>(
        restoredApp,
        `/businesses/${business.id}/agent-runtime/evaluations`,
        sessionCookie
      );
      expect(restoredEvaluations.total).toBeGreaterThanOrEqual(1);

      const restoredRuntimeSessions = await getJson<Array<{ id: string }>>(
        restoredApp,
        `/businesses/${business.id}/runtime/sessions`,
        sessionCookie
      );
      expect(restoredRuntimeSessions).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: runtimeSession.id })])
      );

      const restoredInstalledModels = restoredStore.listInstalledAgentModels({
        sessionId,
        deviceId
      });
      expect(restoredInstalledModels).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: installedModel.id })])
      );

      await restoredApp.close();
    },
    30_000
  );

  it(
    "persists customers, invoices, payments, inventory movements, product field schemas, " +
      "public customer-care requests, and public orders across restarts",
    async () => {
      expect(databaseUrl).toBeDefined();
      const connectionString = databaseUrl ?? "";
      const uniquePhone = `254707${Date.now().toString().slice(-6)}`;

      const store = await createPostgresCp2Store({ databaseUrl: connectionString });
      const app = buildApi({ cp2: { store }, mutationPersistenceFlush: () => store.flush() });
      const { business, sessionCookie } = await createOwnerBusiness(app, uniquePhone);

      const invoiceProduct = await postJson<{ id: string }>(
        app,
        `/businesses/${business.id}/products`,
        { name: "Invoice Sugar", sku: "SUGAR-1", unit: "kg", quantity: 20, sellingPrice: 150 },
        sessionCookie
      );
      const orderProduct = await postJson<{ id: string }>(
        app,
        `/businesses/${business.id}/products`,
        { name: "Order Rice", sku: "RICE-1", unit: "kg", quantity: 20, sellingPrice: 200 },
        sessionCookie
      );

      const customer = await postJson<{ id: string; name: string }>(
        app,
        `/businesses/${business.id}/customers`,
        { name: "Postgres Customer", phone: "+254700111222" },
        sessionCookie
      );

      const fieldSchema = await postJson<{ businessId: string; fields: Array<{ id: string }> }>(
        app,
        `/businesses/${business.id}/products/fields`,
        {
          fields: [
            { id: "name", label: "Name", inputType: "text", required: true },
            { id: "batch", label: "Batch", inputType: "text", required: false }
          ]
        },
        sessionCookie
      );

      const invoice = await postJson<{ id: string }>(
        app,
        `/businesses/${business.id}/invoices`,
        {
          customerId: customer.id,
          taxRate: 0,
          items: [{ productId: invoiceProduct.id, quantity: 2, unitPrice: 150 }]
        },
        sessionCookie
      );
      await postJson(
        app,
        `/businesses/${business.id}/invoices/${invoice.id}/confirm`,
        {},
        sessionCookie
      );
      const paymentResult = await postJson<{ payment: { id: string } }>(
        app,
        `/businesses/${business.id}/payments`,
        { invoiceId: invoice.id, amount: 300, method: "cash" },
        sessionCookie
      );
      const payment = paymentResult.payment;

      const careRequest = await postJson<{ id: string }>(
        app,
        `/public/storefronts/${business.grogoniId}/customer-care`,
        { type: "quote", customerName: "Storefront Visitor", message: "How much for rice?" },
        undefined
      );

      const visitorId = `visitor-${Date.now()}`;
      const session = await postJson<{ capabilityToken: string }>(
        app,
        `/public/storefronts/${business.grogoniId}/sessions`,
        { visitorId, displayName: "Storefront Visitor" },
        undefined
      );
      const order = await postJson<{ id: string; invoiceId: string }>(
        app,
        `/public/storefronts/${business.grogoniId}/orders`,
        {
          capabilityToken: session.capabilityToken,
          customerName: "Storefront Visitor",
          phone: "+254700333444",
          note: null,
          items: [{ productId: orderProduct.id, quantity: 1 }]
        },
        undefined
      );

      await store.flush();
      await app.close();

      const restoredStore = await createPostgresCp2Store({ databaseUrl: connectionString });
      const restoredApp = buildApi({
        cp2: { store: restoredStore },
        mutationPersistenceFlush: () => restoredStore.flush()
      });

      const restoredCustomers = await getJson<Array<{ id: string; name: string }>>(
        restoredApp,
        `/businesses/${business.id}/customers`,
        sessionCookie
      );
      expect(restoredCustomers).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: customer.id, name: customer.name })])
      );

      const restoredFieldSchema = await getJson<{ fields: Array<{ id: string }> }>(
        restoredApp,
        `/businesses/${business.id}/products/fields`,
        sessionCookie
      );
      expect(restoredFieldSchema.fields.map((field) => field.id)).toEqual(
        fieldSchema.fields.map((field) => field.id)
      );

      const restoredInvoices = await getJson<Array<{ id: string; status: string }>>(
        restoredApp,
        `/businesses/${business.id}/invoices`,
        sessionCookie
      );
      expect(restoredInvoices).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: invoice.id, status: "confirmed" })])
      );

      const restoredPayments = await getJson<Array<{ id: string }>>(
        restoredApp,
        `/businesses/${business.id}/payments`,
        sessionCookie
      );
      expect(restoredPayments).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: payment.id })])
      );

      const restoredCareRequests = await getJson<Array<{ id: string }>>(
        restoredApp,
        `/businesses/${business.id}/storefront/customer-care`,
        sessionCookie
      );
      expect(restoredCareRequests).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: careRequest.id })])
      );

      const restoredOrders = await getJson<Array<{ id: string; invoiceId: string }>>(
        restoredApp,
        `/businesses/${business.id}/storefront/orders`,
        sessionCookie
      );
      expect(restoredOrders).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: order.id, invoiceId: order.invoiceId })
        ])
      );

      const restoredMovements = (
        restoredStore as unknown as {
          salesDomain: {
            inventoryMovementsForBusiness: (businessId: string) => Array<{ productId: string }>;
          };
        }
      ).salesDomain.inventoryMovementsForBusiness(business.id);
      expect(restoredMovements).toEqual(
        expect.arrayContaining([expect.objectContaining({ productId: invoiceProduct.id })])
      );

      await restoredApp.close();
    },
    60_000
  );

  it("persists phone-first access, verified recovery email, and password login across restarts", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const suffix = Date.now().toString().slice(-7);
    const phone = `+25473${suffix}`;
    const email = `access-${suffix}@example.test`;
    const password = "persistent account access password";
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const app = buildApi({
      cp2: { store },
      mutationPersistenceFlush: () => store.flush()
    });

    const started = await app.inject({
      method: "POST",
      url: "/auth/signup/start",
      headers: jsonHeaders(),
      payload: JSON.stringify({ type: "phone", identifier: phone })
    });
    expect(started.statusCode).toBe(200);
    const transactionId = started.json<{ transactionId: string }>().transactionId;
    const completed = await app.inject({
      method: "POST",
      url: "/auth/signup/complete",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        transactionId,
        displayName: "Persistent Access Owner",
        email,
        password,
        passwordConfirmation: password,
        termsAccepted: true,
        privacyAccepted: true
      })
    });
    expect(completed.statusCode).toBe(200);
    const signupCookie = extractSessionCookie(completed.headers["set-cookie"]);
    const verification = await app.inject({
      method: "POST",
      url: "/auth/email/verification/start",
      headers: { cookie: signupCookie }
    });
    expect(verification.statusCode).toBe(200);
    const verificationData = verification.json<{
      challengeId: string;
      developmentCode: string;
    }>();
    const verified = await app.inject({
      method: "POST",
      url: "/auth/email/verification/verify",
      headers: { ...jsonHeaders(), cookie: signupCookie },
      payload: JSON.stringify({
        challengeId: verificationData.challengeId,
        code: verificationData.developmentCode
      })
    });
    expect(verified.statusCode).toBe(200);

    await store.flush();
    await app.close();
    await store.close();

    const restoredStore = await createPostgresCp2Store({ databaseUrl: connectionString });
    const restoredApp = buildApi({
      cp2: { store: restoredStore },
      mutationPersistenceFlush: () => restoredStore.flush()
    });
    const login = await restoredApp.inject({
      method: "POST",
      url: "/auth/login/password",
      headers: jsonHeaders(),
      payload: JSON.stringify({ type: "email", identifier: email, password })
    });

    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      account: { primaryAuthDestination: phone },
      session: { id: expect.any(String) }
    });
    expect(restoredStore.snapshot().accountIdentities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "email",
          normalizedValue: email,
          verifiedAt: expect.any(String)
        })
      ])
    );
    expect(restoredStore.snapshot().passwordCredentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ passwordHash: expect.stringContaining("scrypt$password-v1$") })
      ])
    );

    await restoredApp.close();
    await restoredStore.close();
  }, 20_000);

  // Regression test: continueWithChannelPin and loginWithGrogoniIdPin back the endpoints the actual
  // product frontend calls for every sign up and log in (PhoneFirstAuthentication.tsx) - unlike
  // the /auth/pin/signup fixture other tests in this file use to bootstrap accounts. Both were
  // missing from postgres-store.ts's mutatingMethodNames allowlist, so calling them through the
  // Postgres proxy never queued a save on its own. In production this gap is masked on the HTTP
  // path because every auth route also calls setAuthSessionCookies -> store.prepareDeviceSession
  // (already allowlisted) right after, and a save is always a full store.snapshot(), so that
  // incidental call sweeps the account/session in too - which is exactly why this needs a store-
  // level test that calls the store directly and skips that side effect, rather than a route-level
  // test through app.inject(), to actually exercise the gap the allowlist entry closes.
  it("queues a Postgres save for continueWithChannelPin and loginWithGrogoniIdPin on their own", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const suffix = Date.now().toString().slice(-7);
    const phone = `+25470${suffix}`;
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const pool = new Pool({ connectionString });

    try {
      const signup = store.continueWithChannelPin({
        channel: "phone",
        destination: phone,
        pin: "7421"
      });
      expect(signup.isNewAccount).toBe(true);

      await store.flush();
      const accountRow = await pool.query("select id from accounts where id = $1", [
        signup.account.id
      ]);
      expect(accountRow.rows).toHaveLength(1);

      const login = store.continueWithChannelPin({
        channel: "phone",
        destination: phone,
        pin: "7421"
      });
      expect(login.isNewAccount).toBe(false);

      await store.flush();
      const loginSessionRow = await pool.query("select id from sessions where id = $1", [
        login.session.id
      ]);
      expect(loginSessionRow.rows).toHaveLength(1);

      const business = store.createBusiness({
        sessionId: login.session.id,
        name: "Continue Flow Shop",
        language: "en"
      });
      await store.flush();

      const storeLogin = store.loginWithGrogoniIdPin({
        grogoniId: business.business.grogoniId,
        pin: "7421"
      });

      await store.flush();
      const storeLoginSessionRow = await pool.query("select id from sessions where id = $1", [
        storeLogin.session.id
      ]);
      expect(storeLoginSessionRow.rows).toHaveLength(1);
    } finally {
      await pool.end();
      await store.close();
    }
  }, 20_000);

  it("completes phone PIN login with canonical, non-duplicated sync rows", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const uniquePhone = `+254701${Date.now().toString().slice(-6)}`;
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const app = buildApi({
      cp2: { store },
      mutationPersistenceFlush: () => store.flush()
    });
    const signup = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: jsonHeaders(),
      payload: JSON.stringify({ method: "phone", contact: uniquePhone, pin: "4826" })
    });
    expect(signup.statusCode).toBe(200);
    const accountId = signup.json<{ account: { id: string } }>().account.id;
    const signupCookie = extractSessionCookie(signup.headers["set-cookie"]);
    const context = await getJson<{ conversationId: string }>(
      app,
      "/v1/session/context",
      signupCookie
    );
    await postJson(
      app,
      `/v1/conversations/${context.conversationId}/typing`,
      { typing: true },
      signupCookie
    );

    const pool = new Pool({ connectionString });
    const countBeforeWrongPin = await syncCount(pool, accountId);
    const wrongPin = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      headers: jsonHeaders(),
      payload: JSON.stringify({ method: "phone", contact: uniquePhone, pin: "0000" })
    });
    expect(wrongPin.statusCode).toBe(401);
    expect(wrongPin.json()).toMatchObject({ code: "auth_credentials_invalid" });
    await store.flush();
    expect(await syncCount(pool, accountId)).toBe(countBeforeWrongPin);

    const loginSessionIds: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const login = await app.inject({
        method: "POST",
        url: "/auth/pin/login",
        headers: jsonHeaders(),
        payload: JSON.stringify({ method: "phone", contact: uniquePhone, pin: "4826" })
      });
      expect(login.statusCode).toBe(200);
      const loginCookie = extractSessionCookie(login.headers["set-cookie"]);
      const loginBody = login.json<{ session: { id: string } }>();
      loginSessionIds.push(loginBody.session.id);
      expect(loginCookie).toContain("grogoni_session=");

      const authenticated = await app.inject({
        method: "GET",
        url: "/session",
        headers: { cookie: loginCookie }
      });
      expect(authenticated.statusCode).toBe(200);
      expect(authenticated.json()).toMatchObject({
        account: { id: accountId },
        session: { id: loginBody.session.id }
      });
    }

    const rows = await pool.query<{ collection: string }>(
      `
        select collection
        from account_sync_changes
        where account_id = $1
        order by sequence
      `,
      [accountId]
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every((row) => isAccountSyncCollection(row.collection))).toBe(true);
    expect(rows.rows.filter((row) => row.collection === "conversations")).toHaveLength(1);
    const duplicates = await pool.query<{ count: string }>(
      `
        select count(*)::text as count
        from (
          select account_id, sequence
          from account_sync_changes
          where account_id = $1
          group by account_id, sequence
          having count(*) > 1
        ) duplicate_keys
      `,
      [accountId]
    );
    expect(duplicates.rows[0]?.count).toBe("0");
    const persistedLoginSessions = await pool.query<{ count: string }>(
      "select count(*)::text as count from sessions where id = any($1::uuid[])",
      [loginSessionIds]
    );
    expect(persistedLoginSessions.rows[0]?.count).toBe("2");

    const constraint = await pool.query<{ definition: string }>(
      `
        select pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname = 'account_sync_changes_collection_check'
      `
    );
    for (const collection of ACCOUNT_SYNC_COLLECTIONS) {
      expect(constraint.rows[0]?.definition).toContain(collection);
    }

    await pool.end();
    await app.close();
    await store.close();
  }, 30_000);

  it("normalizes known aliases and fails safely on unknown historical collections", async () => {
    expect(databaseUrl).toBeDefined();
    const pool = new Pool({ connectionString: databaseUrl ?? "" });
    const migrationSql = await readFile(
      resolve(process.cwd(), "infra/db/migrations/032_account_sync_collection_constraint.sql"),
      "utf8"
    );
    const client = await pool.connect();

    try {
      await client.query("begin");
      await client.query(
        "alter table account_sync_changes drop constraint account_sync_changes_collection_check"
      );
      const aliasAccountId = randomUUID();
      await insertMigrationTestAccount(client, aliasAccountId);
      await insertMigrationTestSyncChange(client, aliasAccountId, "conversationTyping");
      await client.query(migrationSql);
      const normalized = await client.query<{ collection: string }>(
        "select collection from account_sync_changes where account_id = $1",
        [aliasAccountId]
      );
      expect(normalized.rows[0]?.collection).toBe("conversation_typing");
      await client.query("rollback");

      await client.query("begin");
      await client.query(
        "alter table account_sync_changes drop constraint account_sync_changes_collection_check"
      );
      const unknownAccountId = randomUUID();
      await insertMigrationTestAccount(client, unknownAccountId);
      await insertMigrationTestSyncChange(client, unknownAccountId, "unknown_historical_value");
      await expect(client.query(migrationSql)).rejects.toThrow(
        "Unknown account_sync_changes.collection values remain"
      );
      await client.query("rollback");
    } finally {
      client.release();
      await pool.end();
    }
  }, 15_000);

  it("persists a shop presence update instead of failing (shopPresences has no id field)", async () => {
    // Regression test: ShopPresenceSummary (packages/shared-types) has no `id` field - it is keyed
    // by businessId in the in-memory store. recordEntityId's fallback case required "id" for any
    // collection without an explicit case, which made every presence update fail with 500 whenever
    // the Postgres store persisted it (discovered while testing the save-skip/retry changes above).
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const app = buildApi({ cp2: { store }, mutationPersistenceFlush: () => store.flush() });
    const pool = new Pool({ connectionString });

    try {
      const uniquePhone = `254703${Date.now().toString().slice(-6)}`;
      const { business, sessionCookie } = await createOwnerBusiness(app, uniquePhone);

      const response = await app.inject({
        method: "PATCH",
        url: `/businesses/${business.id}/presence`,
        headers: { ...jsonHeaders(), cookie: sessionCookie },
        payload: JSON.stringify({ status: "private" })
      });

      expect(response.statusCode).toBe(200);
      const persisted = await pool.query<{ record: { status: string } }>(
        "select record from cp2_shop_presences where entity_id = $1",
        [business.id]
      );
      expect(persisted.rows[0]?.record.status).toBe("private");
    } finally {
      await pool.end();
      await app.close();
      await store.close();
    }
  }, 15_000);

  it("skips re-persisting a collection that has not changed since the last save", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const app = buildApi({ cp2: { store }, mutationPersistenceFlush: () => store.flush() });
    const pool = new Pool({ connectionString });

    try {
      const uniquePhone = `254701${Date.now().toString().slice(-6)}`;
      const { business, sessionCookie } = await createOwnerBusiness(app, uniquePhone);
      const product = await postJson<ProductResponse>(
        app,
        `/businesses/${business.id}/products`,
        { name: "Untouched Rice", quantity: 5, unit: "kg", buyingPrice: 90, sellingPrice: 120 },
        sessionCookie
      );
      await store.flush();
      const beforeUpdatedAt = await rowUpdatedAt(pool, "cp2_products", product.id);
      expect(beforeUpdatedAt).not.toBeNull();

      // An unrelated mutation on a different collection (presence) must not touch the products
      // row's persisted state at all - not even re-write it with identical content.
      await app.inject({
        method: "PATCH",
        url: `/businesses/${business.id}/presence`,
        headers: { ...jsonHeaders(), cookie: sessionCookie },
        payload: JSON.stringify({ status: "private" })
      });
      await store.flush();
      const afterUpdatedAt = await rowUpdatedAt(pool, "cp2_products", product.id);

      expect(afterUpdatedAt).toEqual(beforeUpdatedAt);

      // Actually changing the product must still persist normally. PATCH replaces the whole
      // record (name is required by parseProductBody), not a partial merge.
      const updateResponse = await app.inject({
        method: "PATCH",
        url: `/businesses/${business.id}/products/${product.id}`,
        headers: { ...jsonHeaders(), cookie: sessionCookie },
        payload: JSON.stringify({
          name: "Untouched Rice",
          quantity: 6,
          unit: "kg",
          buyingPrice: 90,
          sellingPrice: 120
        })
      });
      expect(updateResponse.statusCode).toBe(200);
      await store.flush();
      const afterRealChangeUpdatedAt = await rowUpdatedAt(pool, "cp2_products", product.id);
      expect(afterRealChangeUpdatedAt).not.toEqual(beforeUpdatedAt);

      const persistedProduct = await pool.query<{ record: { quantity: number } }>(
        "select record from cp2_products where entity_id = $1",
        [product.id]
      );
      expect(persistedProduct.rows[0]?.record.quantity).toBe(6);
    } finally {
      await pool.end();
      await app.close();
      await store.close();
    }
  }, 20_000);

  it("does not discard in-memory mutations when a save fails, and recovers on its own", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    process.env.DB_PERSISTENCE_RETRY_INITIAL_MS = "50";
    process.env.DB_PERSISTENCE_RETRY_MAX_MS = "200";
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    // Deliberately not wiring mutationPersistenceFlush here: production requests do not block on
    // persistence (see the Proxy at the bottom of postgres-store.ts), and this test needs the
    // product-creation request itself to succeed while the triggered save fails in the background
    // - that gap is exactly what the reverted-in-memory-state bug lived in.
    const app = buildApi({ cp2: { store } });
    const pool = new Pool({ connectionString });

    try {
      const uniquePhone = `254702${Date.now().toString().slice(-6)}`;
      const { business, sessionCookie } = await createOwnerBusiness(app, uniquePhone);
      await store.flush();

      // Force every future write to cp2_products to fail, without disturbing existing rows
      // (NOT VALID skips the initial validation scan) or any other table.
      await pool.query(
        "alter table cp2_products add constraint force_persistence_failure check (false) not valid"
      );

      const failingProduct = await postJson<ProductResponse>(
        app,
        `/businesses/${business.id}/products`,
        {
          name: "Race Condition Beans",
          quantity: 3,
          unit: "kg",
          buyingPrice: 50,
          sellingPrice: 70
        },
        sessionCookie
      );

      // Give the queued save a moment to actually run and fail.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));

      // The mutation must still be visible in memory - not reverted because Postgres rejected it.
      expect(store.snapshot().products).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: failingProduct.id })])
      );
      const healthDuringFailure = await store.health();
      expect(healthDuringFailure.persistenceError).not.toBeNull();
      const notYetPersisted = await pool.query("select 1 from cp2_products where entity_id = $1", [
        failingProduct.id
      ]);
      expect(notYetPersisted.rows).toHaveLength(0);

      // Fix the underlying problem and let the scheduled retry (no further mutation needed) catch up.
      await pool.query("alter table cp2_products drop constraint force_persistence_failure");
      await waitUntil(async () => {
        const result = await pool.query("select 1 from cp2_products where entity_id = $1", [
          failingProduct.id
        ]);
        // Committed-and-visible-in-Postgres can momentarily lead clearing lastPersistenceError,
        // since a few more in-process steps (unlock, snapshot bookkeeping) run after commit before
        // the queue's success handler fires - wait for both, not just the row.
        return result.rows.length > 0 && (await store.health()).persistenceError === null;
      });
    } finally {
      await pool
        .query("alter table cp2_products drop constraint if exists force_persistence_failure")
        .catch(() => undefined);
      await pool.end();
      await app.close();
      await store.close();
      delete process.env.DB_PERSISTENCE_RETRY_INITIAL_MS;
      delete process.env.DB_PERSISTENCE_RETRY_MAX_MS;
    }
  }, 20_000);

  it("persists status broadcasts and unified checkout orders (buy_orders/status_orders) across store restarts", async () => {
    expect(databaseUrl).toBeDefined();
    const onePixelPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZCr8AAAAASUVORK5CYII=";

    const sellerPhone = `254701${Date.now().toString().slice(-6)}`;
    const buyerPhone = `254702${Date.now().toString().slice(-6)}`;
    const store = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const app = buildApi({ cp2: { store } });

    const seller = await createOwnerBusiness(app, sellerPhone);
    const buyer = await createOwnerBusiness(app, buyerPhone);

    await postJson<ProductResponse>(
      app,
      `/businesses/${seller.business.id}/products`,
      { name: "Postgres Mangoes", quantity: 10, unit: "kg", buyingPrice: 100, sellingPrice: 150 },
      seller.sessionCookie
    );

    const sellerGraph = await postJson<NetworkGraphSummary>(
      app,
      "/network/sync/contacts",
      { contacts: [{ name: "Buyer Contact", phone: `+${buyerPhone}` }] },
      seller.sessionCookie
    );
    const buyerNode = sellerGraph.nodes.find((node) => node.displayName === "Buyer Contact")!;

    const job = await postJson<ProductCaptureJobSummary>(
      app,
      `/businesses/${seller.business.id}/product-captures`,
      { fileName: "shelf.jpg", contentType: "image/png", contentBase64: onePixelPng },
      seller.sessionCookie
    );
    await postJson(
      app,
      `/businesses/${seller.business.id}/product-captures/${job.id}/items/${job.items[0]!.id}/confirm`,
      { title: "Postgres Bananas", visiblePrice: 90 },
      seller.sessionCookie
    );
    const status = await postJson<StatusBroadcastSummary>(
      app,
      `/businesses/${seller.business.id}/status-broadcasts`,
      { sourceCaptureJobId: job.id, recipientNodeIds: [buyerNode.id] },
      seller.sessionCookie
    );

    const feed = await getJson<BuyFeedSummary>(app, "/buy/search?query=", buyer.sessionCookie);
    const catalogueResult = feed.results.find((r) => r.title === "Postgres Mangoes")!;
    const contactResult = feed.results.find((r) => r.title === "Postgres Bananas")!;

    const checkout = await postJson<UnifiedCheckoutSummary>(
      app,
      "/buy/checkout",
      {
        items: [
          {
            sourceKind: "catalogue",
            sourceId: catalogueResult.sourceId,
            sourceLabel: catalogueResult.sourceLabel,
            title: catalogueResult.title,
            quantity: 1,
            agentId: catalogueResult.agentId,
            productId: catalogueResult.productId
          },
          {
            sourceKind: "contact",
            sourceId: contactResult.sourceId,
            sourceLabel: contactResult.sourceLabel,
            title: contactResult.title,
            quantity: 1,
            statusBroadcastId: contactResult.statusBroadcastId,
            productCaptureItemId: contactResult.productCaptureItemId
          }
        ]
      },
      buyer.sessionCookie
    );
    expect(checkout.handoffs).toHaveLength(2);
    const contactHandoff = checkout.handoffs.find((handoff) => handoff.kind === "contact")!;

    await store.flush();
    await app.close();

    const restoredStore = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const restoredApp = buildApi({ cp2: { store: restoredStore } });
    try {
      const restoredStatus = await getJson<StatusBroadcastSummary>(
        restoredApp,
        `/businesses/${seller.business.id}/status-broadcasts/${status.id}`,
        seller.sessionCookie
      );
      expect(restoredStatus.resultingOrderIds).toEqual(
        expect.arrayContaining([contactHandoff.orderId])
      );

      const restoredCheckout = await getJson<UnifiedCheckoutSummary>(
        restoredApp,
        `/buy/checkouts/${checkout.id}`,
        buyer.sessionCookie
      );
      expect(restoredCheckout.handoffs).toEqual(checkout.handoffs);
    } finally {
      await restoredApp.close();
      await restoredStore.close();
    }
  }, 20_000);

  it("persists compliance/beta/launch domain records across store restarts", async () => {
    expect(databaseUrl).toBeDefined();
    const ownerPhone = `254703${Date.now().toString().slice(-6)}`;
    const store = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const app = buildApi({ cp2: { store } });

    const owner = await createOwnerBusiness(app, ownerPhone);
    const businessId = owner.business.id;

    const verification = await patchJson<VerificationTierSummary>(
      app,
      `/businesses/${businessId}/compliance/verification`,
      { tier: "owner_verified", evidenceType: "owner_attestation", note: "Postgres slice test" },
      owner.sessionCookie
    );
    const taxConfig = await patchJson<CountryTaxConfigSummary>(
      app,
      `/businesses/${businessId}/compliance/tax-config`,
      { countryCode: "KE", defaultTaxRate: 0.16, taxId: "P000111222A", pricesIncludeTax: true },
      owner.sessionCookie
    );
    const deviceTrust = await patchJson<DeviceTrustSummary>(
      app,
      `/businesses/${businessId}/compliance/device-trust`,
      { deviceId: "browser-session", level: "trusted", reason: "Postgres slice test" },
      owner.sessionCookie
    );
    await patchJson(
      app,
      `/businesses/${businessId}/beta/access`,
      { status: "active", pauseReason: null, invitedMerchantCount: 3 },
      owner.sessionCookie
    );
    await patchJson(
      app,
      `/businesses/${businessId}/beta/feature-flags/closed_beta`,
      { enabled: true, reason: "Postgres slice test" },
      owner.sessionCookie
    );
    await postJson(
      app,
      `/businesses/${businessId}/beta/device-tests`,
      {
        deviceClass: "android_1gb",
        workflow: "checkout",
        status: "passed",
        durationMs: 1200,
        notes: "Postgres slice test"
      },
      owner.sessionCookie
    );
    const supportTicket = await postJson<BetaSupportTicketSummary>(
      app,
      `/businesses/${businessId}/beta/support-tickets`,
      { severity: "high", title: "Postgres slice ticket", body: "Persistence check" },
      owner.sessionCookie
    );
    await postJson(
      app,
      `/businesses/${businessId}/beta/telemetry`,
      { kind: "session", message: null },
      owner.sessionCookie
    );
    const launchSettings = await patchJson<LaunchSettingsSummary>(
      app,
      `/businesses/${businessId}/launch/settings`,
      {
        status: "open",
        publicOnboardingEnabled: true,
        rollbackArmed: true,
        freezeActive: false,
        allowedSignupCount: 5,
        pauseReason: null
      },
      owner.sessionCookie
    );
    await patchJson(
      app,
      `/businesses/${businessId}/launch/checklist/environment_config`,
      { status: "passed", evidence: "Postgres slice test" },
      owner.sessionCookie
    );
    const incident = await postJson<LaunchIncidentSummary>(
      app,
      `/businesses/${businessId}/launch/incidents`,
      {
        severity: "medium",
        category: "onboarding",
        title: "Postgres slice incident",
        body: "Persistence check"
      },
      owner.sessionCookie
    );

    const betaReadinessBefore = await getJson<BetaReadinessReportSummary>(
      app,
      `/businesses/${businessId}/beta/readiness`,
      owner.sessionCookie
    );
    const launchReadinessBefore = await getJson<LaunchReadinessReportSummary>(
      app,
      `/businesses/${businessId}/launch/readiness`,
      owner.sessionCookie
    );

    await store.flush();
    await app.close();

    const restoredStore = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const restoredApp = buildApi({ cp2: { store: restoredStore } });
    try {
      const restoredVerification = await getJson<VerificationTierSummary>(
        restoredApp,
        `/businesses/${businessId}/compliance/verification`,
        owner.sessionCookie
      );
      expect(restoredVerification).toEqual(verification);

      const restoredTaxConfig = await getJson<CountryTaxConfigSummary>(
        restoredApp,
        `/businesses/${businessId}/compliance/tax-config`,
        owner.sessionCookie
      );
      expect(restoredTaxConfig).toEqual(taxConfig);

      const restoredDeviceTrust = await getJson<DeviceTrustSummary>(
        restoredApp,
        `/businesses/${businessId}/compliance/device-trust`,
        owner.sessionCookie
      );
      expect(restoredDeviceTrust).toEqual(deviceTrust);

      const restoredFeatureFlags = await getJson<BetaFeatureFlagSummary[]>(
        restoredApp,
        `/businesses/${businessId}/beta/feature-flags`,
        owner.sessionCookie
      );
      const restoredClosedBeta = restoredFeatureFlags.find((flag) => flag.key === "closed_beta");
      expect(restoredClosedBeta?.enabled).toBe(true);

      const restoredSupportTickets = await getJson<BetaSupportTicketSummary[]>(
        restoredApp,
        `/businesses/${businessId}/beta/support-tickets`,
        owner.sessionCookie
      );
      expect(restoredSupportTickets.find((ticket) => ticket.id === supportTicket.id)).toEqual(
        supportTicket
      );

      const restoredChecklist = await getJson<LaunchChecklistItemSummary[]>(
        restoredApp,
        `/businesses/${businessId}/launch/checklist`,
        owner.sessionCookie
      );
      const restoredEnvironmentConfig = restoredChecklist.find(
        (item) => item.key === "environment_config"
      );
      expect(restoredEnvironmentConfig?.status).toBe("passed");

      const restoredIncidents = await getJson<LaunchIncidentSummary[]>(
        restoredApp,
        `/businesses/${businessId}/launch/incidents`,
        owner.sessionCookie
      );
      expect(restoredIncidents.find((item) => item.id === incident.id)).toEqual(incident);

      const restoredBetaReadiness = await getJson<BetaReadinessReportSummary>(
        restoredApp,
        `/businesses/${businessId}/beta/readiness`,
        owner.sessionCookie
      );
      expect(restoredBetaReadiness.deviceTesting.passedDeviceClasses).toEqual(
        betaReadinessBefore.deviceTesting.passedDeviceClasses
      );
      expect(restoredBetaReadiness.telemetry.sessionEventCount).toBe(
        betaReadinessBefore.telemetry.sessionEventCount
      );
      expect(restoredBetaReadiness.support.openTicketCount).toBe(
        betaReadinessBefore.support.openTicketCount
      );

      const restoredLaunchReadiness = await getJson<LaunchReadinessReportSummary>(
        restoredApp,
        `/businesses/${businessId}/launch/readiness`,
        owner.sessionCookie
      );
      expect(restoredLaunchReadiness.checklist.passed).toBe(launchReadinessBefore.checklist.passed);
      expect(restoredLaunchReadiness.support.openIncidentCount).toBe(
        launchReadinessBefore.support.openIncidentCount
      );
      expect(restoredLaunchReadiness.settings).toEqual(launchSettings);
    } finally {
      await restoredApp.close();
      await restoredStore.close();
    }
  }, 20_000);

  it("persists logistics records (including the logisticsByInvoice index) across store restarts", async () => {
    expect(databaseUrl).toBeDefined();
    const ownerPhone = `254704${Date.now().toString().slice(-6)}`;
    const store = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const app = buildApi({ cp2: { store } });

    const owner = await createOwnerBusiness(app, ownerPhone);
    const businessId = owner.business.id;

    const product = await postJson<ProductResponse>(
      app,
      `/businesses/${businessId}/products`,
      {
        name: "Postgres Logistics Rice",
        quantity: 10,
        unit: "kg",
        buyingPrice: 80,
        sellingPrice: 120
      },
      owner.sessionCookie
    );
    const draftInvoice = await postJson<{ id: string }>(
      app,
      `/businesses/${businessId}/invoices`,
      { items: [{ productId: product.id, quantity: 2, unitPrice: 120 }] },
      owner.sessionCookie
    );
    const confirmed = await postJson<{ invoice: InvoiceSummary }>(
      app,
      `/businesses/${businessId}/invoices/${draftInvoice.id}/confirm`,
      {},
      owner.sessionCookie
    );

    const logistics = await postJson<LogisticsSummary>(
      app,
      `/businesses/${businessId}/logistics`,
      {
        invoiceId: confirmed.invoice.id,
        method: "delivery",
        destination: "Nairobi CBD",
        note: null
      },
      owner.sessionCookie
    );
    const updated = await patchJson<LogisticsSummary>(
      app,
      `/businesses/${businessId}/logistics/${logistics.id}`,
      { status: "ready", note: "Postgres slice test" },
      owner.sessionCookie
    );

    await store.flush();
    await app.close();

    const restoredStore = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const restoredApp = buildApi({ cp2: { store: restoredStore } });
    try {
      const restoredList = await getJson<LogisticsSummary[]>(
        restoredApp,
        `/businesses/${businessId}/logistics`,
        owner.sessionCookie
      );
      expect(restoredList.find((item) => item.id === logistics.id)).toEqual(updated);

      // logisticsByInvoice is a derived index (never itself a Cp2Snapshot field) rebuilt
      // per-item during hydrateSnapshot from the restored logistics records - creating a second
      // logistics record for the same invoice must still be rejected after a restart, proving
      // the index round-tripped correctly, not just the underlying logistics Map.
      const duplicateAttempt = await restoredApp.inject({
        method: "POST",
        url: `/businesses/${businessId}/logistics`,
        headers: { ...jsonHeaders(), cookie: owner.sessionCookie },
        payload: JSON.stringify({
          invoiceId: confirmed.invoice.id,
          method: "pickup",
          destination: null,
          note: null
        })
      });
      expect(duplicateAttempt.statusCode).toBe(409);
    } finally {
      await restoredApp.close();
      await restoredStore.close();
    }
  }, 20_000);

  it("persists suppliers, sales agents, and purchase receipts (via receipt-OCR confirm) across store restarts", async () => {
    expect(databaseUrl).toBeDefined();
    const ownerPhone = `254705${Date.now().toString().slice(-6)}`;
    const store = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const app = buildApi({ cp2: { store } });

    const owner = await createOwnerBusiness(app, ownerPhone);
    const businessId = owner.business.id;

    const supplier = await postJson<SupplierBusinessCardSummary>(
      app,
      `/businesses/${businessId}/suppliers`,
      { name: "Postgres Wholesale Ltd", phone: "+254711222333", email: null, notes: null },
      owner.sessionCookie
    );
    const salesAgent = await postJson<SalesAgentSummary>(
      app,
      `/businesses/${businessId}/suppliers/${supplier.id}/sales-agents`,
      { name: "Postgres Agent", phone: "+254722333444", email: null, notes: null },
      owner.sessionCookie
    );

    const ocrJob = await postJson<ReceiptOCRJobSummary>(
      app,
      `/businesses/${businessId}/receipt-ocr/jobs`,
      {
        fileName: "receipt.txt",
        contentType: "text/plain",
        contentBase64: null,
        extractedText:
          "Supplier: Postgres Wholesale Ltd\nPhone: +254711222333\nTotal: 500\nItem A, 2, 100, 200"
      },
      owner.sessionCookie
    );
    const receipt = await postJson<PurchaseReceiptSummary>(
      app,
      `/businesses/${businessId}/receipt-ocr/jobs/${ocrJob.id}/confirm`,
      { supplierId: supplier.id, salesAgentId: salesAgent.id },
      owner.sessionCookie
    );

    await store.flush();
    await app.close();

    const restoredStore = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const restoredApp = buildApi({ cp2: { store: restoredStore } });
    try {
      const restoredSuppliers = await getJson<SupplierBusinessCardSummary[]>(
        restoredApp,
        `/businesses/${businessId}/suppliers`,
        owner.sessionCookie
      );
      const restoredSupplier = restoredSuppliers.find((item) => item.id === supplier.id);
      expect(restoredSupplier?.name).toBe(supplier.name);
      // salesAgentCount/purchaseReceiptCount are derived by supplierBusinessCard from the
      // restored salesAgents/purchaseReceipts maps, not stored verbatim - a non-zero count here
      // proves those two maps round-tripped and stayed linked to this supplier after restart.
      expect(restoredSupplier?.salesAgentCount).toBe(1);
      expect(restoredSupplier?.purchaseReceiptCount).toBe(1);

      const restoredSalesAgents = await getJson<SalesAgentSummary[]>(
        restoredApp,
        `/businesses/${businessId}/suppliers/${supplier.id}/sales-agents`,
        owner.sessionCookie
      );
      expect(restoredSalesAgents.find((item) => item.id === salesAgent.id)?.name).toBe(
        salesAgent.name
      );

      const restoredReceipts = await getJson<PurchaseReceiptSummary[]>(
        restoredApp,
        `/businesses/${businessId}/purchase-receipts`,
        owner.sessionCookie
      );
      const restoredReceipt = restoredReceipts.find((item) => item.id === receipt.id);
      expect(restoredReceipt?.supplierId).toBe(supplier.id);
      expect(restoredReceipt?.salesAgentId).toBe(salesAgent.id);
      expect(restoredReceipt?.lineItems).toEqual(receipt.lineItems);
    } finally {
      await restoredApp.close();
      await restoredStore.close();
    }
  }, 20_000);

  it("persists document import jobs and sources across store restarts", async () => {
    expect(databaseUrl).toBeDefined();
    const ownerPhone = `254706${Date.now().toString().slice(-6)}`;
    const store = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const app = buildApi({ cp2: { store } });

    const owner = await createOwnerBusiness(app, ownerPhone);
    const businessId = owner.business.id;

    const importJob = await postJson<DocumentImportJobSummary>(
      app,
      `/businesses/${businessId}/imports/supplier-csv`,
      {
        fileName: "postgres-suppliers.csv",
        contentType: "text/csv",
        sourceType: "database",
        sourceLocator: "postgres slice test",
        content: "name,phone,email,notes\nPostgres Import Supplier,+254733444555,,Imported"
      },
      owner.sessionCookie
    );
    expect(importJob.status).toBe("previewed");

    const confirmed = await postJson<DocumentImportConfirmResult>(
      app,
      `/businesses/${businessId}/imports/${importJob.id}/confirm`,
      {},
      owner.sessionCookie
    );
    expect(confirmed.job.status).toBe("confirmed");
    expect(confirmed.suppliers?.[0]?.name).toBe("Postgres Import Supplier");

    await store.flush();
    await app.close();

    const restoredStore = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const restoredApp = buildApi({ cp2: { store: restoredStore } });
    try {
      const restoredJob = await getJson<DocumentImportJobSummary>(
        restoredApp,
        `/businesses/${businessId}/imports/${importJob.id}`,
        owner.sessionCookie
      );
      expect(restoredJob.status).toBe("confirmed");
      expect(restoredJob.confirmedCount).toBe(1);
      expect(restoredJob.source).toEqual(importJob.source);

      const restoredList = await getJson<DocumentImportJobSummary[]>(
        restoredApp,
        `/businesses/${businessId}/imports`,
        owner.sessionCookie
      );
      expect(restoredList.find((job) => job.id === importJob.id)?.status).toBe("confirmed");
    } finally {
      await restoredApp.close();
      await restoredStore.close();
    }
  }, 20_000);

  it("persists notifications (including read status and the notificationByRuleKey index) across store restarts", async () => {
    expect(databaseUrl).toBeDefined();
    const ownerPhone = `254707${Date.now().toString().slice(-6)}`;
    const store = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const app = buildApi({ cp2: { store } });

    const owner = await createOwnerBusiness(app, ownerPhone);
    const businessId = owner.business.id;

    const inbox = await getJson<NotificationInbox>(
      app,
      `/businesses/${businessId}/notifications`,
      owner.sessionCookie
    );
    expect(inbox.notifications.map((notification) => notification.type).sort()).toEqual([
      "beta_readiness",
      "launch_readiness"
    ]);
    const target = inbox.notifications.find(
      (notification) => notification.type === "beta_readiness"
    );
    expect(target).toBeDefined();

    const updated = await patchJson<BusinessNotificationSummary>(
      app,
      `/businesses/${businessId}/notifications/${target?.id}`,
      { status: "read" },
      owner.sessionCookie
    );
    expect(updated.status).toBe("read");
    expect(updated.readAt).not.toBeNull();

    await store.flush();
    await app.close();

    const restoredStore = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const restoredApp = buildApi({ cp2: { store: restoredStore } });
    try {
      const restoredInbox = await getJson<NotificationInbox>(
        restoredApp,
        `/businesses/${businessId}/notifications`,
        owner.sessionCookie
      );
      expect(restoredInbox.notifications.map((notification) => notification.type).sort()).toEqual([
        "beta_readiness",
        "launch_readiness"
      ]);

      const restoredTarget = restoredInbox.notifications.find(
        (notification) => notification.id === target?.id
      );
      expect(restoredTarget?.status).toBe("read");
      expect(restoredTarget?.readAt).toBe(updated.readAt);

      // Re-triggering ensureDeterministicNotifications (via this GET) must upsert onto the
      // same two records rather than duplicate them - proves notificationByRuleKey survived
      // the restart and still dedupes by rule key.
      expect(restoredInbox.notifications).toHaveLength(2);
    } finally {
      await restoredApp.close();
      await restoredStore.close();
    }
  }, 20_000);

  it("persists the network contact graph (nodes/edges/sources/routes/permissions and the contactHashIdByValue index) across store restarts", async () => {
    expect(databaseUrl).toBeDefined();
    const ownerPhone = `254708${Date.now().toString().slice(-6)}`;
    const connectionPhone = `+254709${Date.now().toString().slice(-6)}`;
    const store = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const app = buildApi({ cp2: { store } });

    const owner = await createOwnerBusiness(app, ownerPhone);

    const graph = await postJson<NetworkGraphSummary>(
      app,
      "/network/sync/contacts",
      {
        contacts: [
          {
            name: "Postgres Contact",
            phone: connectionPhone,
            connections: [{ name: "Extended Contact" }]
          }
        ]
      },
      owner.sessionCookie
    );
    const directNode = graph.nodes.find((node) => node.displayName === "Postgres Contact");
    const extendedNode = graph.nodes.find((node) => node.displayName === "Extended Contact");
    expect(directNode).toBeDefined();
    expect(extendedNode).toBeDefined();
    expect(directNode?.contactHashIds).toHaveLength(1);
    const originalContactHashId = directNode?.contactHashIds[0];

    const route = await postJson<AgentRouteSummary>(
      app,
      "/network/routes",
      { requestText: "Extended Contact", targetNodeId: extendedNode?.id },
      owner.sessionCookie
    );
    const approvedRoute = await postJson<AgentRouteSummary>(
      app,
      `/network/routes/${route.id}/approve`,
      {},
      owner.sessionCookie
    );
    expect(approvedRoute.status).toBe("approved");

    await store.flush();
    await app.close();

    const restoredStore = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const restoredApp = buildApi({ cp2: { store: restoredStore } });
    try {
      const restoredGraph = await getJson<NetworkGraphSummary>(
        restoredApp,
        "/network",
        owner.sessionCookie
      );
      expect(restoredGraph.nodes).toHaveLength(3);
      expect(
        restoredGraph.nodes
          .map((node) => node.displayName)
          .sort((left, right) => left.localeCompare(right))
      ).toEqual(expect.arrayContaining(["Extended Contact", "Postgres Contact"]));
      expect(
        restoredGraph.nodes.find((node) => node.displayName === "Postgres Contact")?.contactHashIds
      ).toEqual([originalContactHashId]);

      const restoredRoute = await getJson<AgentRouteSummary>(
        restoredApp,
        `/network/routes/${route.id}`,
        owner.sessionCookie
      );
      expect(restoredRoute).toMatchObject({
        id: route.id,
        status: "approved",
        permissionId: route.permissionId
      });

      // Re-syncing the same phone number after restart must reuse the original contactHash
      // via the rebuilt contactHashIdByValue index, not mint a duplicate - proves the derived
      // index survived the restart.
      const resyncedGraph = await postJson<NetworkGraphSummary>(
        restoredApp,
        "/network/sync/contacts",
        { contacts: [{ name: "Postgres Contact Again", phone: connectionPhone }] },
        owner.sessionCookie
      );
      const resyncedNode = resyncedGraph.nodes.find(
        (node) => node.displayName === "Postgres Contact Again"
      );
      expect(resyncedNode?.contactHashIds).toEqual([originalContactHashId]);
    } finally {
      await restoredApp.close();
      await restoredStore.close();
    }
  }, 20_000);

  it("persists conversations/messages and push subscriptions (including the messageByClientId/messageByIdempotencyKey and pushSubscriptionIdByEndpoint indexes) across store restarts", async () => {
    expect(databaseUrl).toBeDefined();
    const ownerPhone = `254710${Date.now().toString().slice(-6)}`;
    const store = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const app = buildApi({ cp2: { store } });

    const owner = await createOwnerBusiness(app, ownerPhone);

    const conversation = await postJson<ConversationView>(
      app,
      "/v1/conversations",
      { kind: "personal", activeShopId: null },
      owner.sessionCookie
    );
    const clientMessageId = `postgres-message-${Date.now()}`;
    const message = await postJson<ConversationMessageSummary>(
      app,
      "/v1/messages",
      {
        conversationId: conversation.conversation.id,
        clientMessageId,
        content: { type: "text", text: "Persisted before restart" }
      },
      owner.sessionCookie
    );

    const pushEndpoint = `https://push.example.com/${randomUUID()}`;
    const subscription = await postJson<PushSubscriptionSummary>(
      app,
      "/v1/push/subscriptions",
      {
        endpoint: pushEndpoint,
        expirationTime: null,
        keys: { auth: "a".repeat(24), p256dh: "b".repeat(88) }
      },
      owner.sessionCookie
    );

    await store.flush();
    await app.close();

    const restoredStore = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const restoredApp = buildApi({ cp2: { store: restoredStore } });
    try {
      const restoredConversation = await getJson<ConversationView>(
        restoredApp,
        `/v1/conversations/${conversation.conversation.id}`,
        owner.sessionCookie
      );
      expect(restoredConversation.messages).toHaveLength(1);
      expect(restoredConversation.messages[0]).toMatchObject({
        id: message.id,
        clientMessageId
      });

      // Re-posting the exact same clientMessageId/content after restart must return the
      // original message rather than create a duplicate - proves messageByClientId and
      // messageByIdempotencyKey both survived the restart's rebuild.
      const repostedMessage = await postJson<ConversationMessageSummary>(
        restoredApp,
        "/v1/messages",
        {
          conversationId: conversation.conversation.id,
          clientMessageId,
          content: { type: "text", text: "Persisted before restart" }
        },
        owner.sessionCookie
      );
      expect(repostedMessage.id).toBe(message.id);
      const conversationAfterRepost = await getJson<ConversationView>(
        restoredApp,
        `/v1/conversations/${conversation.conversation.id}`,
        owner.sessionCookie
      );
      expect(conversationAfterRepost.messages).toHaveLength(1);

      // Re-registering the same push endpoint after restart must update the original
      // subscription in place rather than create a duplicate - proves
      // pushSubscriptionIdByEndpoint survived the restart's rebuild.
      const resubscribed = await postJson<PushSubscriptionSummary>(
        restoredApp,
        "/v1/push/subscriptions",
        {
          endpoint: pushEndpoint,
          expirationTime: null,
          keys: { auth: "a".repeat(24), p256dh: "b".repeat(88) }
        },
        owner.sessionCookie
      );
      expect(resubscribed.id).toBe(subscription.id);
    } finally {
      await restoredApp.close();
      await restoredStore.close();
    }
  }, 20_000);

  it("persists a large batch of account sync changes in one bulk upsert instead of one round trip per row", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    const client = await pool.connect();

    // Exercises upsertAccountSyncChangesBulk directly against a real Postgres connection instead
    // of through the full HTTP + business-logic + saveRelationalCoreRecords pipeline - that outer
    // pipeline has its own, unrelated per-mutation cost (each mutating HTTP call also resaves the
    // full relational store, not just the sync journal) that would swamp a timing assertion aimed
    // specifically at this function. This mirrors the production incident directly: hundreds of
    // account_sync_changes rows queued for one flush after a cold start - the previous
    // upsertAccountSyncChangesOneByOne loop turned that into one sequential network round trip
    // per row (48s+ observed in production for ~700 rows).
    try {
      const ownerPhone = `254730${Date.now().toString().slice(-6)}`;
      await client.query(
        "insert into accounts (id, primary_auth_channel, primary_auth_destination, created_at) values ($1, 'phone', $2, now())",
        [randomUUID(), `+${ownerPhone}`]
      );
      const accountId = (
        await client.query<{ id: string }>(
          "select id from accounts where primary_auth_destination = $1",
          [`+${ownerPhone}`]
        )
      ).rows[0]?.id;
      if (accountId === undefined) throw new Error("Test account was not created.");

      const rowCount = 750;
      const changes = Array.from({ length: rowCount }, (_unused, index) => ({
        accountId,
        sequence: index + 1,
        cursor: randomUUID(),
        collection: "conversation_messages" as const,
        entityId: randomUUID(),
        operation: "upsert" as const,
        shopId: null,
        entity: { text: `Bulk sync message ${index}` },
        changedAt: new Date().toISOString(),
        tombstoneExpiresAt: null
      }));

      const startedAt = Date.now();
      await client.query("begin");
      await upsertAccountSyncChangesBulk(
        client as unknown as Parameters<typeof upsertAccountSyncChangesBulk>[0],
        changes
      );
      await client.query("commit");
      const durationMs = Date.now() - startedAt;
      // A loose regression guard, not a strict perf budget - the previous per-row loop would
      // reliably take tens of seconds on 750 rows even on a fast local Postgres (each round trip
      // alone dwarfs this budget once multiplied by 750); this just proves the fix isn't silently
      // reverted back to one round trip per row.
      expect(durationMs).toBeLessThan(5_000);

      const persistedCount = await client.query<{ count: string }>(
        "select count(*)::text as count from account_sync_changes where account_id = $1",
        [accountId]
      );
      expect(persistedCount.rows[0]?.count).toBe(String(rowCount));

      const lastRow = await client.query<{ entity: { text: string } }>(
        "select entity from account_sync_changes where account_id = $1 and sequence = $2",
        [accountId, rowCount]
      );
      expect(lastRow.rows[0]?.entity).toEqual({ text: `Bulk sync message ${rowCount - 1}` });
    } finally {
      client.release();
      await pool.end();
    }
  }, 15_000);

  it("saves only changed relational rows after boot instead of rewriting every account, user and session", async () => {
    // Regression: saveRelationalCoreRecords re-upserted every row of accounts/users/sessions/...
    // one round trip at a time on every save. Against Neon (~450ms per round trip) one save took
    // 319s, a network blip in that window failed it, nothing ever persisted, and every mutating
    // request (PIN login included) hung for the full 8s response deadline.
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const tag = uniqueTestTag();
    const seededCount = 30;
    let store = await createPostgresCp2Store({ databaseUrl: connectionString });
    try {
      const seeded = Array.from({ length: seededCount }, (_unused, index) =>
        store.continueWithChannelPin({
          channel: "phone",
          destination: `+2547${tag}${String(index).padStart(3, "0")}`,
          pin: "7421"
        })
      );
      await store.flush();
      await store.close();

      store = await createPostgresCp2Store({ databaseUrl: connectionString });
      const { Client } = requireApiDependency("pg") as {
        Client: { prototype: { query: (...args: unknown[]) => unknown } };
      };
      const statements: string[] = [];
      // Each statement keeps the client that ran it: background work (the parity refresh) runs
      // on other pool clients and can interleave, so ordering is only checked per client.
      const statementsByClient = new Map<unknown, string[]>();
      const originalQuery = Client.prototype.query;
      const querySpy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
        this: unknown,
        ...args: unknown[]
      ) {
        const [first] = args;
        const sql = typeof first === "string" ? first : (first as { text?: unknown } | null)?.text;
        if (typeof sql === "string") {
          statements.push(sql);
          const ownStatements = statementsByClient.get(this) ?? [];
          ownStatements.push(sql);
          statementsByClient.set(this, ownStatements);
        }
        return originalQuery.apply(this, args);
      });
      const infoSpy = vi.spyOn(console, "info");
      let added: ReturnType<typeof store.continueWithChannelPin>;
      try {
        added = store.continueWithChannelPin({
          channel: "phone",
          destination: `+2547${tag}999`,
          pin: "7421"
        });
        await store.flush();
      } finally {
        querySpy.mockRestore();
      }
      const savedEvents = infoSpy.mock.calls
        .map(([line]) => line)
        .filter(
          (line): line is string =>
            typeof line === "string" && line.includes("cp2_persistence_saved")
        )
        .map(
          (line) =>
            JSON.parse(line) as {
              relationalRecordsChanged: number;
              journalEntriesWritten: number;
              journal: string;
            }
        );
      infoSpy.mockRestore();
      // The trace for this change: the save reports how little it wrote. The journal holds every
      // seeded account's entries (2 each, >= 60), so a full journal re-send would show here.
      expect(savedEvents.length).toBeGreaterThan(0);
      const lastSave = savedEvents[savedEvents.length - 1];
      expect(lastSave?.relationalRecordsChanged).toBeGreaterThan(0);
      expect(lastSave?.relationalRecordsChanged).toBeLessThanOrEqual(10);
      expect(lastSave?.journalEntriesWritten).toBeGreaterThan(0);
      expect(lastSave?.journalEntriesWritten).toBeLessThanOrEqual(10);
      expect(lastSave?.journal).toBe("ok");

      const upserts = (table: string) =>
        statements.filter((sql) => new RegExp(`insert into ${table}\\s*\\(`).test(sql)).length;
      // Before the fix each of these equalled the table's full row count (>= seededCount + 1).
      expect(upserts("accounts")).toBe(1);
      expect(upserts("users")).toBe(1);
      expect(upserts("sessions")).toBeLessThanOrEqual(2);
      expect(upserts("account_pin_hashes")).toBe(1);
      // Untouched collections cannot have lost rows, so their delete queries are skipped too.
      const deletes = (table: string) =>
        statements.filter((sql) => new RegExp(`delete from ${table}\\s+where`).test(sql)).length;
      expect(deletes("suppliers")).toBe(0);
      expect(deletes("payments")).toBe(0);
      expect(deletes("mcp_access_tokens")).toBe(0);

      // Regression: a session-level pg_advisory_lock taken outside the transaction leaked through
      // Neon's transaction-mode PgBouncer and wedged every later save. Only the transaction-scoped
      // lock may be used, taken right after "begin" and a bounded lock_timeout, on the same client.
      expect(statements.some((sql) => /pg_advisory_(un)?lock\(/.test(sql))).toBe(false);
      let lockCount = 0;
      for (const ownStatements of statementsByClient.values()) {
        ownStatements.forEach((sql, index) => {
          if (!/pg_advisory_xact_lock\(/.test(sql)) return;
          lockCount += 1;
          expect(sql).toMatch(/^set local lock_timeout = '\d+ms'; select pg_advisory_xact_lock\(/);
          expect(ownStatements[index - 1]?.trim()).toBe("begin");
        });
      }
      expect(lockCount).toBeGreaterThan(0);

      // Skipping unchanged rows must not lose anything: a cold reload sees every account.
      await store.close();
      store = await createPostgresCp2Store({ databaseUrl: connectionString });
      for (const actor of [...seeded, added]) {
        expect(store.getSession(actor.session.id)?.account.id).toBe(actor.account.id);
      }
      expect(
        store.loginWithAccountPin({
          channel: "phone",
          destination: `+2547${tag}999`,
          pin: "7421"
        }).account.id
      ).toBe(added.account.id);
    } finally {
      await store.close();
    }
  }, 120_000);

  it("still deletes a removed relational row after skipping unchanged collections", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    let store = await createPostgresCp2Store({ databaseUrl: connectionString });
    try {
      const app = buildApi({ cp2: { store } });
      const owner = await createOwnerBusiness(app, `254706${Date.now().toString().slice(-6)}`);
      const businessId = owner.business.id;
      const supplier = await postJson<SupplierBusinessCardSummary>(
        app,
        `/businesses/${businessId}/suppliers`,
        { name: "Removed Supplier Ltd", phone: "+254711222334", email: null, notes: null },
        owner.sessionCookie
      );
      await app.close();
      await store.flush();
      await store.close();

      // Fresh boot: the delete must be detected against the loaded baseline, not a full rewrite.
      store = await createPostgresCp2Store({ databaseUrl: connectionString });
      const sessionId = readSessionCookie(owner.sessionCookie);
      store.deleteSupplier({ sessionId, businessId, supplierId: supplier.id });
      await store.flush();

      const remaining = await pool.query("select id from suppliers where id = $1", [supplier.id]);
      expect(remaining.rows).toHaveLength(0);
    } finally {
      await store.close();
      await pool.end();
    }
  }, 120_000);

  it("persists a logout that lands while a save is in flight (no in-place change baked into the baseline)", async () => {
    // Regression: store.snapshot() shares record objects that the store mutates in place. The
    // baseline used to be cloned after the awaited save, so a revocation made mid-save entered the
    // baseline unwritten, the trailing save diffed it as unchanged, and the logout was lost on
    // restart.
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const tag = uniqueTestTag();
    const { Client } = requireApiDependency("pg") as {
      Client: { prototype: { query: (...args: unknown[]) => unknown } };
    };
    let store = await createPostgresCp2Store({ databaseUrl: connectionString });
    try {
      const victim = store.continueWithChannelPin({
        channel: "phone",
        destination: `+2547${tag}001`,
        pin: "7421"
      });
      await store.flush();

      const originalQuery = Client.prototype.query;
      let loggedOutMidSave = false;
      const querySpy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
        this: unknown,
        ...args: unknown[]
      ) {
        const [first] = args;
        const sql = typeof first === "string" ? first : (first as { text?: string } | null)?.text;
        if (!loggedOutMidSave && sql?.trim() === "commit") {
          loggedOutMidSave = true;
          store.logout(victim.session.id);
        }
        return originalQuery.apply(this, args);
      });
      try {
        store.continueWithChannelPin({
          channel: "phone",
          destination: `+2547${tag}002`,
          pin: "7421"
        });
        await store.flush();
      } finally {
        querySpy.mockRestore();
      }
      expect(loggedOutMidSave).toBe(true);
      expect(store.getSession(victim.session.id)).toBeNull();

      await store.close();
      store = await createPostgresCp2Store({ databaseUrl: connectionString });
      expect(store.getSession(victim.session.id)).toBeNull();
    } finally {
      await store.close();
    }
  }, 120_000);

  it("re-sends journal entries a failed journal write left behind on the next save", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    const tag = uniqueTestTag();
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info");
    try {
      await pool.query(
        "alter table account_sync_changes add constraint force_journal_retry_failure check (false) not valid"
      );
      let missed: ReturnType<typeof store.continueWithChannelPin>;
      try {
        missed = store.continueWithChannelPin({
          channel: "phone",
          destination: `+2547${tag}001`,
          pin: "7421"
        });
        await store.flush();
        expect((await store.health()).syncJournal.status).toBe("degraded");
        // The relational rows did commit, so the trace still reports the save, marked failed.
        expect(
          infoSpy.mock.calls.some(
            ([line]) =>
              typeof line === "string" &&
              line.includes("cp2_persistence_saved") &&
              line.includes('"journal":"failed"')
          )
        ).toBe(true);
      } finally {
        await pool.query(
          "alter table account_sync_changes drop constraint if exists force_journal_retry_failure"
        );
      }
      const journalCount = async (accountId: string) =>
        Number(
          (
            await pool.query<{ count: string }>(
              "select count(*)::text as count from account_sync_changes where account_id = $1",
              [accountId]
            )
          ).rows[0]?.count
        );
      expect(await journalCount(missed.account.id)).toBe(0);

      store.continueWithChannelPin({
        channel: "phone",
        destination: `+2547${tag}002`,
        pin: "7421"
      });
      await store.flush();
      expect(await journalCount(missed.account.id)).toBeGreaterThan(0);
      expect((await store.health()).syncJournal.status).toBe("ok");
    } finally {
      consoleErrorSpy.mockRestore();
      infoSpy.mockRestore();
      await store.close();
      await pool.end();
    }
  }, 120_000);

  it("retries a boot-time journal backfill that failed", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.DB_PERSISTENCE_RETRY_INITIAL_MS = "50";
    process.env.DB_PERSISTENCE_RETRY_MAX_MS = "200";
    // The backfill only runs when the stored journal is empty, so park the journal and restore it.
    const client = await pool.connect();
    let store: Awaited<ReturnType<typeof createPostgresCp2Store>> | null = null;
    try {
      await client.query("create temp table parked as select * from account_sync_changes");
      await client.query("delete from account_sync_changes");
      await client.query(
        "alter table account_sync_changes add constraint force_boot_backfill_failure check (false) not valid"
      );
      try {
        store = await createPostgresCp2Store({ databaseUrl: connectionString });
        expect((await store.health()).syncJournal.status).toBe("degraded");
      } finally {
        await client.query(
          "alter table account_sync_changes drop constraint if exists force_boot_backfill_failure"
        );
      }
      expect(
        Number(
          (await client.query("select count(*)::text as count from account_sync_changes")).rows[0]
            ?.count
        )
      ).toBe(0);

      // No mutation: the retry scheduled at boot alone must write the backfilled journal.
      const bootStore = store;
      await waitUntil(async () => {
        const persisted = await client.query(
          "select count(*)::text as count from account_sync_changes"
        );
        return Number(persisted.rows[0]?.count) > 0;
      });
      await waitUntil(async () => (await bootStore.health()).syncJournal.status === "ok");
    } finally {
      await store?.close();
      await client
        .query("insert into account_sync_changes select * from parked on conflict do nothing")
        .catch(() => undefined);
      consoleErrorSpy.mockRestore();
      delete process.env.DB_PERSISTENCE_RETRY_INITIAL_MS;
      delete process.env.DB_PERSISTENCE_RETRY_MAX_MS;
      client.release();
      await pool.end();
    }
  }, 180_000);

  it("writes a hydration repair on the first save after boot (baseline is the loaded snapshot)", async () => {
    // The diff baseline must be what the database holds. If it were the hydrated store state,
    // anything hydrateSnapshot changes would look unchanged and never be written. Hydration here
    // repairs one user's display name in place (users are restored by reference, so this also
    // proves the baseline is cloned before hydration rather than sharing those records).
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    const tag = uniqueTestTag();
    let store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const repairedName = `Repaired on boot ${tag}`;
    let hydrateSpy: { mockRestore: () => void } | null = null;
    try {
      const actor = store.continueWithChannelPin({
        channel: "phone",
        destination: `+2547${tag}001`,
        pin: "7421"
      });
      await store.flush();
      await store.close();

      const originalHydrate = Cp2Store.prototype.hydrateSnapshot;
      hydrateSpy = vi.spyOn(Cp2Store.prototype, "hydrateSnapshot").mockImplementation(function (
        this: Cp2Store,
        snapshot
      ) {
        originalHydrate.call(this, snapshot);
        const user = this.snapshot().users.find((item) => item.id === actor.user.id);
        if (user !== undefined) user.displayName = repairedName;
      });
      store = await createPostgresCp2Store({ databaseUrl: connectionString });
      hydrateSpy.mockRestore();
      hydrateSpy = null;

      store.continueWithChannelPin({
        channel: "phone",
        destination: `+2547${tag}002`,
        pin: "7421"
      });
      await store.flush();

      const persisted = await pool.query<{ display_name: string }>(
        "select display_name from users where id = $1",
        [actor.user.id]
      );
      expect(persisted.rows[0]?.display_name).toBe(repairedName);
    } finally {
      hydrateSpy?.mockRestore();
      await store.close();
      await pool.end();
    }
  }, 120_000);

  it("fails a save fast with lock_not_available while another holder has the store lock, then recovers", async () => {
    // A lock leaked by an older build must not hang each save until the query timeout.
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    const tag = uniqueTestTag();
    process.env.DB_PERSISTENCE_RETRY_INITIAL_MS = "50";
    process.env.DB_PERSISTENCE_RETRY_MAX_MS = "200";
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const holder = await pool.connect();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await holder.query("select pg_advisory_lock(hashtext('grogoni.cp2.normalized_store'))");
      const holderPid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0]?.pid;
      const startedAt = Date.now();
      const added = store.continueWithChannelPin({
        channel: "phone",
        destination: `+2547${tag}001`,
        pin: "7421"
      });
      await expect(store.flush()).rejects.toMatchObject({ code: "55P03" });
      expect(Date.now() - startedAt).toBeLessThan(14_000);
      // The failure names who holds the lock and points at the runbook.
      await waitUntil(async () =>
        consoleErrorSpy.mock.calls.some(
          ([line]) => typeof line === "string" && line.includes("cp2_persistence_lock_unavailable")
        )
      );
      const holderLog = consoleErrorSpy.mock.calls
        .map(([line]) => line)
        .find(
          (line): line is string =>
            typeof line === "string" && line.includes("cp2_persistence_lock_unavailable")
        );
      const parsedHolderLog = JSON.parse(holderLog ?? "{}") as {
        holders?: { pid: number }[];
        runbook?: string;
      };
      expect(parsedHolderLog.holders?.map((item) => item.pid)).toContain(holderPid);
      expect(parsedHolderLog.runbook).toBe("docs/runbooks/cp2-store-lock-leak.md");

      await holder.query("select pg_advisory_unlock(hashtext('grogoni.cp2.normalized_store'))");
      await waitUntil(async () => {
        const row = await pool.query("select 1 from accounts where id = $1", [added.account.id]);
        return row.rows.length === 1;
      });
    } finally {
      await holder.query("select pg_advisory_unlock_all()").catch(() => undefined);
      holder.release();
      consoleErrorSpy.mockRestore();
      delete process.env.DB_PERSISTENCE_RETRY_INITIAL_MS;
      delete process.env.DB_PERSISTENCE_RETRY_MAX_MS;
      await store.close();
      await pool.end();
    }
  }, 120_000);

  it("retries a failed journal write on its own, without waiting for another mutation", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    const tag = uniqueTestTag();
    process.env.DB_PERSISTENCE_RETRY_INITIAL_MS = "50";
    process.env.DB_PERSISTENCE_RETRY_MAX_MS = "200";
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await pool.query(
        "alter table account_sync_changes add constraint force_journal_autoretry_failure check (false) not valid"
      );
      let missed: ReturnType<typeof store.continueWithChannelPin>;
      try {
        missed = store.continueWithChannelPin({
          channel: "phone",
          destination: `+2547${tag}001`,
          pin: "7421"
        });
        await store.flush();
        expect((await store.health()).syncJournal.status).toBe("degraded");
      } finally {
        await pool.query(
          "alter table account_sync_changes drop constraint if exists force_journal_autoretry_failure"
        );
      }
      // No further mutation: the scheduled retry alone must deliver the missed entries.
      await waitUntil(async () => {
        const rows = await pool.query("select 1 from account_sync_changes where account_id = $1", [
          missed.account.id
        ]);
        return rows.rows.length > 0;
      });
      await waitUntil(async () => (await store.health()).syncJournal.status === "ok");
    } finally {
      consoleErrorSpy.mockRestore();
      delete process.env.DB_PERSISTENCE_RETRY_INITIAL_MS;
      delete process.env.DB_PERSISTENCE_RETRY_MAX_MS;
      await store.close();
      await pool.end();
    }
  }, 120_000);

  it("deletes a purged business from Postgres after boot (account graph delete gate)", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    let store = await createPostgresCp2Store({ databaseUrl: connectionString });
    let app = buildApi({ cp2: { store } });
    try {
      const owner = await createOwnerBusiness(app, `254707${Date.now().toString().slice(-6)}`);
      const businessId = owner.business.id;
      await app.close();
      await store.flush();
      await store.close();

      store = await createPostgresCp2Store({ databaseUrl: connectionString });
      app = buildApi({ cp2: { store } });
      const deletion = await postJson<{ request: { id: string } }>(
        app,
        `/businesses/${businessId}/shop-deletion/request`,
        { shopId: owner.business.grogoniId },
        owner.sessionCookie
      );
      await postJson(
        app,
        `/businesses/${businessId}/shop-deletion/${deletion.request.id}/finalize`,
        { pin: "1234", acknowledgement: true, idempotencyKey: `purge-${businessId}` },
        owner.sessionCookie
      );
      expect(store.purgeExpiredShopDeletions(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000))).toBe(
        1
      );
      await store.flush();

      const remaining = await pool.query("select id from businesses where id = $1", [businessId]);
      expect(remaining.rows).toHaveLength(0);
    } finally {
      await app.close();
      await store.close().catch(() => undefined);
      await pool.end();
    }
  }, 120_000);

  it("deletes pruned journal tombstones from Postgres after boot (journal delete gate)", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    const tag = uniqueTestTag();
    let store = await createPostgresCp2Store({ databaseUrl: connectionString });
    let app = buildApi({ cp2: { store } });
    try {
      // Purging a shop journals a "shops" delete tombstone for the owner's devices.
      const owner = await createOwnerBusiness(app, `254708${Date.now().toString().slice(-6)}`);
      const businessId = owner.business.id;
      const deletion = await postJson<{ request: { id: string } }>(
        app,
        `/businesses/${businessId}/shop-deletion/request`,
        { shopId: owner.business.grogoniId },
        owner.sessionCookie
      );
      await postJson(
        app,
        `/businesses/${businessId}/shop-deletion/${deletion.request.id}/finalize`,
        { pin: "1234", acknowledgement: true, idempotencyKey: `tombstone-${businessId}` },
        owner.sessionCookie
      );
      store.purgeExpiredShopDeletions(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));
      await app.close();
      await store.flush();
      await store.close();

      const tombstones = await pool.query(
        `update account_sync_changes set tombstone_expires_at = now() - interval '1 day'
          where operation = 'delete' and entity_id = $1
          returning sequence`,
        [businessId]
      );
      expect(tombstones.rows.length).toBeGreaterThan(0);

      // Boot loads the expired tombstone; pulling prunes it in memory, and the next save must
      // delete it from Postgres.
      store = await createPostgresCp2Store({ databaseUrl: connectionString });
      app = buildApi({ cp2: { store } });
      // Pruning expired tombstones is journal-wide, so any PIN-verified session can trigger it.
      const reader = store.continueWithChannelPin({
        channel: "phone",
        destination: `+2547${tag}001`,
        pin: "7421"
      });
      store.pullSyncChanges({ sessionId: reader.session.id, cursor: null });
      store.continueWithChannelPin({
        channel: "phone",
        destination: `+2547${tag}002`,
        pin: "7421"
      });
      await store.flush();

      const remaining = await pool.query(
        "select 1 from account_sync_changes where operation = 'delete' and entity_id = $1",
        [businessId]
      );
      expect(remaining.rows).toHaveLength(0);
    } finally {
      await app.close();
      await store.close().catch(() => undefined);
      await pool.end();
    }
  }, 120_000);

  it("backs off retries while the journal keeps failing instead of retrying at the initial delay", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    const tag = uniqueTestTag();
    process.env.DB_PERSISTENCE_RETRY_INITIAL_MS = "25";
    process.env.DB_PERSISTENCE_RETRY_MAX_MS = "800";
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const journalFailures = () =>
      consoleErrorSpy.mock.calls.filter(
        ([line]) => typeof line === "string" && line.includes('"attemptedCollection"')
      ).length;
    try {
      await pool.query(
        "alter table account_sync_changes add constraint force_journal_backoff_failure check (false) not valid"
      );
      try {
        store.continueWithChannelPin({
          channel: "phone",
          destination: `+2547${tag}001`,
          pin: "7421"
        });
        await store.flush();
        const before = journalFailures();
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
        // Doubling from 25ms reaches the 800ms cap within ~1.5s: about 6 attempts in 2s. Without
        // backoff (delay reset to 25ms after every failed journal write) it would be dozens.
        expect(journalFailures() - before).toBeLessThanOrEqual(10);
      } finally {
        await pool.query(
          "alter table account_sync_changes drop constraint if exists force_journal_backoff_failure"
        );
      }
    } finally {
      consoleErrorSpy.mockRestore();
      delete process.env.DB_PERSISTENCE_RETRY_INITIAL_MS;
      delete process.env.DB_PERSISTENCE_RETRY_MAX_MS;
      await store.close();
      await pool.end();
    }
  }, 120_000);

  it("store-lock.mjs finds and releases only an idle leaked holder in this database", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const { findStoreLockHolders, releaseLeakedStoreLockHolders } =
      (await import("../services/api/scripts/store-lock-lib.mjs")) as {
        findStoreLockHolders: (client: TestPool) => Promise<{
          holders: { pid: number; state: string }[];
          waiters: { pid: number }[];
        }>;
        releaseLeakedStoreLockHolders: (
          client: TestPool
        ) => Promise<{ pid: number; terminated: boolean }[]>;
      };
    const pool = new Pool({ connectionString });
    const otherDatabaseUrl = connectionString.replace(/\/[^/?]+(\?|$)/, "/postgres$1");
    const otherPool = new Pool({ connectionString: otherDatabaseUrl });
    const leaked = await pool.connect();
    // Terminating this backend is the point of the test; swallow the resulting socket error.
    (leaked as unknown as { on: (event: string, listener: () => void) => void }).on(
      "error",
      () => undefined
    );
    const otherDatabaseHolder = await otherPool.connect();
    try {
      await leaked.query("select pg_advisory_lock(hashtext('grogoni.cp2.normalized_store'))");
      await otherDatabaseHolder.query(
        "select pg_advisory_lock(hashtext('grogoni.cp2.normalized_store'))"
      );
      const leakedPid = (await leaked.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0]?.pid;
      const otherPid = (
        await otherDatabaseHolder.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]?.pid;

      const found = await findStoreLockHolders(pool);
      const pids = found.holders.map((row) => row.pid);
      expect(pids).toContain(leakedPid);
      // pg_locks is server-wide: the same key held in another database must not match.
      expect(pids).not.toContain(otherPid);

      const released = await releaseLeakedStoreLockHolders(pool);
      expect(released).toContainEqual({ pid: leakedPid, terminated: true });
      expect(released.map((row) => row.pid)).not.toContain(otherPid);
      expect((await findStoreLockHolders(pool)).holders.map((row) => row.pid)).not.toContain(
        leakedPid
      );
    } finally {
      await otherDatabaseHolder.query("select pg_advisory_unlock_all()").catch(() => undefined);
      otherDatabaseHolder.release();
      leaked.release(true);
      await otherPool.end();
      await pool.end().catch(() => undefined);
    }
  }, 60_000);

  it("store-lock.mjs leaves a holder inside a transaction (a current-build save) alone", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const { releaseLeakedStoreLockHolders } =
      (await import("../services/api/scripts/store-lock-lib.mjs")) as {
        releaseLeakedStoreLockHolders: (
          client: TestPool
        ) => Promise<{ pid: number; terminated: boolean }[]>;
      };
    const pool = new Pool({ connectionString });
    const saving = await pool.connect();
    try {
      await saving.query("begin");
      await saving.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
      const savingPid = (await saving.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0]?.pid;
      const released = await releaseLeakedStoreLockHolders(pool);
      expect(released.map((row) => row.pid)).not.toContain(savingPid);
      await saving.query("commit");
    } finally {
      saving.release();
      await pool.end();
    }
  }, 60_000);

  it("keeps a receipt's unchanged line items when only one of them changes", async () => {
    // replaceReceiptLineItems deletes all items of each receipt it is given before re-inserting,
    // so a changed-only write must pass every item of a touched receipt, not just the changed one.
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const app = buildApi({ cp2: { store } });
    const pool = new Pool({ connectionString });
    const client = await pool.connect();
    try {
      const owner = await createOwnerBusiness(app, `254709${Date.now().toString().slice(-6)}`);
      const businessId = owner.business.id;
      const supplier = await postJson<SupplierBusinessCardSummary>(
        app,
        `/businesses/${businessId}/suppliers`,
        { name: "Two Item Wholesale", phone: "+254711222336", email: null, notes: null },
        owner.sessionCookie
      );
      const ocrJob = await postJson<ReceiptOCRJobSummary>(
        app,
        `/businesses/${businessId}/receipt-ocr/jobs`,
        {
          fileName: "receipt.txt",
          contentType: "text/plain",
          contentBase64: null,
          extractedText:
            "Supplier: Two Item Wholesale\nPhone: +254711222336\nTotal: 500\nItem A, 2, 100, 200\nItem B, 1, 300, 300"
        },
        owner.sessionCookie
      );
      const receipt = await postJson<PurchaseReceiptSummary>(
        app,
        `/businesses/${businessId}/receipt-ocr/jobs/${ocrJob.id}/confirm`,
        { supplierId: supplier.id },
        owner.sessionCookie
      );
      await store.flush();

      const previous = structuredClone(store.snapshot());
      const current = structuredClone(previous);
      const items = current.receiptLineItems.filter((item) => item.receiptId === receipt.id);
      expect(items).toHaveLength(2);
      const [edited, sibling] = items;
      if (edited === undefined || sibling === undefined) throw new Error("Missing line items.");
      edited.quantity = 5;

      await client.query("begin");
      await saveRelationalCoreRecords(
        client as unknown as Parameters<typeof saveRelationalCoreRecords>[0],
        current,
        previous
      );
      await client.query("commit");

      const persisted = await client.query<{ id: string; quantity: string }>(
        "select id, quantity::text from receipt_line_items where receipt_id = $1 order by id",
        [receipt.id]
      );
      expect(persisted.rows.map((row) => row.id).sort()).toEqual([edited.id, sibling.id].sort());
      expect(Number(persisted.rows.find((row) => row.id === edited.id)?.quantity)).toBe(5);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
      await app.close();
      await store.close();
      await pool.end();
    }
  }, 120_000);

  it("writes journal entries a failed write left behind when the store closes before the retry", async () => {
    // A graceful shutdown (SIGTERM -> close()) used to cancel the pending retry without a final
    // save, losing the missed entries for good: boot only backfills an empty journal.
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    const tag = uniqueTestTag();
    process.env.DB_PERSISTENCE_RETRY_INITIAL_MS = "60000";
    let store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await pool.query(
        "alter table account_sync_changes add constraint force_journal_close_failure check (false) not valid"
      );
      let missed: ReturnType<typeof store.continueWithChannelPin>;
      try {
        missed = store.continueWithChannelPin({
          channel: "phone",
          destination: `+2547${tag}001`,
          pin: "7421"
        });
        await store.flush();
        expect((await store.health()).syncJournal.status).toBe("degraded");
      } finally {
        await pool.query(
          "alter table account_sync_changes drop constraint if exists force_journal_close_failure"
        );
      }
      // The retry is a minute away; close now, as a SIGTERM would.
      await store.close();

      const persisted = await pool.query<{ count: number }>(
        "select count(*)::int as count from account_sync_changes where account_id = $1",
        [missed.account.id]
      );
      expect(persisted.rows[0]?.count).toBeGreaterThan(0);
      store = await createPostgresCp2Store({ databaseUrl: connectionString });
      expect(
        store.snapshot().syncChanges.filter((change) => change.accountId === missed.account.id)
          .length
      ).toBeGreaterThan(0);
    } finally {
      consoleErrorSpy.mockRestore();
      delete process.env.DB_PERSISTENCE_RETRY_INITIAL_MS;
      await store.close().catch(() => undefined);
      await pool.end();
    }
  }, 120_000);

  it("keeps retrying in close() when the save in flight and the first final attempt both fail", async () => {
    // Once closing, a failed save schedules no retry; without a final attempt the journal entries of
    // a save that fails mid-shutdown were lost for good (boot only backfills an empty journal).
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    const tag = uniqueTestTag();
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const { Client } = requireApiDependency("pg") as {
      Client: { prototype: { query: (...args: unknown[]) => unknown } };
    };
    const originalQuery = Client.prototype.query;
    // Fail the journal of the save in flight and of the first final attempt (each ends in a
    // rollback), then let the second final attempt through.
    let failedJournalTransactions = 0;
    let failJournal = true;
    const querySpy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      const [first] = args;
      const sql = typeof first === "string" ? first : (first as { text?: string } | null)?.text;
      if (failJournal && sql?.includes("insert into account_sync_changes")) {
        return Promise.reject(new Error("injected journal failure"));
      }
      if (failJournal && sql?.trim() === "rollback") {
        failedJournalTransactions += 1;
        if (failedJournalTransactions === 2) failJournal = false;
      }
      return originalQuery.apply(this, args);
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let added: ReturnType<typeof store.continueWithChannelPin>;
    try {
      added = store.continueWithChannelPin({
        channel: "phone",
        destination: `+2547${tag}001`,
        pin: "7421"
      });
      // Close while that save is still in flight.
      await store.close();
    } finally {
      querySpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
    try {
      expect(failedJournalTransactions).toBe(2);
      const persisted = await pool.query<{ count: number }>(
        "select count(*)::int as count from account_sync_changes where account_id = $1",
        [added.account.id]
      );
      expect(persisted.rows[0]?.count).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  }, 120_000);

  it("rejects close() when journal entries are still unsaved after the final attempt", async () => {
    // Exiting 0 would hide a permanent loss; the shutdown path logs a rejected close and exits 1.
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const tag = uniqueTestTag();
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const { Client } = requireApiDependency("pg") as {
      Client: { prototype: { query: (...args: unknown[]) => unknown } };
    };
    const originalQuery = Client.prototype.query;
    const querySpy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      const [first] = args;
      const sql = typeof first === "string" ? first : (first as { text?: string } | null)?.text;
      if (sql?.includes("insert into account_sync_changes")) {
        return Promise.reject(new Error("injected journal failure"));
      }
      return originalQuery.apply(this, args);
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      store.continueWithChannelPin({
        channel: "phone",
        destination: `+2547${tag}002`,
        pin: "7421"
      });
      await store.flush();
      expect((await store.health()).syncJournal.status).toBe("degraded");
      await expect(store.close()).rejects.toBeDefined();
    } finally {
      querySpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  }, 120_000);

  it("close() is idempotent: repeated calls share one shutdown", async () => {
    expect(databaseUrl).toBeDefined();
    const store = await createPostgresCp2Store({ databaseUrl: databaseUrl ?? "" });
    const first = store.close();
    expect(store.close()).toBe(first);
    await expect(first).resolves.toBeUndefined();
    // Calling again after shutdown must not end the pools a second time.
    await expect(store.close()).resolves.toBeUndefined();
  }, 60_000);

  it("keeps a failed save recorded when a later passkey ceremony write succeeds", async () => {
    // A passkey ceremony write is its own persistence operation. Its success used to clear the
    // failure of an earlier snapshot save, so flush() resolved and close() skipped its final save,
    // silently losing the failed snapshot's records.
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    const tag = uniqueTestTag();
    process.env.DB_PERSISTENCE_RETRY_INITIAL_MS = "60000";
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const { Client } = requireApiDependency("pg") as {
      Client: { prototype: { query: (...args: unknown[]) => unknown } };
    };
    const originalQuery = Client.prototype.query;
    const querySpy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      const [first] = args;
      const sql = typeof first === "string" ? first : (first as { text?: string } | null)?.text;
      if (sql?.includes("insert into accounts")) {
        return Promise.reject(new Error("injected relational failure"));
      }
      return originalQuery.apply(this, args);
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const added = store.continueWithChannelPin({
        channel: "phone",
        destination: `+2547${tag}001`,
        pin: "7421"
      });
      await expect(store.flush()).rejects.toThrow("injected relational failure");
      querySpy.mockRestore();

      await store.beginPasskeyAuthentication({ rpId: "localhost", purpose: "pin_recovery" });
      await expect(store.flush()).rejects.toThrow("injected relational failure");

      await store.close();
      const persisted = await pool.query("select 1 from accounts where id = $1", [
        added.account.id
      ]);
      expect(persisted.rows).toHaveLength(1);
    } finally {
      querySpy.mockRestore();
      consoleErrorSpy.mockRestore();
      delete process.env.DB_PERSISTENCE_RETRY_INITIAL_MS;
      await store.close().catch(() => undefined);
      await pool.end();
    }
  }, 120_000);

  it("rewrites a record whose save lost its commit acknowledgement, even after it reverts", async () => {
    // If a commit lands but the client sees an error, the baseline must stop trusting the touched
    // records: otherwise a value reverted before the next save diffs as unchanged and the database
    // keeps the reverted-away value forever.
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    const tag = uniqueTestTag();
    process.env.DB_PERSISTENCE_RETRY_INITIAL_MS = "60000";
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const { Client } = requireApiDependency("pg") as {
      Client: { prototype: { query: (...args: unknown[]) => unknown } };
    };
    const originalQuery = Client.prototype.query;
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const actor = store.continueWithChannelPin({
        channel: "phone",
        destination: `+2547${tag}001`,
        pin: "7421"
      });
      const created = store.createBusiness({
        sessionId: actor.session.id,
        name: "Ack Lost Shop",
        language: "en"
      }) as { business: { id: string } };
      const businessId = created.business.id;
      store.updateBusinessTimezone({
        sessionId: actor.session.id,
        businessId,
        timezone: "Africa/Nairobi"
      });
      await store.flush();

      let commitAckLost = false;
      const querySpy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
        this: unknown,
        ...args: unknown[]
      ) {
        const [first] = args;
        const sql = typeof first === "string" ? first : (first as { text?: string } | null)?.text;
        const result = originalQuery.apply(this, args);
        if (!commitAckLost && sql?.trim() === "commit") {
          commitAckLost = true;
          return (result as Promise<unknown>).then(() => {
            throw new Error("Connection terminated unexpectedly");
          });
        }
        return result;
      });
      try {
        store.updateBusinessTimezone({
          sessionId: actor.session.id,
          businessId,
          timezone: "Europe/London"
        });
        await expect(store.flush()).rejects.toThrow("Connection terminated unexpectedly");
      } finally {
        querySpy.mockRestore();
      }
      const landed = await pool.query<{ timezone: string }>(
        "select timezone from businesses where id = $1",
        [businessId]
      );
      expect(landed.rows[0]?.timezone).toBe("Europe/London");

      store.updateBusinessTimezone({
        sessionId: actor.session.id,
        businessId,
        timezone: "Africa/Nairobi"
      });
      await store.flush();
      const healed = await pool.query<{ timezone: string }>(
        "select timezone from businesses where id = $1",
        [businessId]
      );
      expect(healed.rows[0]?.timezone).toBe("Africa/Nairobi");
    } finally {
      consoleErrorSpy.mockRestore();
      delete process.env.DB_PERSISTENCE_RETRY_INITIAL_MS;
      await store.close().catch(() => undefined);
      await pool.end();
    }
  }, 120_000);

  it("still deletes a row whose delete commit failed, on the next unrelated save", async () => {
    // After a failed save the baseline drops the records the attempt touched, which would also hide
    // a deletion from the content-equality delete gate; the forced delete check must cover it.
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    const tag = uniqueTestTag();
    process.env.DB_PERSISTENCE_RETRY_INITIAL_MS = "60000";
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const app = buildApi({ cp2: { store } });
    const { Client } = requireApiDependency("pg") as {
      Client: { prototype: { query: (...args: unknown[]) => unknown } };
    };
    const originalQuery = Client.prototype.query;
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const owner = await createOwnerBusiness(app, `2547${tag}002`);
      const businessId = owner.business.id;
      const supplier = await postJson<SupplierBusinessCardSummary>(
        app,
        `/businesses/${businessId}/suppliers`,
        { name: "Failed Delete Supplier", phone: "+254711222337", email: null, notes: null },
        owner.sessionCookie
      );
      await store.flush();

      let commitFailed = false;
      const querySpy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
        this: unknown,
        ...args: unknown[]
      ) {
        const [first] = args;
        const sql = typeof first === "string" ? first : (first as { text?: string } | null)?.text;
        if (!commitFailed && sql?.trim() === "commit") {
          // Never sent: the transaction is rolled back, so the delete really did not happen.
          commitFailed = true;
          return Promise.reject(new Error("injected commit failure"));
        }
        return originalQuery.apply(this, args);
      });
      try {
        store.deleteSupplier({
          sessionId: readSessionCookie(owner.sessionCookie),
          businessId,
          supplierId: supplier.id
        });
        await expect(store.flush()).rejects.toThrow("injected commit failure");
      } finally {
        querySpy.mockRestore();
      }
      const stillThere = await pool.query("select 1 from suppliers where id = $1", [supplier.id]);
      expect(stillThere.rows).toHaveLength(1);

      store.continueWithChannelPin({
        channel: "phone",
        destination: `+2547${tag}003`,
        pin: "7421"
      });
      await store.flush();
      const removed = await pool.query("select 1 from suppliers where id = $1", [supplier.id]);
      expect(removed.rows).toHaveLength(0);
    } finally {
      consoleErrorSpy.mockRestore();
      delete process.env.DB_PERSISTENCE_RETRY_INITIAL_MS;
      await app.close();
      await store.close().catch(() => undefined);
      await pool.end();
    }
  }, 120_000);

  it("deletes a normalized-only record whose delete commit failed, and it stays gone after restart", async () => {
    // cp2_* collections are skipped when content-identical to the baseline; after a failed save
    // that shrank the baseline, a forced check must still rewrite (and so prune) the collection.
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    const tag = uniqueTestTag();
    process.env.DB_PERSISTENCE_RETRY_INITIAL_MS = "60000";
    let store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const { Client } = requireApiDependency("pg") as {
      Client: { prototype: { query: (...args: unknown[]) => unknown } };
    };
    const originalQuery = Client.prototype.query;
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const operator = store.continueWithChannelPin({
        channel: "phone",
        destination: `+2547${tag}001`,
        pin: "7421"
      });
      store.grantPlatformOperator({ accountId: operator.account.id, grantedBy: "test" });
      store.continueWithChannelPin({
        channel: "phone",
        destination: `+2547${tag}002`,
        pin: "7421"
      });
      await store.flush();
      const operatorRow = () =>
        pool.query("select 1 from cp2_platform_operators where entity_id = $1", [
          operator.account.id
        ]);
      expect((await operatorRow()).rows).toHaveLength(1);

      let commitFailed = false;
      const querySpy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
        this: unknown,
        ...args: unknown[]
      ) {
        const [first] = args;
        const sql = typeof first === "string" ? first : (first as { text?: string } | null)?.text;
        if (!commitFailed && sql?.trim() === "commit") {
          commitFailed = true;
          return Promise.reject(new Error("injected commit failure"));
        }
        return originalQuery.apply(this, args);
      });
      try {
        store.revokePlatformOperator(operator.account.id);
        store.continueWithChannelPin({
          channel: "phone",
          destination: `+2547${tag}003`,
          pin: "7421"
        });
        await expect(store.flush()).rejects.toThrow("injected commit failure");
      } finally {
        querySpy.mockRestore();
      }
      expect((await operatorRow()).rows).toHaveLength(1);

      store.continueWithChannelPin({
        channel: "phone",
        destination: `+2547${tag}004`,
        pin: "7421"
      });
      await store.flush();
      expect((await operatorRow()).rows).toHaveLength(0);

      await store.close();
      store = await createPostgresCp2Store({ databaseUrl: connectionString });
      expect(
        store.snapshot().platformOperators?.some((grant) => grant.accountId === operator.account.id)
      ).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
      delete process.env.DB_PERSISTENCE_RETRY_INITIAL_MS;
      await store.close().catch(() => undefined);
      await pool.end();
    }
  }, 120_000);

  it("keeps the journal delete check owed across two journal failures in a row", async () => {
    // The owed check only matters when the failing saves add no journal entries of their own (an
    // addition would force the check anyway): the first failing save here comes from a supplier
    // change (suppliers are not journaled) and the second from the retry timer, with no mutation.
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    const tag = uniqueTestTag();
    process.env.DB_PERSISTENCE_RETRY_INITIAL_MS = "50";
    process.env.DB_PERSISTENCE_RETRY_MAX_MS = "200";
    let store = await createPostgresCp2Store({ databaseUrl: connectionString });
    let app = buildApi({ cp2: { store } });
    const { Client } = requireApiDependency("pg") as {
      Client: { prototype: { query: (...args: unknown[]) => unknown } };
    };
    const originalQuery = Client.prototype.query;
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // A purged shop journals a "shops" delete tombstone; expire it so the next pull prunes it.
      const purged = await createOwnerBusiness(app, `2547${tag}010`);
      const purgedBusinessId = purged.business.id;
      const deletion = await postJson<{ request: { id: string } }>(
        app,
        `/businesses/${purgedBusinessId}/shop-deletion/request`,
        { shopId: purged.business.grogoniId },
        purged.sessionCookie
      );
      await postJson(
        app,
        `/businesses/${purgedBusinessId}/shop-deletion/${deletion.request.id}/finalize`,
        { pin: "1234", acknowledgement: true, idempotencyKey: `double-${purgedBusinessId}` },
        purged.sessionCookie
      );
      store.purgeExpiredShopDeletions(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));
      await app.close();
      await store.flush();
      await store.close();
      await pool.query(
        `update account_sync_changes set tombstone_expires_at = now() - interval '1 day'
          where operation = 'delete' and entity_id = $1`,
        [purgedBusinessId]
      );

      store = await createPostgresCp2Store({ databaseUrl: connectionString });
      app = buildApi({ cp2: { store } });
      const owner = await createOwnerBusiness(app, `2547${tag}011`);
      await store.flush();

      let failedJournalDeletes = 0;
      const querySpy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
        this: unknown,
        ...args: unknown[]
      ) {
        const [first] = args;
        const sql = typeof first === "string" ? first : (first as { text?: string } | null)?.text;
        if (failedJournalDeletes < 2 && sql?.includes("delete from account_sync_changes")) {
          failedJournalDeletes += 1;
          return Promise.reject(new Error("injected journal delete failure"));
        }
        return originalQuery.apply(this, args);
      });
      const tombstoneRows = async () =>
        (
          await pool.query(
            "select 1 from account_sync_changes where operation = 'delete' and entity_id = $1",
            [purgedBusinessId]
          )
        ).rows.length;
      try {
        const journalBefore = store.snapshot().syncChanges.length;
        store.pullSyncChanges({ sessionId: readSessionCookie(owner.sessionCookie), cursor: null });
        store.createSupplier({
          sessionId: readSessionCookie(owner.sessionCookie),
          businessId: owner.business.id,
          supplier: {
            name: "Prune Only Supplier",
            phone: "+254711222339",
            email: null,
            notes: null
          }
        });
        // Pruning removed the tombstone and the supplier added no journal entry.
        expect(store.snapshot().syncChanges.length).toBe(journalBefore - 1);
        await store.flush();
        // The retry timer makes the second, mutation-free attempt; the third succeeds.
        await waitUntil(async () => failedJournalDeletes === 2 && (await tombstoneRows()) === 0);
      } finally {
        querySpy.mockRestore();
      }
      expect(await tombstoneRows()).toBe(0);
    } finally {
      consoleErrorSpy.mockRestore();
      delete process.env.DB_PERSISTENCE_RETRY_INITIAL_MS;
      delete process.env.DB_PERSISTENCE_RETRY_MAX_MS;
      await app.close();
      await store.close().catch(() => undefined);
      await pool.end();
    }
  }, 120_000);

  it("deletes a record added by a save whose commit ack was lost, once memory deletes it", async () => {
    // The lost-ack save may have inserted the supplier. When it is deleted before the next
    // successful save, the collection looks unchanged against the shrunk baseline, so the attempt's
    // addition alone must force the delete pass, or the row survives and returns on restart.
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    const tag = uniqueTestTag();
    process.env.DB_PERSISTENCE_RETRY_INITIAL_MS = "60000";
    let store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const app = buildApi({ cp2: { store } });
    const { Client } = requireApiDependency("pg") as {
      Client: { prototype: { query: (...args: unknown[]) => unknown } };
    };
    const originalQuery = Client.prototype.query;
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const owner = await createOwnerBusiness(app, `2547${tag}020`);
      const businessId = owner.business.id;
      const sessionId = readSessionCookie(owner.sessionCookie);
      await store.flush();

      let commitAckLost = false;
      const querySpy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
        this: unknown,
        ...args: unknown[]
      ) {
        const [first] = args;
        const sql = typeof first === "string" ? first : (first as { text?: string } | null)?.text;
        const result = originalQuery.apply(this, args);
        if (!commitAckLost && sql?.trim() === "commit") {
          commitAckLost = true;
          return (result as Promise<unknown>).then(() => {
            throw new Error("Connection terminated unexpectedly");
          });
        }
        return result;
      });
      let supplierId: string;
      try {
        supplierId = store.createSupplier({
          sessionId,
          businessId,
          supplier: { name: "Ack Lost Supplier", phone: "+254711222338", email: null, notes: null }
        }).id;
        await expect(store.flush()).rejects.toThrow("Connection terminated unexpectedly");
      } finally {
        querySpy.mockRestore();
      }
      const supplierRows = async () =>
        (await pool.query("select 1 from suppliers where id = $1", [supplierId])).rows.length +
        (await pool.query("select 1 from cp2_suppliers where entity_id = $1", [supplierId])).rows
          .length;
      expect(await supplierRows()).toBeGreaterThan(0);

      store.deleteSupplier({ sessionId, businessId, supplierId });
      await store.flush();
      expect(await supplierRows()).toBe(0);

      await app.close();
      await store.close();
      store = await createPostgresCp2Store({ databaseUrl: connectionString });
      expect(store.snapshot().suppliers.some((supplier) => supplier.id === supplierId)).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
      delete process.env.DB_PERSISTENCE_RETRY_INITIAL_MS;
      await app.close();
      await store.close().catch(() => undefined);
      await pool.end();
    }
  }, 120_000);

  it("loads every normalized collection in one query with the same rows and order as one query per table", async () => {
    expect(databaseUrl).toBeDefined();
    const pool = new Pool({ connectionString: databaseUrl ?? "" });
    try {
      const combined = await pool.query<{ collection_index: number; records: unknown[] }>(
        buildNormalizedSnapshotSql(normalizedCollections)
      );
      // union all may return branches in any order; the loader keys rows by collection_index.
      expect(combined.rows.map((row) => row.collection_index).sort((a, b) => a - b)).toEqual(
        normalizedCollections.map((_collection, index) => index)
      );
      for (const row of combined.rows) {
        const collection = normalizedCollections[row.collection_index];
        if (collection === undefined) throw new Error("Unknown collection index.");
        const perTable = await pool.query<{ record: unknown }>(
          `select record from ${collection.tableName} order by entity_id`
        );
        expect(row.records, collection.tableName).toEqual(perTable.rows.map((r) => r.record));
      }
    } finally {
      await pool.end();
    }
  }, 60_000);

  it("leaves unchanged account sync changes untouched on re-upsert and still updates changed rows", async () => {
    expect(databaseUrl).toBeDefined();
    const pool = new Pool({ connectionString: databaseUrl ?? "" });
    const client = await pool.connect();
    // Persistence re-sends the whole sync journal on every save. Before the is-distinct-from guard,
    // each save rewrote every row, which bloated account_sync_changes (~26k rewrites per row in
    // the Neon database). xmin changes only when Postgres writes a new row version.
    try {
      const accountId = randomUUID();
      await client.query(
        "insert into accounts (id, primary_auth_channel, primary_auth_destination, created_at) values ($1, 'phone', $2, now())",
        [accountId, `+254732${Date.now().toString().slice(-6)}`]
      );
      const changes = [1, 2, 3].map((sequence) => ({
        accountId,
        sequence,
        cursor: randomUUID(),
        collection: "conversation_messages" as const,
        entityId: randomUUID(),
        operation: "upsert" as const,
        shopId: null,
        entity: { text: `message ${sequence}` },
        changedAt: new Date().toISOString(),
        tombstoneExpiresAt: null
      }));
      const upsert = (rows: typeof changes) =>
        upsertAccountSyncChangesBulk(
          client as unknown as Parameters<typeof upsertAccountSyncChangesBulk>[0],
          rows
        );
      const versions = async () =>
        (
          await client.query<{ sequence: string; xmin: string; entity: { text: string } }>(
            "select sequence::text, xmin::text, entity from account_sync_changes where account_id = $1 order by sequence",
            [accountId]
          )
        ).rows;

      await upsert(changes);
      const initial = await versions();

      await upsert(changes);
      expect(await versions()).toEqual(initial);

      const edited = changes.map((change) =>
        change.sequence === 2 ? { ...change, entity: { text: "edited" } } : change
      );
      await upsert(edited);
      const after = await versions();
      expect(after[0]).toEqual(initial[0]);
      expect(after[2]).toEqual(initial[2]);
      expect(after[1]?.xmin).not.toBe(initial[1]?.xmin);
      expect(after[1]?.entity).toEqual({ text: "edited" });
    } finally {
      client.release();
      await pool.end();
    }
  }, 15_000);

  it("never rewrites an untouched expired session; the compatibility copy is revoked once, then left alone", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    // sessions_retention_trigger fires before insert or update, so it stamps the proposed row of
    // an expired session as revoked and the unchanged-row guard lets that write through. This
    // builds a session that expired after its last write, so memory and database otherwise agree.
    try {
      const firstStore = await createPostgresCp2Store({ databaseUrl: connectionString });
      const firstApp = buildApi({ cp2: { store: firstStore } });
      const owner = await createOwnerBusiness(firstApp, `254733${Date.now().toString().slice(-6)}`);
      await firstApp.close();
      await firstStore.close();
      const sessionId = readSessionCookie(owner.sessionCookie);
      if (sessionId === null) throw new Error("Owner session cookie was not issued.");

      const expiredAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await pool.query("alter table sessions disable trigger sessions_retention_trigger");
      await pool.query("alter table cp2_sessions disable trigger cp2_sessions_retention_trigger");
      try {
        await pool.query(
          "update sessions set expires_at = $2, refresh_expires_at = $2, inactivity_expires_at = $2, revoked_at = null where id = $1",
          [sessionId, expiredAt]
        );
        await pool.query(
          `update cp2_sessions
              set record = jsonb_set(jsonb_set(jsonb_set(record, '{expiresAt}', to_jsonb($2::text)),
                '{refreshExpiresAt}', to_jsonb($2::text)), '{inactivityExpiresAt}', to_jsonb($2::text)) - 'revokedAt'
            where entity_id = $1`,
          [sessionId, expiredAt]
        );
      } finally {
        await pool.query("alter table sessions enable trigger sessions_retention_trigger");
        await pool.query("alter table cp2_sessions enable trigger cp2_sessions_retention_trigger");
      }

      const relationalBeforeSave = (
        await pool.query<{
          revoked_at: Date | null;
          revocation_reason: string | null;
          xmin: string;
        }>("select revoked_at, revocation_reason, xmin::text from sessions where id = $1", [
          sessionId
        ])
      ).rows[0];

      const secondStore = await createPostgresCp2Store({ databaseUrl: connectionString });
      const secondApp = buildApi({ cp2: { store: secondStore } });
      await createOwnerBusiness(secondApp, `254734${Date.now().toString().slice(-6)}`);
      await secondApp.close();
      await secondStore.close();

      const revokedRow = async () =>
        (
          await pool.query<{
            revoked_at: Date | null;
            revocation_reason: string | null;
            xmin: string;
          }>("select revoked_at, revocation_reason, xmin::text from sessions where id = $1", [
            sessionId
          ])
        ).rows[0];
      const compatibilityRow = async () =>
        (
          await pool.query<{ record: { revokedAt?: string | null }; xmin: string }>(
            "select record, xmin::text from cp2_sessions where entity_id = $1",
            [sessionId]
          )
        ).rows[0];
      // Saves write only relational rows that changed since load, so the untouched expired session
      // is not rewritten at all (same xmin). Before, every save re-upserted all 418 Neon sessions
      // one round trip at a time. Leaving revoked_at null is safe: getSession and refresh enforce
      // every expiry on use, and nothing purges by revoked_at.
      const revoked = await revokedRow();
      expect(revoked).toEqual(relationalBeforeSave);
      // The normalized cp2_sessions collection is still saved whole when it changes, so its
      // retention trigger revokes the expired copy once...
      const compatibilityRevoked = await compatibilityRow();
      expect(compatibilityRevoked?.record.revokedAt).toBeTruthy();

      // ...and later saves must not rewrite it again: the trigger would stamp a fresh revokedAt on
      // every save without the guard's expired-revocation carve-out.
      const thirdStore = await createPostgresCp2Store({ databaseUrl: connectionString });
      const thirdApp = buildApi({ cp2: { store: thirdStore } });
      await createOwnerBusiness(thirdApp, `254735${Date.now().toString().slice(-6)}`);
      await thirdApp.close();
      await thirdStore.close();
      expect(await revokedRow()).toEqual(revoked);
      expect(await compatibilityRow()).toEqual(compatibilityRevoked);
    } finally {
      await pool.end();
    }
  }, 45_000);

  it("keeps a session refreshable across a restart after only its access token has expired", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    // Repro for migration 106: the retention trigger used to revoke a session on any write once
    // its ~15 minute access token (expires_at) had passed, although refresh stays valid for 30
    // days. After a restart the session loaded as revoked and refresh answered
    // auth_refresh_revoked, signing out everyone idle for more than ~15 minutes.
    try {
      const firstStore = await createPostgresCp2Store({ databaseUrl: connectionString });
      const firstApp = buildApi({ cp2: { store: firstStore } });
      const signup = await firstApp.inject({
        method: "POST",
        url: "/auth/pin/signup",
        headers: jsonHeaders(),
        payload: JSON.stringify({
          method: "phone",
          contact: `254736${Date.now().toString().slice(-6)}`,
          pin: "1234"
        })
      });
      expect(signup.statusCode).toBe(200);
      const setCookies = [signup.headers["set-cookie"]].flat().map(String);
      const cookies = setCookies.map((cookie) => cookie.split(";")[0] ?? "").join("; ");
      const sessionId = readSessionCookie(cookies);
      if (sessionId === null) throw new Error("Session cookie was not issued.");
      expect(cookies).toContain("grogoni_refresh=");
      await firstApp.close();
      await firstStore.close();

      // The access token expires while the refresh lifetime is intact. This write goes through
      // the retention triggers exactly like the API's own persistence writes do.
      const accessExpiredAt = new Date(Date.now() - 60 * 1000).toISOString();
      await pool.query("update sessions set expires_at = $2 where id = $1", [
        sessionId,
        accessExpiredAt
      ]);
      await pool.query(
        "update cp2_sessions set record = jsonb_set(record, '{expiresAt}', to_jsonb($2::text)) where entity_id = $1",
        [sessionId, accessExpiredAt]
      );
      const stored = await pool.query<{ revoked_at: Date | null }>(
        "select revoked_at from sessions where id = $1",
        [sessionId]
      );
      expect(stored.rows[0]?.revoked_at).toBeNull();

      const secondStore = await createPostgresCp2Store({ databaseUrl: connectionString });
      const secondApp = buildApi({ cp2: { store: secondStore } });
      try {
        const refresh = await secondApp.inject({
          method: "POST",
          url: "/auth/session/refresh",
          headers: { cookie: cookies }
        });
        expect(refresh.statusCode, refresh.body).toBe(200);
      } finally {
        await secondApp.close();
        await secondStore.close();
      }
    } finally {
      await pool.end();
    }
  }, 45_000);

  it("migration 106 restores trigger-revoked refreshable sessions and leaves truly expired ones revoked", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    const pool = new Pool({ connectionString });
    try {
      const store = await createPostgresCp2Store({ databaseUrl: connectionString });
      const app = buildApi({ cp2: { store } });
      const refreshable = await createOwnerBusiness(
        app,
        `254737${Date.now().toString().slice(-6)}`
      );
      const lapsed = await createOwnerBusiness(app, `254738${Date.now().toString().slice(-6)}`);
      await app.close();
      await store.close();
      const refreshableId = readSessionCookie(refreshable.sessionCookie);
      const lapsedId = readSessionCookie(lapsed.sessionCookie);
      if (refreshableId === null || lapsedId === null) throw new Error("Sessions were not issued.");

      // Recreate the state the old trigger left behind: both rows revoked as 'expired', only one
      // of them past its refreshable lifetime.
      const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await pool.query("alter table sessions disable trigger sessions_retention_trigger");
      try {
        await pool.query(
          "update sessions set expires_at = $2, revoked_at = $2, revocation_reason = 'expired' where id = $1",
          [refreshableId, past]
        );
        await pool.query(
          "update sessions set expires_at = $2, refresh_expires_at = $2, inactivity_expires_at = $2, revoked_at = $2, revocation_reason = 'expired' where id = $1",
          [lapsedId, past]
        );
      } finally {
        await pool.query("alter table sessions enable trigger sessions_retention_trigger");
      }

      const migration = await readFile(
        "infra/db/migrations/106_session_retention_uses_refresh_lifetime.sql",
        "utf8"
      );
      await pool.query(migration);

      const rows = await pool.query<{
        id: string;
        revoked_at: Date | null;
        revocation_reason: string | null;
      }>("select id, revoked_at, revocation_reason from sessions where id = any($1::uuid[])", [
        [refreshableId, lapsedId]
      ]);
      const byId = new Map(rows.rows.map((row) => [row.id, row]));
      expect(byId.get(refreshableId)).toMatchObject({ revoked_at: null, revocation_reason: null });
      expect(byId.get(lapsedId)?.revoked_at).not.toBeNull();
      expect(byId.get(lapsedId)?.revocation_reason).toBe("expired");
    } finally {
      await pool.end();
    }
  }, 45_000);

  it("saves a large normalized collection in a few round trips, last duplicate wins, unchanged rows untouched", async () => {
    expect(databaseUrl).toBeDefined();
    const pool = new Pool({ connectionString: databaseUrl ?? "" });
    const client = await pool.connect();
    // saveCollectionRecords used to send one insert per record, so saving cp2_audit_events
    // (~1,400 rows in the Neon database) cost ~1,400 round trips. Count them directly.
    let queries = 0;
    const counting = {
      query: (sql: string, values?: unknown[]) => {
        queries += 1;
        return client.query(sql, values);
      }
    };
    const collection = normalizedCollections.find((entry) => entry.key === "auditEvents");
    if (collection === undefined) throw new Error("auditEvents collection is missing.");
    const save = (records: Array<Record<string, unknown>>) =>
      saveCollectionRecords(
        counting as unknown as Parameters<typeof saveCollectionRecords>[0],
        collection,
        records as unknown as Parameters<typeof saveCollectionRecords>[2]
      );
    const prefix = `bulk-audit-${randomUUID()}`;
    try {
      await client.query("begin");
      const existing = await client.query<{ record: Record<string, unknown> }>(
        "select record from cp2_audit_events order by entity_id"
      );
      const records = [
        ...existing.rows.map((row) => row.record),
        ...Array.from({ length: 2_500 }, (_unused, index) => ({
          id: `${prefix}-${index}`,
          type: "test.bulk",
          occurredAt: new Date().toISOString(),
          payload: { index }
        }))
      ];
      records.push({ id: `${prefix}-0`, type: "test.bulk", payload: { index: "last wins" } });

      queries = 0;
      await save(records);
      // select existing ids, then ceil(rows / 1,000) upserts; never one per row.
      expect(queries).toBeLessThanOrEqual(2 + Math.ceil(records.length / 1_000));

      const duplicate = await client.query<{ record: { payload: { index: unknown } } }>(
        "select record from cp2_audit_events where entity_id = $1",
        [`${prefix}-0`]
      );
      expect(duplicate.rows[0]?.record.payload.index).toBe("last wins");
      const count = await client.query<{ count: string }>(
        "select count(*)::text as count from cp2_audit_events where entity_id like $1",
        [`${prefix}-%`]
      );
      expect(count.rows[0]?.count).toBe("2500");

      const versions = async () =>
        (
          await client.query<{ entity_id: string; xmin: string }>(
            "select entity_id, xmin::text from cp2_audit_events where entity_id like $1 order by entity_id",
            [`${prefix}-%`]
          )
        ).rows;
      await client.query("commit");
      await client.query("begin");
      const before = await versions();
      await save(records);
      expect(await versions()).toEqual(before);
      await client.query("rollback");
    } finally {
      await client.query("delete from cp2_audit_events where entity_id like $1", [`${prefix}-%`]);
      client.release();
      await pool.end();
    }
  }, 60_000);

  it("attributes a bulk sync-change persistence failure to the exact account/collection via the row-by-row fallback", async () => {
    expect(databaseUrl).toBeDefined();
    const connectionString = databaseUrl ?? "";
    process.env.DB_PERSISTENCE_RETRY_INITIAL_MS = "50";
    process.env.DB_PERSISTENCE_RETRY_MAX_MS = "200";
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const app = buildApi({ cp2: { store } });
    const pool = new Pool({ connectionString });

    try {
      const ownerPhone = `254731${Date.now().toString().slice(-6)}`;
      const owner = await createOwnerBusiness(app, ownerPhone);
      const conversation = await postJson<ConversationView>(
        app,
        "/v1/conversations",
        { kind: "personal", activeShopId: null },
        owner.sessionCookie
      );
      await store.flush();

      // Force every future write to account_sync_changes to fail, mirroring the existing
      // "force_persistence_failure" pattern used for cp2_products above - upsertAccountSyncChangesBulk
      // (the new single-statement fast path) has no way to say which row in the batch caused a
      // failure like this, so it must fall back to upsertAccountSyncChangesOneByOne to preserve
      // AccountSyncPersistenceError's per-account/collection attribution.
      await pool.query(
        "alter table account_sync_changes add constraint force_sync_persistence_failure check (false) not valid"
      );

      // Account sync journal failures are deliberately non-critical (see the "keeps PIN
      // authentication available when only account sync persistence fails" test above and the
      // in-source rationale near lastSyncPersistenceError) - store.flush() only rejects for
      // critical persistence failures, so the sync-journal failure surfaces through
      // store.health().syncJournal and the structured console.error line
      // logAccountSyncDegradation emits, not through flush() rejecting.
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const clientMessageId = `fallback-attribution-${Date.now()}`;
      await postJson(
        app,
        "/v1/messages",
        {
          conversationId: conversation.conversation.id,
          clientMessageId,
          content: { type: "text", text: "Should fail to persist its sync change" }
        },
        owner.sessionCookie
      );

      await waitUntil(async () => (await store.health()).syncJournal.status === "degraded");

      // upsertAccountSyncChangesBulk (the new single-statement fast path) has no way to say which
      // row in a batch caused a failure like this - proves it fell back to
      // upsertAccountSyncChangesOneByOne, which still attributes the failure to the real
      // account/collection that caused it rather than a generic, unattributed rejection. The
      // fallback processes the whole snapshot in order and the force-false constraint applies to
      // every row equally, so the first collection it happens to hit (not necessarily
      // "conversation_messages" - could be an earlier row like "conversations") is what gets named.
      expect(
        consoleErrorSpy.mock.calls.some(
          ([line]) =>
            typeof line === "string" &&
            ACCOUNT_SYNC_COLLECTIONS.some((collection) =>
              line.includes(`"attemptedCollection":"${collection}"`)
            )
        )
      ).toBe(true);
      consoleErrorSpy.mockRestore();

      const persistedChange = await pool.query(
        "select 1 from account_sync_changes where collection = 'conversation_messages' and entity_id = (select id::text from conversation_messages where client_message_id = $1)",
        [clientMessageId]
      );
      expect(persistedChange.rows).toHaveLength(0);

      await pool.query(
        "alter table account_sync_changes drop constraint force_sync_persistence_failure"
      );
      await waitUntil(async () => (await store.health()).persistenceError === null);
    } finally {
      await pool
        .query(
          "alter table account_sync_changes drop constraint if exists force_sync_persistence_failure"
        )
        .catch(() => undefined);
      await pool.end();
      await app.close();
      await store.close();
      delete process.env.DB_PERSISTENCE_RETRY_INITIAL_MS;
      delete process.env.DB_PERSISTENCE_RETRY_MAX_MS;
    }
  }, 20_000);
});

async function rowUpdatedAt(
  pool: SqlExecutor,
  tableName: string,
  entityId: string
): Promise<string | null> {
  const result = await pool.query<{ updated_at: string }>(
    `select updated_at::text as updated_at from ${tableName} where entity_id = $1`,
    [entityId]
  );
  return result.rows[0]?.updated_at ?? null;
}

async function waitUntil(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Condition was not met within the timeout.");
}

async function syncCount(pool: SqlExecutor, accountId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "select count(*)::text as count from account_sync_changes where account_id = $1",
    [accountId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function insertMigrationTestAccount(
  client: TestPoolClient,
  accountId: string
): Promise<void> {
  const phoneSuffix = accountId.replaceAll(/\D/gu, "").padEnd(9, "0").slice(0, 9);
  await client.query(
    `
      insert into accounts (
        id, primary_auth_channel, primary_auth_destination, created_at
      )
      values ($1, 'phone', $2, now())
    `,
    [accountId, `+254${phoneSuffix}`]
  );
}

async function insertMigrationTestSyncChange(
  client: TestPoolClient,
  accountId: string,
  collection: string
): Promise<void> {
  await client.query(
    `
      insert into account_sync_changes (
        account_id, sequence, cursor, collection, entity_id, operation,
        shop_id, entity, changed_at, tombstone_expires_at
      )
      values ($1, 1, $2, $3, 'migration-test', 'upsert', null, '{}'::jsonb, now(), null)
    `,
    [accountId, randomUUID(), collection]
  );
}

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  destination: string
): Promise<CreateBusinessResponse & { sessionCookie: string }> {
  const verifyResponse = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({
      method: "phone",
      contact: destination,
      pin: "1234"
    })
  });
  const sessionCookie = extractSessionCookie(verifyResponse.headers["set-cookie"]);
  const business = await postJson<CreateBusinessResponse>(
    app,
    "/businesses",
    {
      name: "Postgres Persistent Shop",
      language: "en"
    },
    sessionCookie
  );

  return {
    ...business,
    sessionCookie
  };
}

async function postJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  cookie?: string
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: {
      ...jsonHeaders(),
      ...(cookie === undefined ? {} : { cookie })
    },
    payload: JSON.stringify(payload)
  });

  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode).toBeLessThan(300);
  return response.json<T>();
}

async function putJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  cookie?: string
): Promise<T> {
  const response = await app.inject({
    method: "PUT",
    url,
    headers: {
      ...jsonHeaders(),
      ...(cookie === undefined ? {} : { cookie })
    },
    payload: JSON.stringify(payload)
  });

  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode).toBeLessThan(300);
  return response.json<T>();
}

async function patchJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  cookie?: string
): Promise<T> {
  const response = await app.inject({
    method: "PATCH",
    url,
    headers: {
      ...jsonHeaders(),
      ...(cookie === undefined ? {} : { cookie })
    },
    payload: JSON.stringify(payload)
  });

  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode).toBeLessThan(300);
  return response.json<T>();
}

async function getJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  cookie: string
): Promise<T> {
  const response = await app.inject({
    method: "GET",
    url,
    headers: {
      cookie
    }
  });

  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

function jsonHeaders() {
  return {
    "content-type": "application/json"
  };
}

function extractSessionCookie(header: string | string[] | number | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  expect(typeof value).toBe("string");
  return String(value).split(";")[0] ?? "";
}
