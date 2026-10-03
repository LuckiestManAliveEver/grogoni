import { describe, expect, it } from "vitest";
import {
  databasePoolConfig,
  isAcceptedMigrationChecksum,
  legacyMigrationChecksums,
  normalizeDatabaseUrl,
  readDatabaseUrl
} from "../services/api/scripts/database-connection.mjs";

const migration014 = "014_cp2_phase1_auth_security_relational.sql";
const migration051 = "051_single_identity_single_store.sql";
const knownLegacy014Checksums = [
  "bd441b79fc96f268acba7a251cb12d688a61b98b5d608809924ede780d84282a",
  "695019b487acf03ba6dfe87c64c5dd4204bbb52bfb9d551d8623cff2519560a6"
];
const knownLegacy051Checksum = "5d42eb07544456684e82cec84ca085388f73909f8c1eab2353f1128a4f02d2a9";

describe("database connection policy", () => {
  it("falls back from a blank direct URL to the pooled URL", () => {
    expect(
      readDatabaseUrl({
        DIRECT_DATABASE_URL: "  ",
        DATABASE_URL: " postgres://pooled.example/grogoni?sslmode=require "
      })
    ).toBe("postgres://pooled.example/grogoni?sslmode=verify-full");
  });

  it("prefers a configured direct URL and normalizes transport security", () => {
    expect(
      readDatabaseUrl({
        DIRECT_DATABASE_URL: "postgres://direct.example/grogoni?sslmode=verify-ca",
        DATABASE_URL: "postgres://pooled.example/grogoni"
      })
    ).toBe("postgres://direct.example/grogoni?sslmode=verify-full");
    expect(normalizeDatabaseUrl(" postgres://db.example/grogoni?sslmode=prefer ")).toBe(
      "postgres://db.example/grogoni?sslmode=verify-full"
    );
  });

  it("applies bounded pool settings and identifies connections", () => {
    expect(
      databasePoolConfig("postgres://project.neon.tech/grogoni", {
        applicationName: "schema-audit",
        environment: {
          DB_CONNECTION_TIMEOUT_MS: "7000",
          DB_IDLE_TIMEOUT_MS: "9000",
          DB_POOL_MAX: "3",
          DB_QUERY_TIMEOUT_MS: "11000",
          DB_STATEMENT_TIMEOUT_MS: "13000"
        }
      })
    ).toMatchObject({
      application_name: "schema-audit",
      connectionTimeoutMillis: 7000,
      idleTimeoutMillis: 9000,
      max: 3,
      query_timeout: 11000,
      statement_timeout: 13000,
      ssl: true
    });
  });

  it("keeps the approved historical migration checksum policy shared", () => {
    expect(
      isAcceptedMigrationChecksum(
        "014_cp2_phase1_auth_security_relational.sql",
        "695019b487acf03ba6dfe87c64c5dd4204bbb52bfb9d551d8623cff2519560a6",
        "current"
      )
    ).toBe(true);
    expect(isAcceptedMigrationChecksum("001_example.sql", "changed", "current")).toBe(false);
  });

  describe("migration checksum compatibility", () => {
    it("accepts a matching current checksum for any migration, legacy-tracked or not", () => {
      expect(isAcceptedMigrationChecksum("000_initial.sql", "abc123", "abc123")).toBe(true);
      expect(isAcceptedMigrationChecksum(migration014, "abc123", "abc123")).toBe(true);
      expect(isAcceptedMigrationChecksum(migration051, "abc123", "abc123")).toBe(true);
    });

    it("accepts every known legacy checksum recorded for migration 014", () => {
      for (const legacyChecksum of knownLegacy014Checksums) {
        expect(isAcceptedMigrationChecksum(migration014, legacyChecksum, "current-file-hash")).toBe(
          true
        );
      }
    });

    it("rejects a checksum for migration 014 that was never recorded as legacy", () => {
      expect(
        isAcceptedMigrationChecksum(migration014, "not-a-recorded-checksum", "current-file-hash")
      ).toBe(false);
    });

    it("accepts the one production checksum verified and recorded for migration 051", () => {
      // Verified against the production database and recorded on 2026-08-15 (see the comment
      // above legacyMigrationChecksums in database-connection.mjs). Any other applied checksum
      // for 051 must still be rejected - this is an allowlist of exactly one verified value, not
      // a way to silence checksum drift in general.
      expect(legacyMigrationChecksums.get(migration051)).toEqual(new Set([knownLegacy051Checksum]));
      expect(
        isAcceptedMigrationChecksum(migration051, knownLegacy051Checksum, "current-file-hash")
      ).toBe(true);
      expect(
        isAcceptedMigrationChecksum(migration051, "some-unverified-checksum", "current-file-hash")
      ).toBe(false);
    });

    it("accepts a verified legacy checksum for 051 once one is recorded, and still rejects others", () => {
      // Exercises the exact mechanism that unblocks Render once an operator runs the read-only
      // query documented in database-connection.mjs and records the real checksum. Uses a
      // synthetic map (via the optional 4th argument) rather than a fabricated production value,
      // so this test proves the machinery works without ever hardcoding an unverified checksum
      // into application code.
      const verifiedHistoricalChecksum = "verified-historical-checksum-for-051";
      const simulatedLegacyMap = new Map([[migration051, new Set([verifiedHistoricalChecksum])]]);

      expect(
        isAcceptedMigrationChecksum(
          migration051,
          verifiedHistoricalChecksum,
          "current-file-hash",
          simulatedLegacyMap
        )
      ).toBe(true);
      expect(
        isAcceptedMigrationChecksum(
          migration051,
          "some-other-unverified-checksum",
          "current-file-hash",
          simulatedLegacyMap
        )
      ).toBe(false);
    });

    it("rejects an unknown checksum for a migration with no legacy entry at all", () => {
      expect(
        isAcceptedMigrationChecksum("999_hypothetical_future.sql", "old-checksum", "new-checksum")
      ).toBe(false);
    });

    it("cannot be satisfied by silently modifying an already-applied migration file", () => {
      // Regression guard for the underlying incident: a migration's file changing after it was
      // applied must never pass validation on its own. It only passes if the file is restored to
      // what actually ran (appliedChecksum === currentChecksum), or the exact applied checksum is
      // explicitly recorded as legacy. There is no other path.
      const appliedChecksum = "checksum-recorded-when-the-migration-first-ran";
      const modifiedFileChecksum = "checksum-after-someone-edited-the-applied-migration";

      expect(
        isAcceptedMigrationChecksum("020_example.sql", appliedChecksum, modifiedFileChecksum)
      ).toBe(false);
      expect(
        isAcceptedMigrationChecksum(
          "020_example.sql",
          appliedChecksum,
          modifiedFileChecksum,
          new Map()
        )
      ).toBe(false);
    });
  });
});
