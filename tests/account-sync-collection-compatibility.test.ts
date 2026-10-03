import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_SYNC_COLLECTIONS,
  isAccountSyncCollection
} from "../packages/shared-types/src/index";
import { createCp2Store } from "../services/api/src/cp2/store";

const migrationPath = resolve(
  process.cwd(),
  "infra/db/migrations/032_account_sync_collection_constraint.sql"
);
const repairMigrationPath = resolve(
  process.cwd(),
  "infra/db/migrations/034_account_sync_constraint_repair.sql"
);

describe("account sync collection compatibility", () => {
  it("defines the complete canonical registry once", () => {
    expect(ACCOUNT_SYNC_COLLECTIONS).toEqual([
      "session_context",
      "shops",
      "conversations",
      "conversation_messages",
      "conversation_participants",
      "conversation_typing"
    ]);
  });

  it("accepts every canonical collection and rejects unsupported values", () => {
    for (const collection of ACCOUNT_SYNC_COLLECTIONS) {
      expect(isAccountSyncCollection(collection)).toBe(true);
    }
    expect(isAccountSyncCollection("conversation-typing")).toBe(false);
    expect(isAccountSyncCollection("account_authentication")).toBe(false);
  });

  it("keeps the forward migration aligned with the canonical registry", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const constraintSql = sql.slice(sql.lastIndexOf("add constraint"));

    for (const collection of ACCOUNT_SYNC_COLLECTIONS) {
      expect(constraintSql).toContain(`'${collection}'`);
    }
  });

  it("reasserts the canonical constraint during the current deployment", async () => {
    const sql = await readFile(repairMigrationPath, "utf8");
    const constraintSql = sql.slice(sql.lastIndexOf("add constraint"));

    for (const collection of ACCOUNT_SYNC_COLLECTIONS) {
      expect(constraintSql).toContain(`'${collection}'`);
    }
    expect(sql).toContain("drop constraint if exists account_sync_changes_collection_check");
    expect(sql).toContain("refusing to repair account_sync_changes_collection_check");
  });

  it("persists authentication state before the non-critical sync journal", async () => {
    const postgresStore = await readFile(
      resolve(process.cwd(), "services/api/src/cp2/postgres-store.ts"),
      "utf8"
    );
    const corePersistence = postgresStore.slice(
      postgresStore.indexOf("async function saveRelationalCoreRecords"),
      postgresStore.indexOf("async function replaceAccountSyncChanges")
    );
    const syncPersistence = postgresStore.slice(
      postgresStore.indexOf("async function replaceAccountSyncChanges"),
      postgresStore.indexOf("async function deleteRemovedAccountRelationalGraph")
    );

    expect(corePersistence).toContain("insert into sessions");
    expect(corePersistence).not.toContain("insert into account_sync_changes");
    expect(syncPersistence).toContain("insert into account_sync_changes");
    expect(postgresStore).toContain("syncJournalError");
    expect(postgresStore).toContain("authenticationBlocked: false");
  });

  it("normalizes known serializer aliases before replacing the constraint", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain("when 'sessionContexts' then 'session_context'");
    expect(sql).toContain("when 'conversationMessages' then 'conversation_messages'");
    expect(sql).toContain("when 'conversationParticipants' then 'conversation_participants'");
    expect(sql).toContain("when 'conversationTyping' then 'conversation_typing'");
    expect(sql.indexOf("update account_sync_changes")).toBeLessThan(
      sql.indexOf("drop constraint if exists")
    );
  });

  it("fails closed on unknown historical values and replaces the named constraint", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain("Unknown account_sync_changes.collection values remain");
    expect(sql).toContain("drop constraint if exists account_sync_changes_collection_check");
    expect(sql).toContain("add constraint account_sync_changes_collection_check");
    expect(sql).not.toContain("check (true)");
  });

  it("records the typing producer with its canonical collection", () => {
    const store = createCp2Store();
    const signup = store.signupWithPhonePin({
      destination: "+254700100001",
      pin: "1234",
      now: new Date("2026-07-18T12:00:00.000Z")
    });
    const context = store.getGrogoniSessionContext({
      sessionId: signup.session.id,
      now: new Date("2026-07-18T12:00:01.000Z")
    });

    store.setConversationTyping({
      sessionId: signup.session.id,
      conversationId: context.conversationId,
      typing: true,
      now: new Date("2026-07-18T12:00:02.000Z")
    });

    expect(store.snapshot().syncChanges.at(-1)?.collection).toBe("conversation_typing");
  });

  it("rejects an unsupported producer value before database persistence", () => {
    const store = createCp2Store();
    const signup = store.signupWithPhonePin({
      destination: "+254700100002",
      pin: "1234"
    });
    const recordSyncChange = (
      store as unknown as {
        recordSyncChange: (input: {
          accountId: string;
          collection: string;
          entityId: string;
          operation: "upsert" | "delete";
          shopId: string | null;
          entity: unknown | null;
          now: Date;
        }) => unknown;
      }
    ).recordSyncChange.bind(store);

    expect(() =>
      recordSyncChange({
        accountId: signup.account.id,
        collection: "conversation-typing",
        entityId: "typing",
        operation: "upsert",
        shopId: null,
        entity: { typing: true },
        now: new Date()
      })
    ).toThrowError(
      expect.objectContaining({
        code: "account_sync_collection_invalid"
      })
    );
  });

  it("keeps successful and failed PIN logins free of duplicate initialization keys", () => {
    const store = createCp2Store();
    const phone = "+254700100003";
    store.signupWithPhonePin({ destination: phone, pin: "1234" });
    const beforeRejectedLogin = store.snapshot().syncChanges.length;
    const initialConversationChanges = store
      .snapshot()
      .syncChanges.filter((change) => change.collection === "conversations").length;

    expect(() =>
      store.loginWithAccountPin({ channel: "phone", destination: phone, pin: "9999" })
    ).toThrowError(expect.objectContaining({ code: "auth_credentials_invalid" }));
    expect(store.snapshot().syncChanges).toHaveLength(beforeRejectedLogin);

    store.loginWithAccountPin({ channel: "phone", destination: phone, pin: "1234" });
    store.loginWithAccountPin({ channel: "phone", destination: phone, pin: "1234" });
    const keys = store
      .snapshot()
      .syncChanges.map((change) => `${change.accountId}:${change.sequence}`);

    expect(new Set(keys).size).toBe(keys.length);
    expect(
      store.snapshot().syncChanges.filter((change) => change.collection === "conversations")
    ).toHaveLength(initialConversationChanges);
  });
});
