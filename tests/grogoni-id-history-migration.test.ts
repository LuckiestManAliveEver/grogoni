import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("grogoni id history migration", () => {
  it("adds one purely additive table, following the existing normalized-store convention", async () => {
    const sql = await readFile("infra/db/migrations/062_grogoni_id_history.sql", "utf8");

    expect(sql).toContain("create table if not exists cp2_grogoni_id_history");

    // Additive, not destructive: no existing table is altered or dropped.
    expect(sql).not.toContain("alter table");
    expect(sql).not.toContain("drop table");
    expect(sql).not.toContain("drop column");

    // A retired grogoniId belongs to the business that used to hold it.
    expect(sql).toContain("references cp2_businesses(entity_id) on delete cascade");

    // A given grogoniId can only ever be recorded in history once.
    expect(sql).toContain("cp2_grogoni_id_history_grogoni_id_idx");
  });

  it("provides a scoped rollback for only the new table", async () => {
    const sql = await readFile("infra/db/rollbacks/062_grogoni_id_history.down.sql", "utf8");

    expect(sql).toContain("drop table if exists cp2_grogoni_id_history");
    expect(sql).not.toContain("cp2_businesses");
    expect(sql).not.toContain("alter table");
  });

  it("is registered in postgres-store.ts's generic normalizedCollections mechanism, with no bespoke SQL for it", async () => {
    const postgresStore = await readFile("services/api/src/cp2/postgres-store.ts", "utf8");
    expect(postgresStore).toContain(
      '{ key: "grogoniIdHistory", tableName: "cp2_grogoni_id_history" }'
    );
    expect(postgresStore).not.toContain("select * from cp2_grogoni_id_history");
  });
});
