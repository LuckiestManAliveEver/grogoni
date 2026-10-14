import { Pool } from "pg";
import { assertInventoryBenchmarkDatabase } from "./inventory-fixtures.js";

const connectionString = process.env.INVENTORY_BENCHMARK_TEST_DATABASE_URL ?? "";
assertInventoryBenchmarkDatabase(connectionString);
const url = new URL(connectionString);
const name = url.pathname.slice(1);
url.pathname = "/postgres";
const admin = new Pool({ connectionString: url.toString(), max: 1 });
try {
  const existing = await admin.query("select 1 from pg_database where datname=$1", [name]);
  if (!existing.rowCount) await admin.query(`create database "${name}"`);
} finally {
  await admin.end();
}
