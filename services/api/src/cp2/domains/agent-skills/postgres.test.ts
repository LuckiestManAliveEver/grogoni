import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { saveCollectionRecords } from "../../postgres-store.js";
import { AgentSkillsDomain } from "./store.js";

const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
describe.skipIf(!url)("portable skill PostgreSQL persistence", () => {
  it("migrates, round-trips scoped records through existing persistence and rolls back", async () => {
    const pool = new Pool({ connectionString: url });
    const client = await pool.connect();
    const schema = `skills_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query(`create schema ${schema}`);
      await client.query(`set search_path to ${schema}`);
      const migration = await readFile(
        new URL("../../../../../../infra/db/migrations/125_agent_skills.sql", import.meta.url),
        "utf8"
      );
      await client.query(migration);
      const domain = new AgentSkillsDomain({
        authorize: (input) => ({
          userId: input.sessionId!,
          accountId: `account-${input.sessionId}`,
          role: "owner",
          operator: false
        }),
        audit: () => {},
        generate: async () => ({}),
        agentAllowed: () => true
      });
      const input = { sessionId: "owner-a", businessId: "business-a" };
      const draft = domain.draft(input, {
        files: {
          "SKILL.md": "---\nname: stock-check\ndescription: Check stock.\n---\nRead inventory."
        }
      });
      domain.transition(input, draft.id, "install", draft.reviewDigest);
      domain.transition(input, draft.id, "enable");
      const records = [...domain.records.values()] as unknown as Record<string, unknown>[];
      await client.query("begin");
      await saveCollectionRecords(
        client,
        { key: "agentSkills", tableName: "cp2_agent_skills" },
        records,
        []
      );
      await client.query("commit");
      const saved = await client.query(
        "select record,business_id,account_id from cp2_agent_skills where entity_id=$1",
        [draft.id]
      );
      expect(saved.rows[0].record.status).toBe("ENABLED");
      expect(saved.rows[0].business_id).toBe("business-a");
      expect(saved.rows[0].account_id).toBeNull();
      const restored = new AgentSkillsDomain({
        authorize: (value) => ({
          userId: value.sessionId!,
          accountId: `account-${value.sessionId}`,
          role: "owner",
          operator: false
        }),
        audit: () => {},
        generate: async () => ({}),
        agentAllowed: () => true
      });
      restored.records.set(draft.id, saved.rows[0].record);
      expect(restored.catalog(input)).toHaveLength(1);
      expect(restored.catalog({ sessionId: "owner-b", businessId: "business-b" })).toEqual([]);
      expect(() =>
        restored.inspect({ sessionId: "owner-b", businessId: "business-b" }, draft.id)
      ).toThrow();
      await expect(
        client.query("insert into cp2_agent_skills(entity_id,record) values('broken','{}')")
      ).rejects.toThrow();
      await client.query(
        await readFile(
          new URL(
            "../../../../../../infra/db/rollbacks/125_agent_skills.down.sql",
            import.meta.url
          ),
          "utf8"
        )
      );
      expect(
        (await client.query("select to_regclass('cp2_agent_skills') as name")).rows[0].name
      ).toBeNull();
    } finally {
      await client.query("rollback");
      await client.query(`drop schema if exists ${schema} cascade`);
      client.release();
      await pool.end();
    }
  }, 30000);
});
