import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const purgeScriptPath = new URL("../scripts/purge-all-users.sql", import.meta.url);
const postgresStorePath = new URL("../services/api/src/cp2/postgres-store.ts", import.meta.url);

describe("registered-user purge script", () => {
  it("classifies every normalized PostgreSQL collection and preserves only reviewed globals", async () => {
    const [script, postgresStore] = await Promise.all([
      readFile(purgeScriptPath, "utf8"),
      readFile(postgresStorePath, "utf8")
    ]);
    const plan = new Map(
      [...script.matchAll(/\('([^']+)', '(DELETE|PRESERVE)',/g)].map((match) => [
        match[1],
        match[2]
      ])
    );
    const normalizedTables = [...postgresStore.matchAll(/tableName: "([a-z0-9_]+)"/g)].map(
      (match) => match[1]
    );

    // The canonical store slug system (docs/architecture/grogoni-id-slug-system.md) added
    // cp2_grogoni_id_history, and native runtime
    // bindings (docs/architecture/native-runtime-bindings.md) added the six
    // cp2_native_runtime_*/cp2_native_execution_hosts/cp2_native_model_installations collections,
    // to postgres-store.ts's normalizedCollections - each must be classified DELETE here too, or an
    // account purge would silently leave that user's data behind. cp2_model_catalog/
    // cp2_agent_catalog/cp2_platform_operators (infra/db/migrations/071_platform_catalog.sql) are
    // global deployment configuration, not user data, and are therefore explicitly preserved;
    // cp2_platform_operators remains DELETE because its grants belong to purged accounts.
    // cp2_agent_model_assignments/cp2_browser_inference_assignments/cp2_agent_model_bindings were
    // removed from this classification list entirely once infra/db/migrations/
    // 075_drop_dead_runtime_assignment_tables.sql and 076_drop_legacy_agent_model_bindings.sql
    // dropped the tables - there is nothing left to classify. The offline runtime
    // (infra/db/migrations/082_offline_runtime.sql) added cp2_offline_receipts,
    // cp2_offline_changes and cp2_offline_metadata, each classified DELETE: they hold a device's
    // pending mutation receipts and the business change log used to serve /sync/pull, all of it
    // scoped to a purged account or business.
    // The Runtime Handoff Protocol (infra/db/migrations/083_runtime_handoff_protocol.sql,
    // docs/architecture/runtime-handoff-protocol.md) added cp2_runtime_handoffs,
    // cp2_runtime_task_heads, cp2_runtime_task_instances, and cp2_runtime_operation_dedup, each
    // classified DELETE and ordered so cp2_runtime_task_heads/cp2_runtime_task_instances (which
    // reference a handoff) delete before cp2_runtime_handoffs (which they reference), and
    // cp2_runtime_handoffs deletes before the cp2_native_runtime_agents/models/execution_hosts
    // rows it references. The durable execution plane
    // (infra/db/migrations/087_runtime_execution_events.sql, docs/architecture/
    // durable-execution-plane.md) added cp2_runtime_execution_events, classified DELETE: it is a
    // per-task event log scoped to a purged account/business, same as the other runtime-protocol
    // tables above. Structured experience memory
    // (infra/db/migrations/088_runtime_experiences.sql, docs/architecture/experience-memory.md)
    // added cp2_runtime_experiences, classified DELETE: business-scoped recall/lesson records, same
    // family as cp2_agent_owner_corrections above.
    // Phonebook identity resolution (docs/architecture/phonebook-identity-resolution.md) added
    // cp2_identity_candidates, classified DELETE - pending identity candidates are account-scoped
    // and must not survive an account purge.
    // Staff invitations (infra/db/migrations/099_staff_invitations.sql, docs/architecture/
    // staff-invitations.md) added cp2_staff_invitations, classified DELETE - business-scoped
    // invitation records, same family as cp2_network_invites.
    // Network connections (infra/db/migrations/105_network_connections.sql, docs/architecture/
    // phonebook-identity-resolution.md) added cp2_network_connections, classified DELETE - they
    // reference two user accounts and must not survive a purge of either.
    // Discovery budgets (infra/db/migrations/107_discovery_budgets.sql) added
    // cp2_discovery_budgets, classified DELETE - per-user spending records.
    // Agent Skills (infra/db/migrations/125_agent_skills.sql) added cp2_agent_skills,
    // classified DELETE - business/account-owned skill installations and publications.
    expect(plan.size).toBe(206);
    expect([...plan.values()].filter((value) => value === "DELETE")).toHaveLength(199);
    expect(
      [...plan.entries()]
        .filter(([, classification]) => classification === "PRESERVE")
        .map(([tableName]) => tableName)
        .sort()
    ).toEqual(
      [
        "database_backup_runs",
        "database_health_checks",
        "database_restore_drills",
        "cp2_agent_catalog",
        "cp2_model_catalog",
        "identity_providers",
        "grogoni_schema_migrations"
      ].sort()
    );
    expect(normalizedTables.length).toBeGreaterThan(0);
    for (const tableName of normalizedTables) {
      const expectedClassification =
        tableName === "cp2_model_catalog" || tableName === "cp2_agent_catalog"
          ? "PRESERVE"
          : "DELETE";
      expect(plan.get(tableName), `${tableName} must be classified`).toBe(expectedClassification);
    }
  });

  it("defaults to audit-only and retains transactional safety checks", async () => {
    const script = await readFile(purgeScriptPath, "utf8");

    expect(script).toContain("\\set execute_purge 'NO'");
    expect(script).toContain("051_single_identity_single_store.sql");
    expect(script).toContain("purge_unclassified_tables");
    expect(script).toContain("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(script).toContain("ACCESS EXCLUSIVE MODE");
    expect(script).toContain("ROLLBACK;");
    expect(script).toContain("COMMIT;");
    expect(script).toContain("PRE-PURGE ROW COUNTS FOR EVERY AFFECTED TABLE");
    expect(script).toContain("POST-PURGE ROW COUNTS FOR EVERY AFFECTED TABLE");
    expect(script).toContain("REQUIRED ORPHAN/RESIDUAL CHECKS");
    expect(script).toContain("EXTERNAL REFERENCES (reported only");
    expect(script).not.toMatch(/^\s*(DROP|TRUNCATE)\b/m);
    expect(script).not.toMatch(/^\s*ALTER\s+TABLE.*DISABLE\b/m);
    expect(script).not.toContain("session_replication_role");
  });
});
