// Runs every test file that is gated on CP2_POSTGRES_TEST_DATABASE_URL against a real PostgreSQL
// database, one file at a time. They share one database (and some assert on platform-wide
// tables), so running them in parallel makes them race each other; serial runs are deterministic.
// The file list is discovered, not hard-coded, so a new Postgres test can never be silently left
// out of CI. Usage: CP2_POSTGRES_TEST_DATABASE_URL=postgres://... node scripts/run-postgres-tests.mjs
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

if ((process.env.CP2_POSTGRES_TEST_DATABASE_URL ?? "").trim() === "") {
  console.error("CP2_POSTGRES_TEST_DATABASE_URL is required to run the PostgreSQL test suite.");
  process.exit(1);
}

async function listTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : listTestFiles(path);
      return /\.test\.tsx?$/u.test(entry.name) ? [path] : [];
    })
  );
  return nested.flat();
}

const candidates = [
  ...(await listTestFiles("tests")),
  ...(await listTestFiles("packages")),
  ...(await listTestFiles("services"))
];
const files = [];
for (const file of candidates.sort()) {
  const contents = await readFile(file, "utf8");
  if (
    contents.includes("CP2_POSTGRES_TEST_DATABASE_URL") ||
    contents.includes("INVENTORY_BENCHMARK_TEST_DATABASE_URL")
  )
    files.push(file);
}

if (files.length === 0) {
  console.error("No PostgreSQL-gated test files were found.");
  process.exit(1);
}

console.log(`Running ${files.length} PostgreSQL test files serially:\n${files.join("\n")}`);
const result = spawnSync("pnpm", ["exec", "vitest", "run", "--no-file-parallelism", ...files], {
  stdio: "inherit",
  env: process.env
});
process.exit(result.status ?? 1);
