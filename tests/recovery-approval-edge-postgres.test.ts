import { generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { Pool as PgPool, PoolClient } from "pg";
import { createCp2Store } from "../services/api/src/cp2/store";
import { createEdgeSnapshotScope } from "../services/api/src/cp2/edge-snapshot-scope";
import { createAuthRoutes } from "../supabase/functions/api/auth-routes";
import type { Transaction } from "../supabase/functions/api/session-routes";
import {
  loadTransactionalCp2Snapshot,
  saveTransactionalCp2Snapshot
} from "../services/api/src/cp2/postgres-store";

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };
type Store = ReturnType<typeof createCp2Store>;

function randomPhone(): string {
  return `+2547${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
}

/**
 * One Edge request: scope the snapshot to what this request names, load only that, run the
 * store, and persist the difference. Exactly what edge-domain-routes.ts does per request.
 */
async function edgeRequest<T>(
  client: PoolClient,
  path: string,
  input: { cookie?: string; body?: Record<string, unknown> },
  act: (store: Store) => T | Promise<T>
): Promise<{ result: T; loaded: Awaited<ReturnType<typeof loadTransactionalCp2Snapshot>> }> {
  const payload = input.body ? Buffer.from(JSON.stringify(input.body)) : undefined;
  const request = new Request(`https://grogoni.com/api${path}`, {
    method: payload ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      ...(input.cookie ? { cookie: input.cookie } : {})
    },
    ...(payload ? { body: payload } : {})
  });
  const scope = await createEdgeSnapshotScope(client, request, path, payload);
  const loaded = await loadTransactionalCp2Snapshot(client, scope);
  const store = createCp2Store();
  store.hydrateSnapshot(structuredClone(loaded));
  const result = await act(store);
  await saveTransactionalCp2Snapshot(client, store.snapshot(), loaded);
  return { result, loaded };
}

describe.skipIf(!databaseUrl)("trusted-device recovery approval on Edge with PostgreSQL", () => {
  it("carries one request from a signed-out browser to an approved session across scoped requests", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const phone = randomPhone();
      const strangerPhone = randomPhone();
      const seed = createCp2Store();
      const baseline = seed.snapshot();
      const owner = seed.signupWithPhonePin({ destination: phone, pin: "3927" });
      const stranger = seed.signupWithPhonePin({ destination: strangerPhone, pin: "6180" });
      const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const credentialId = seed.continueWithDevice({
        sessionId: owner.session.id,
        idempotencyKey: null,
        devicePublicKeyJwk: keys.publicKey.export({ format: "jwk" }),
        deviceSecurity: true
      }).deviceRecoveryCredentialId!;
      const seeded = seed.snapshot();
      // A test key has no Google chain; record the attestation verdict the server would reach.
      seeded.deviceRecoveryCredentials!.find((key) => key.id === credentialId)!.attested = true;
      await saveTransactionalCp2Snapshot(client, seeded, baseline);
      const ownerCookie = `grogoni_session=${owner.session.id}`;

      // A request for someone else, which nothing below may load or approve.
      await edgeRequest(
        client,
        "/auth/recovery/device-approval/start",
        { body: { identifier: strangerPhone } },
        (store) =>
          store.startRecoveryApproval({
            clientKey: "client-a",
            identifier: strangerPhone,
            client: "Other"
          })
      );

      const { result: started } = await edgeRequest(
        client,
        "/auth/recovery/device-approval/start",
        { body: { identifier: phone } },
        (store) =>
          store.startRecoveryApproval({
            clientKey: "client-a",
            identifier: phone,
            client: "Chrome on Android"
          })
      );
      const poll = { transactionId: started.transactionId, pollSecret: started.pollSecret };

      const pending = await edgeRequest(
        client,
        "/auth/recovery/device-approval/status",
        { body: poll },
        (store) => store.recoveryApprovalStatus(poll)
      );
      expect(pending.result).toMatchObject({ status: "pending" });

      const listed = await edgeRequest(
        client,
        "/auth/recovery/device-approval/pending",
        { cookie: ownerCookie },
        (store) => store.pendingRecoveryApprovals({ sessionId: owner.session.id })
      );
      expect(listed.result.requests.map((request) => request.requestId)).toEqual([
        started.transactionId
      ]);
      // Tenant isolation: the stranger's open request never reaches the owner's snapshot.
      expect(
        (listed.loaded.authTransactions ?? []).some(
          (record) => record.identifierValue === strangerPhone
        )
      ).toBe(false);

      const { result: options } = await edgeRequest(
        client,
        "/auth/recovery/device-approval/options",
        {
          cookie: ownerCookie,
          body: { code: started.code, method: "device", credentialId }
        },
        (store) =>
          store.beginRecoveryApproval({
            sessionId: owner.session.id,
            code: started.code,
            method: "device",
            credentialId
          })
      );
      if (options.method !== "device") throw new Error("expected a device challenge");
      const { challenge } = options;
      const signature = sign(
        "sha256",
        Buffer.from(
          `grogoni-device-recovery:v1:${credentialId}:${challenge.issuedAt}:${challenge.nonce}`
        ),
        { key: keys.privateKey, dsaEncoding: "ieee-p1363" }
      ).toString("base64url");
      const approval = {
        requestId: options.requestId,
        method: "device" as const,
        credentialId,
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        issuedAt: challenge.issuedAt,
        signature
      };
      await edgeRequest(
        client,
        "/auth/recovery/device-approval/approve",
        { cookie: ownerCookie, body: approval },
        (store) => store.approveRecoveryApproval({ sessionId: owner.session.id, ...approval })
      );

      // The browser still holds another account's session (a guest, say). The approval must
      // still load and be collected, not lost to that cookie.
      const collected = await edgeRequest(
        client,
        "/auth/recovery/device-approval/status",
        { body: poll, cookie: `grogoni_session=${stranger.session.id}` },
        (store) => store.recoveryApprovalStatus(poll)
      );
      if (collected.result.status !== "approved")
        throw new Error(`expected approval, got ${collected.result.status}`);
      expect(collected.result.account.id).toBe(owner.account.id);
      const browserCookie = `grogoni_session=${collected.result.session.id}`;

      // Edge's direct /auth/continue handler runs before the Fastify guard. It must refuse a
      // device-security enrollment from the probation browser, and still let the owner through.
      const edgeAuth = createAuthRoutes({
        transaction: (async <T>(action: (sql: typeof client) => Promise<T>) =>
          action(client)) as unknown as Transaction,
        secrets: {
          pin: "p".repeat(64),
          password: "w".repeat(64),
          audit: "a".repeat(64),
          encryption: "e".repeat(64)
        },
        normalizePhone: (value: string) => ({ e164: value, country: "KE", nationalNumber: value })
      });
      const enroll = (cookie: string) =>
        edgeAuth(
          new Request("https://grogoni.com/api/auth/continue", {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({
              deviceSecurity: true,
              devicePublicKeyJwk: generateKeyPairSync("ec", {
                namedCurve: "prime256v1"
              }).publicKey.export({ format: "jwk" })
            })
          }),
          "/auth/continue"
        );
      await client.query("savepoint edge_enroll");
      const refused = await enroll(browserCookie);
      expect(refused?.status).toBe(403);
      expect(await refused?.json()).toMatchObject({ code: "recovery_approval_probation" });
      const owners = await enroll(ownerCookie);
      expect((await owners?.clone().json())?.code).not.toBe("recovery_approval_probation");
      await client.query("rollback to savepoint edge_enroll");

      // The approved browser uses its one grant to set a password the account never had.
      const reset = await edgeRequest(
        client,
        "/auth/password/recover/device",
        { cookie: browserCookie, body: { password: "attacker password 123" } },
        (store) =>
          store.recoverPasswordWithDevice({
            sessionId: collected.result.status === "approved" ? collected.result.session.id : null,
            password: "attacker password 123"
          })
      );
      expect(reset.result.account.id).toBe(owner.account.id);
      const passwordRows = async () =>
        (
          await client.query("select 1 from password_credentials where account_id = $1", [
            owner.account.id
          ])
        ).rowCount;
      // Edge password login reads this relational table directly.
      expect(await passwordRows()).toBe(1);

      const again = await edgeRequest(
        client,
        "/auth/recovery/device-approval/status",
        { body: poll },
        (store) => store.recoveryApprovalStatus(poll)
      );
      expect(again.result).toEqual({ status: "expired" });

      // The owner undoes. The password the browser set must leave the table Edge logs in with.
      await edgeRequest(
        client,
        "/auth/recovery/device-approval/decline",
        { cookie: ownerCookie, body: { requestId: started.transactionId } },
        (store) =>
          store.declineRecoveryApproval({
            sessionId: owner.session.id,
            requestId: started.transactionId
          })
      );
      expect(await passwordRows()).toBe(0);

      // The stranger's request is still open and was never touched.
      const strangerView = await edgeRequest(
        client,
        "/auth/recovery/device-approval/pending",
        { cookie: `grogoni_session=${stranger.session.id}` },
        (store) => store.pendingRecoveryApprovals({ sessionId: stranger.session.id })
      );
      expect(strangerView.result.requests).toHaveLength(1);
    } finally {
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  }, 30_000);
});
