import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  assertBackupRestoreTarget,
  assertNeonBackupSource
} from "../scripts/backup-restore-target.mjs";

describe("isolated backup restore safety", () => {
  it("requires a direct Neon source without query-based routing overrides", () => {
    const source = "postgres://user:pass@ep-example.us-east-1.aws.neon.tech/neondb?sslmode=require";
    expect(assertNeonBackupSource(source)).toBe(source);
    for (const invalid of [
      undefined,
      "not-a-url",
      source.replace("ep-example", "ep-example-pooler"),
      `${source}&host=unrelated.example`
    ])
      expect(() => assertNeonBackupSource(invalid)).toThrow();
  });
  it.each([
    "postgres://user:pass@restore-db:5432/grogoni_backup_restore",
    "postgresql://user:pass@127.0.0.1:5432/grogoni_backup_restore"
  ])("accepts only an explicit disposable target: %s", (url) => {
    expect(assertBackupRestoreTarget(url)).toBe(url);
  });
  it.each([
    undefined,
    "postgres://user:pass@production.neon.tech/grogoni_backup_restore",
    "postgres://user:pass@127.0.0.1/grogoni_market",
    "postgres://user:pass@restore-db/grogoni_backup_restore?host=production.neon.tech",
    "postgres://user:pass@restore-db/grogoni_backup_restore#production",
    "https://restore-db/grogoni_backup_restore"
  ])("refuses ambiguous or production targets", (url) => {
    expect(() => assertBackupRestoreTarget(url)).toThrow();
  });
  it("keeps backups out of pull requests and artifacts and requires explicit schedule activation", async () => {
    const workflow = await readFile(".github/workflows/neon-backup.yml", "utf8");
    expect(workflow).not.toContain("pull_request");
    expect(workflow).not.toContain("upload-artifact");
    expect(workflow).toContain("vars.NEON_BACKUPS_ENABLED == 'true'");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("postgres:18-bookworm");
    expect(workflow).toContain("verify-supabase-backup.mjs");
    expect(workflow).toContain("PGSSLROOTCERT: /etc/ssl/certs/ca-certificates.crt");
    expect(workflow).toContain('test -s "$PGSSLROOTCERT"');
    expect(workflow).not.toContain("sslmode=disable");
    expect(workflow).not.toContain("rejectUnauthorized: false");
    expect(workflow).not.toContain("ALLOW_DB_ROLLBACK");
  });
});
