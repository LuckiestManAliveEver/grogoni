import { describe, expect, it } from "vitest";
import { classifyPrivateRestoreFailure } from "../scripts/private-restore-errors.mjs";
describe("private restore error classification", () => {
  it("reports the known missing extension without including provider output", () => {
    expect(
      classifyPrivateRestoreFailure(
        'pg_restore: error: could not execute query: ERROR:  extension "pg_session_jwt" is not available\nDETAIL: SECRET'
      )
    ).toBe("RESTORE_PG_SESSION_JWT_UNAVAILABLE");
  });
  it("never includes COPY rows, SQL, credentials or arbitrary extension names", () => {
    for (const value of [
      "COPY customers: SECRET customer row",
      'pg_restore: error: could not execute query: ERROR:  extension "SECRET" is not available',
      "postgres://SECRET@host/database"
    ])
      expect(classifyPrivateRestoreFailure(value)).not.toContain("SECRET");
  });
});
