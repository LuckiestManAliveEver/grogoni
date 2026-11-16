// Reproduce the competing-device-claim regression using the maintained PostgreSQL test.
// CP2_POSTGRES_TEST_DATABASE_URL=postgres://.../grogoni_test node services/api/repro-device.mjs
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("CP2_POSTGRES_TEST_DATABASE_URL is required.");
const target = new URL(databaseUrl);
if (
  !["postgres:", "postgresql:"].includes(target.protocol) ||
  !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
  !/(?:test|repro)/u.test(target.pathname)
)
  throw new Error("Use a migrated local test or reproduction database.");

const root = fileURLToPath(new URL("../../", import.meta.url));
const result = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "services/api/src/messaging/whatsapp-linked/device-outbox.postgres.test.ts",
    "-t",
    "refuses a stale host claiming the same send"
  ],
  { cwd: root, stdio: "inherit", env: process.env }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
