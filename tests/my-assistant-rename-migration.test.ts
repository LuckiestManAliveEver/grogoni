import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Pool as PgPool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const migration = readFileSync("infra/db/migrations/132_my_assistant_rename.sql", "utf8");
const rollback = readFileSync("infra/db/rollbacks/132_my_assistant_rename.down.sql", "utf8");
const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

describe("132 My Assistant rename migration", () => {
  it("renames only rows still carrying the old default name, and rolls back symmetrically", () => {
    for (const sql of [migration, rollback]) {
      expect(sql).toContain("record ->> 'isPermanentDaemon' = 'true'");
      expect(sql).toContain("entity_id like 'account-%-agent'");
      expect(sql).not.toMatch(/\b(delete|truncate)\b/i);
    }
    // Nothing is dropped going forward; the rollback drops only the function 132 created.
    expect(migration).not.toMatch(/\bdrop\b/i);
    expect(rollback.match(/\bdrop\b[^;]*;/giu)).toEqual([
      "drop function if exists grogoni_conversation_task_runtime(uuid, text);"
    ]);
    expect(migration).toContain("security definer");
    // Pinned path with pg_temp last; never the caller's path ("set search_path from current").
    expect(migration).toContain("set search_path = %I, pg_temp");
    expect(migration).not.toContain("search_path from current");
    for (const role of ["anon", "authenticated"])
      expect(migration).toContain(
        `revoke all on function grogoni_conversation_task_runtime(uuid, text) from ${role}`
      );
    expect(migration).toContain(
      "revoke all on function grogoni_conversation_task_runtime(uuid, text) from public;"
    );
    expect(migration).toContain("record ->> 'title' = 'Your daemon'");
    expect(rollback).toContain("record ->> 'title' = 'My Assistant'");
  });

  // Runs on the real migrated schema (CP2_POSTGRES_TEST_DATABASE_URL, as the other Postgres
  // suites), with its foreign keys, generated columns and check constraints, inside a transaction
  // that is rolled back: nothing is left behind.
  describe.skipIf(!url)("against the migrated schema", () => {
    const pool = new Pool({ connectionString: url ?? "", max: 1 });
    afterAll(async () => {
      await pool.end();
    });

    it("renames, detaches only where safe, keeps owner titles, and reverses", async () => {
      const client = await pool.connect();
      const tag = randomUUID().slice(0, 8);
      const id = (name: string) => `${name}-${tag}`;
      const owner = randomUUID();
      const unflagged = randomUUID();
      try {
        await client.query("begin");
        const agent = `account-${tag}-agent`;
        await client.query(
          "insert into cp2_native_runtime_agents (entity_id, account_id, record) values ($1, $2, $3)",
          [
            agent,
            owner,
            {
              id: agent,
              name: "Your daemon",
              status: "active",
              runtimeContractVersion: "1",
              // Switched to Pi in My Assistant's details after 132.
              provider: "pi",
              packageRef: "npm:@earendil-works/pi-agent-core@0.84.4",
              configuration: { runtimeAdapterId: "pi", requiredModelCapabilities: ["chat"] }
            }
          ]
        );
        await client.query(
          "insert into cp2_native_runtime_agents (entity_id, record) values ($1, $2)",
          [
            `shop-${tag}-agent-renamed`,
            { name: "Shop helper", status: "active", runtimeContractVersion: "1" }
          ]
        );
        for (const [binding, source] of [
          [id("selection-a"), "conversation-selection"],
          [id("selection-b"), "conversation-selection"],
          [id("selection-c"), "conversation-selection"],
          [id("shop-binding"), "activation"]
        ])
          await client.query(
            "insert into cp2_native_runtime_bindings (entity_id, account_id, parent_id, record) values ($1, $2, $3, $4)",
            [
              binding,
              owner,
              agent,
              { agentId: agent, status: "active", isDefault: false, configuration: { source } }
            ]
          );
        const conversation = (
          key: string,
          account: string,
          record: Record<string, unknown>
        ): [string, string, Record<string, unknown>] => [
          id(key),
          account,
          { id: id(key), accountId: account, kind: "personal", ...record }
        ];
        const rows = [
          conversation("assistant", owner, {
            isPermanentDaemon: true,
            title: "Your daemon",
            runtimeBindingId: id("selection-a")
          }),
          conversation("assistant-renamed", owner, { isPermanentDaemon: true, title: "Mine" }),
          conversation("legacy-session", owner, {
            title: "Restock maize",
            runtimeBindingId: id("selection-b")
          }),
          conversation("shop-chat", owner, {
            title: "Your daemon",
            runtimeBindingId: id("shop-binding")
          }),
          // No flagged assistant on this account yet: it may still promote this chat.
          conversation("unpromoted", unflagged, {
            title: "Grogoni agent",
            runtimeBindingId: id("selection-c")
          })
        ];
        for (const [entity, account, record] of rows)
          await client.query(
            "insert into cp2_conversations (entity_id, account_id, record) values ($1, $2, $3)",
            [entity, account, record]
          );
        const state = async () =>
          Object.fromEntries(
            (
              await client.query<{
                entity_id: string;
                title: string;
                binding: string | null;
                detached: string | null;
              }>(
                `select entity_id, record ->> 'title' as title, runtime_binding_id as binding,
                   record ->> 'detachedRuntimeBindingId' as detached
                 from cp2_conversations where entity_id like $1`,
                [`%-${tag}`]
              )
            ).rows.map((row) => [
              row.entity_id.slice(0, -tag.length - 1),
              [
                row.title,
                row.binding?.slice(0, -tag.length - 1) ?? null,
                row.detached ? "kept" : null
              ]
            ])
          );
        const agentName = async () =>
          (
            await client.query<{ name: string }>(
              "select record ->> 'name' as name from cp2_native_runtime_agents where entity_id = $1",
              [agent]
            )
          ).rows[0]!.name;

        await client.query(migration);
        expect(await state()).toEqual({
          assistant: ["My Assistant", "selection-a", null],
          "assistant-renamed": ["Mine", null, null],
          "legacy-session": ["Restock maize", null, "kept"],
          "shop-chat": ["Your daemon", "shop-binding", null],
          unpromoted: ["Grogoni agent", "selection-c", null]
        });
        expect(await agentName()).toBe("My Assistant");
        expect(
          (
            await client.query<{ engine: string }>(
              "select record -> 'configuration' ->> 'runtimeAdapterId' as engine from cp2_native_runtime_agents where entity_id = $1",
              [agent]
            )
          ).rows[0]!.engine
        ).toBe("pi");

        await client.query(migration); // idempotent
        await client.query(rollback);
        expect(await state()).toEqual({
          assistant: ["Your daemon", "selection-a", null],
          "assistant-renamed": ["Mine", null, null],
          "legacy-session": ["Restock maize", "selection-b", null],
          "shop-chat": ["Your daemon", "shop-binding", null],
          unpromoted: ["Grogoni agent", "selection-c", null]
        });
        expect(await agentName()).toBe("Your daemon");
        // Old code has no agent switch: the rollback puts the engine back on Grogoni.
        expect(
          (
            await client.query<{ record: Record<string, unknown> }>(
              "select record from cp2_native_runtime_agents where entity_id = $1",
              [agent]
            )
          ).rows[0]!.record
        ).toMatchObject({
          provider: "grogoni-business-agent",
          packageRef: null,
          configuration: { runtimeAdapterId: "grogoni", requiredModelCapabilities: ["chat"] }
        });
      } finally {
        await client.query("rollback");
        client.release();
      }
    });
  });
});
