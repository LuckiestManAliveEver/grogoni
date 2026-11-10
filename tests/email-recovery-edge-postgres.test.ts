import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { Pool as PgPool } from "pg";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  createEdgeSnapshotScope,
  prepareEdgeHydration
} from "../services/api/src/cp2/edge-snapshot-scope";
import {
  loadTransactionalCp2Snapshot,
  saveTransactionalCp2Snapshot
} from "../services/api/src/cp2/postgres-store";

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const { Pool } = createRequire(new URL("../services/api/package.json", import.meta.url))("pg") as {
  Pool: typeof PgPool;
};

describe.skipIf(!databaseUrl)("email recovery across Edge requests", () => {
  it("finds a verified shared identity without a verified legacy row and excludes pending identities", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const store = createCp2Store();
      const baseline = store.snapshot();
      const phone = () => `+2547${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
      const owner = store.signupWithPhonePin({ destination: phone(), pin: "7392" });
      const stranger = store.signupWithPhonePin({ destination: phone(), pin: "8246" });
      const email = `verified-${randomUUID()}@example.invalid`;
      const pendingEmail = `pending-${randomUUID()}@example.invalid`;
      store.beginEmailIdentityUpgrade({ sessionId: owner.session.id, email });
      const otp = store.requestOtp({ channel: "email", destination: email, purpose: "signup" });
      store.verifyPendingEmail({
        sessionId: owner.session.id,
        challengeId: otp.challengeId,
        code: otp.devOtp
      });
      store.beginEmailIdentityUpgrade({ sessionId: stranger.session.id, email: pendingEmail });
      await saveTransactionalCp2Snapshot(client, store.snapshot(), baseline);
      // Native signup can leave a pending legacy identity while the shared route verifies its own row.
      const identity = store
        .snapshot()
        .accountIdentities!.find((i) => i.normalizedValue === email)!;
      await client.query(
        `insert into account_identities
        (id, account_id, user_id, type, normalized_value, display_value, is_primary, verified_at, created_at, updated_at)
        values ($1,$2,$3,'email',$4,$4,false,null,now(),now())
        on conflict (id) do update set verified_at=null`,
        [identity.id, owner.account.id, owner.user.id, email]
      );
      for (const [identifier, expectedAccount] of [
        [email, owner.account.id],
        [pendingEmail, null],
        [`unknown-${randomUUID()}@example.invalid`, null]
      ] as const) {
        for (const cookie of [undefined, `grogoni_session=${stranger.session.id}`]) {
          const body = Buffer.from(JSON.stringify({ type: "email", identifier }));
          const scope = await createEdgeSnapshotScope(
            client,
            new Request("https://grogoni.com/api/auth/recovery/start", {
              method: "POST",
              headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
              body
            }),
            "/auth/recovery/start",
            body
          );
          const loaded = await loadTransactionalCp2Snapshot(client, scope);
          expect(loaded.accounts.map((a) => a.id)).toEqual(
            expectedAccount ? [expectedAccount] : []
          );
          const restored = createCp2Store();
          restored.hydrateSnapshot(loaded);
          const result = restored.beginRecovery({ channel: "email", identifier });
          expect(result.accountFound).toBe(expectedAccount !== null);
        }
      }
      const beforeRecovery = store.snapshot();
      const recoveryOtp = store.requestOtp({
        channel: "email",
        destination: email,
        purpose: "recovery"
      });
      const recovery = store.beginRecovery({
        channel: "email",
        identifier: email,
        providerChallengeId: recoveryOtp.challengeId,
        expiresAt: recoveryOtp.expiresAt
      });
      await saveTransactionalCp2Snapshot(client, store.snapshot(), beforeRecovery);
      for (const path of ["/auth/recovery/verify", "/auth/recovery/reset-pin"]) {
        const body = Buffer.from(JSON.stringify({ transactionId: recovery.transactionId }));
        const scope = await createEdgeSnapshotScope(
          client,
          new Request(`https://grogoni.com/api${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: `grogoni_session=${stranger.session.id}`
            },
            body
          }),
          path,
          body
        );
        const loaded = await loadTransactionalCp2Snapshot(client, scope);
        expect(loaded.accounts.map((a) => a.id)).toEqual([owner.account.id]);
        const requestStore = createCp2Store();
        requestStore.hydrateSnapshot(prepareEdgeHydration(loaded));
        const previous = loaded;
        if (path.endsWith("verify")) {
          requestStore.verifyEmailRecovery({
            transactionId: recovery.transactionId,
            challengeId: recoveryOtp.challengeId,
            code: recoveryOtp.devOtp
          });
        } else {
          const reset = requestStore.resetRecoveredPin({
            transactionId: recovery.transactionId,
            pin: "6379"
          });
          expect(reset.account.id).toBe(owner.account.id);
        }
        await saveTransactionalCp2Snapshot(client, requestStore.snapshot(), previous);
      }
      const finalStore = createCp2Store();
      finalStore.hydrateSnapshot(await loadTransactionalCp2Snapshot(client));
      expect(() =>
        finalStore.loginWithAccountPin({
          channel: "phone",
          destination: owner.account.primaryAuthDestination,
          pin: "7392"
        })
      ).toThrow();
      expect(
        finalStore.loginWithAccountPin({
          channel: "phone",
          destination: owner.account.primaryAuthDestination,
          pin: "6379"
        }).account.id
      ).toBe(owner.account.id);
      expect(
        finalStore.loginWithAccountPin({
          channel: "phone",
          destination: stranger.account.primaryAuthDestination,
          pin: "8246"
        }).account.id
      ).toBe(stranger.account.id);
    } finally {
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  }, 60_000);
});
