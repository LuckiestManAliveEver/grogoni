import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createPostgresCp2Store } from "../services/api/src/cp2/postgres-store";

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const requireApiDependency = createRequire(resolve(process.cwd(), "services/api/package.json"));
const { Pool } = requireApiDependency("pg") as {
  Pool: new (options: { connectionString: string }) => {
    query<T extends Record<string, unknown>>(
      text: string,
      values?: unknown[]
    ): Promise<{ rows: T[] }>;
    end(): Promise<void>;
  };
};
const devicePublicKeyJwk = generateKeyPairSync("ec", {
  namedCurve: "prime256v1"
}).publicKey.export({ format: "jwk" });

describePostgres("progressive identity PostgreSQL persistence", () => {
  it("restores a retry-safe device account after a store restart", async () => {
    const connectionString = databaseUrl ?? "";
    const idempotencyKey = `postgres-progressive-${Date.now()}-0000000000000000`;
    const firstStore = await createPostgresCp2Store({ databaseUrl: connectionString });
    const firstApp = buildApi({
      cp2: { store: firstStore },
      mutationPersistenceFlush: () => firstStore.flush()
    });
    const first = await firstApp.inject({
      method: "POST",
      url: "/auth/continue",
      headers: { "idempotency-key": idempotencyKey, "x-grogoni-device-id": "postgres-device" },
      payload: { devicePublicKeyJwk }
    });
    expect(first.statusCode).toBe(200);
    const firstAccountId = first.json<{ account: { id: string } }>().account.id;
    await firstStore.flush();
    await firstApp.close();
    await firstStore.close();

    const restoredStore = await createPostgresCp2Store({ databaseUrl: connectionString });
    const restoredApp = buildApi({
      cp2: { store: restoredStore },
      mutationPersistenceFlush: () => restoredStore.flush()
    });
    const retried = await restoredApp.inject({
      method: "POST",
      url: "/auth/continue",
      headers: { "idempotency-key": idempotencyKey, "x-grogoni-device-id": "postgres-device" },
      payload: { devicePublicKeyJwk }
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json<{ account: { id: string } }>().account.id).toBe(firstAccountId);
    await restoredStore.flush();

    const pool = new Pool({ connectionString });
    const account = await pool.query<{ identity_level: string }>(
      "select identity_level from accounts where id = $1",
      [firstAccountId]
    );
    const bootstrap = await pool.query<{ record: { accountId: string } }>(
      "select record from cp2_device_account_bootstraps where account_id = $1",
      [firstAccountId]
    );
    const credential = await pool.query<{ record: { accountId: string } }>(
      "select record from cp2_device_recovery_credentials where account_id = $1",
      [firstAccountId]
    );
    expect(account.rows).toEqual([{ identity_level: "device" }]);
    expect(bootstrap.rows).toHaveLength(1);
    expect(bootstrap.rows[0]?.record.accountId).toBe(firstAccountId);
    expect(credential.rows).toHaveLength(1);
    expect(credential.rows[0]?.record.accountId).toBe(firstAccountId);

    await pool.end();
    await restoredApp.close();
    await restoredStore.close();
  }, 20_000);

  it("persists a proof-gated device-account merge without losing conversations", async () => {
    const connectionString = databaseUrl ?? "";
    // A phone number unique to this run: the database is shared across runs, and a fixed number
    // would make the merge target accumulate every earlier run's merged conversations.
    const phone = `+2547339${String(Date.now()).slice(-5)}`;
    const store = await createPostgresCp2Store({ databaseUrl: connectionString });
    const app = buildApi({
      cp2: { store },
      mutationPersistenceFlush: () => store.flush()
    });
    const existing = await app.inject({
      method: "POST",
      url: "/auth/pin/continue",
      payload: { method: "phone", contact: phone, pin: "8642" }
    });
    expect(existing.statusCode).toBe(200);
    const targetAccountId = existing.json<{ account: { id: string } }>().account.id;
    const mergeDeviceKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const device = await app.inject({
      method: "POST",
      url: "/auth/continue",
      headers: { "idempotency-key": `postgres-merge-${Date.now()}-0000000000000000` },
      payload: { devicePublicKeyJwk: mergeDeviceKey.publicKey.export({ format: "jwk" }) }
    });
    expect(device.statusCode).toBe(200);
    const sourceAccountId = device.json<{ account: { id: string } }>().account.id;
    const cookie = sessionCookie(device.headers["set-cookie"]);
    const collision = await app.inject({
      method: "PUT",
      url: "/account/phone",
      headers: { cookie },
      payload: { phoneNumber: phone, country: "KE" }
    });
    expect(collision.statusCode).toBe(409);
    const merged = await app.inject({
      method: "POST",
      url: "/auth/identity/merge/pin",
      headers: { cookie },
      payload: { method: "phone", contact: phone, pin: "8642" }
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json<{ account: { id: string } }>().account.id).toBe(targetAccountId);
    await store.flush();
    await app.close();
    await store.close();

    const restored = await createPostgresCp2Store({ databaseUrl: connectionString });
    const snapshot = restored.snapshot();
    expect(snapshot.accounts.some((account) => account.id === sourceAccountId)).toBe(false);
    expect(snapshot.accounts.some((account) => account.id === targetAccountId)).toBe(true);
    expect(
      snapshot.conversations.filter((conversation) => conversation.accountId === targetAccountId)
    ).toHaveLength(2);
    expect(
      snapshot.deviceRecoveryCredentials?.some(
        (credential) => credential.accountId === targetAccountId
      )
    ).toBe(true);
    await restored.close();
  }, 20_000);
});

function sessionCookie(header: string | string[] | undefined): string {
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const session = values.find((value) => value.startsWith("grogoni_session="));
  if (session === undefined) throw new Error("Expected Grogoni session cookie.");
  return session.split(";")[0] ?? session;
}
