import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  createEdgeSnapshotScope,
  prepareEdgeHydration,
  prepareEdgePersistence
} from "../services/api/src/cp2/edge-snapshot-scope";
import {
  saveCollectionRecords,
  saveTransactionalCp2Snapshot
} from "../services/api/src/cp2/postgres-store";
import { createCp2Store } from "../services/api/src/cp2/store";

describe("Edge scoped persistence", () => {
  it("hydrates the maximum loaded watermark without changing the persisted baseline", () => {
    const baseline = createCp2Store().snapshot();
    baseline.offlineMetadata = [
      { id: "server-sequence", sequence: 10 },
      { id: "business:one", sequence: 30 }
    ];
    const hydrated = prepareEdgeHydration(baseline);
    expect(hydrated.offlineMetadata).toEqual([{ id: "server-sequence", sequence: 30 }]);
    expect(baseline.offlineMetadata).toHaveLength(2);
    hydrated.offlineMetadata[0]!.sequence = 40;
    expect(prepareEdgePersistence(hydrated, baseline).offlineMetadata).toEqual(
      baseline.offlineMetadata
    );
  });

  it("advances only the business watermark for new offline changes", () => {
    const baseline = createCp2Store().snapshot();
    baseline.offlineMetadata = [{ id: "server-sequence", sequence: 12 }];
    const hydrated = prepareEdgeHydration(baseline);
    hydrated.offlineMetadata[0]!.sequence = 13;
    hydrated.offlineChanges = [
      { id: "change", businessId: "one", sequence: 13 } as (typeof hydrated.offlineChanges)[number]
    ];
    expect(prepareEdgePersistence(hydrated, baseline).offlineMetadata).toEqual([
      { id: "server-sequence", sequence: 12 },
      { id: "business:one", sequence: 13 }
    ]);
  });

  it("persists reset passwords to the native login credential table as well as the snapshot", async () => {
    const previous = createCp2Store().snapshot();
    const timestamp = new Date().toISOString();
    const credential = {
      accountId: "account",
      passwordHash: "new-password-hash",
      passwordChangedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const snapshot = { ...previous, passwordCredentials: [credential] };
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    await saveTransactionalCp2Snapshot({ query } as unknown as PoolClient, snapshot, previous);
    const native = query.mock.calls.find(([sql]) =>
      sql.includes("insert into password_credentials")
    );
    expect(native?.[1]).toEqual(["account", "new-password-hash", timestamp, timestamp, timestamp]);
    expect(
      query.mock.calls.some(([sql]) => sql.includes("insert into cp2_password_credentials"))
    ).toBe(true);
  });

  it("does not delete rows outside the loaded baseline or rewrite unchanged records", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const keep = { id: "keep", accountId: "owner", value: 1 };
    const removed = { id: "remove", accountId: "owner", value: 1 };
    const added = { id: "new", accountId: "owner", value: 2 };
    await saveCollectionRecords(
      { query } as unknown as PoolClient,
      { key: "e2eeDevices", tableName: "cp2_e2ee_devices" },
      [keep, added],
      [keep, removed]
    );
    expect(query.mock.calls).toHaveLength(2);
    expect(query.mock.calls[0]?.[0]).toContain("entity_id = any");
    expect(query.mock.calls[0]?.[1]).toEqual([["remove"]]);
    expect(query.mock.calls[1]?.[1]).not.toContain("keep");
    expect(query.mock.calls.some(([sql]) => sql.startsWith("select entity_id"))).toBe(false);
  });

  it("fails the transaction when a concurrent writer changed a guarded record", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const before = { id: "record", accountId: "owner", value: 1 };
    const after = { ...before, value: 2 };
    await expect(
      saveCollectionRecords(
        { query } as unknown as PoolClient,
        { key: "e2eeDevices", tableName: "cp2_e2ee_devices" },
        [after],
        [before],
        [before]
      )
    ).rejects.toMatchObject({ code: "40001" });
    expect(query.mock.calls[0]?.[0]).toContain("where cp2_e2ee_devices.record =");
  });

  it("does not run broad relational deletion queries for a scoped account removal", async () => {
    const store = createCp2Store();
    store.continueWithChannelPin({ channel: "phone", destination: "+442079460123", pin: "1234" });
    const previous = store.snapshot();
    const after = createCp2Store().snapshot();
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    await saveTransactionalCp2Snapshot({ query } as unknown as PoolClient, after, previous);
    for (const [sql] of query.mock.calls) {
      expect(sql).not.toMatch(/where not \(id = any/);
      expect(sql).not.toMatch(/select id from (accounts|users|businesses) where not/);
    }
  });

  it("keeps anonymous snapshots scoped while preserving requested storefronts and ceremonies", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const scope = await createEdgeSnapshotScope(
      { query } as unknown as PoolClient,
      new Request("https://grogoni.com/public/storefronts/grogoni.test"),
      "/public/storefronts/grogoni.test"
    );
    expect(scope.accountId).toBeUndefined();
    expect(scope.withClause).toContain("grogoni_id = 'grogoni.test'");
    expect(scope.withClause).toContain("public.oauth_sessions where account_id");
    expect(scope.predicate("passwordCredentials")).not.toBe("true");
    expect(scope.predicate("conversationMessages")).toContain("record->>'conversationId'");
    expect(scope.predicate("modelCatalog")).toBe("true");
  });

  it("scopes sessionless device recovery to the credential owner", async () => {
    const credentialId = "00000000-0000-4000-8000-000000000001";
    const query = vi.fn(async () => ({ rows: [] }));
    await createEdgeSnapshotScope(
      { query } as unknown as PoolClient,
      new Request("https://grogoni.com/auth/device/recover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentialId })
      }),
      "/auth/device/recover",
      Buffer.from(JSON.stringify({ credentialId }))
    );
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("cp2_device_recovery_credentials");
    expect(sql).toContain("d.record->>'revokedAt' is null");
    expect(values[6]).toBe(credentialId);
  });

  it("escapes user-supplied lookup values and uses invitation destinations", async () => {
    const query = vi.fn(async () => ({
      rows: [{ account_id: "account", user_id: "user", primary_auth_destination: "+442079460123" }]
    }));
    const scope = await createEdgeSnapshotScope(
      { query } as unknown as PoolClient,
      new Request("https://grogoni.com/businesses/x"),
      "/businesses/x' OR true --"
    );
    expect(scope.withClause).not.toContain("OR true --");
    expect(scope.withClause).toContain("record->>'destination'");
  });
  it("loads only the requested transaction's email proof for hosted MFA", async () => {
    const transactionId = "00000000-0000-4000-8000-000000000001";
    const query = vi.fn(async () => ({
      rows: [
        {
          account_id: transactionId,
          user_id: transactionId,
          primary_auth_destination: "+254711111111"
        }
      ]
    }));
    const payload = Buffer.from(JSON.stringify({ transactionId, factor: "email", code: "123456" }));
    const scope = await createEdgeSnapshotScope(
      { query } as unknown as PoolClient,
      new Request("https://grogoni.com/auth/mfa/verify", {
        method: "POST",
        headers: { "content-type": "application/json" }
      }),
      "/auth/mfa/verify",
      payload
    );
    expect(scope.withClause).toContain(
      "select record->>'providerChallengeId' from public.cp2_auth_transactions"
    );
    expect(scope.withClause).toContain(
      "record->>'consumedAt' is null and (record->>'expiresAt')::timestamptz > now()"
    );
    expect(scope.predicate("otpChallenges")).toBe(
      "entity_id in (select id::text from otp_challenges)"
    );
  });
});
