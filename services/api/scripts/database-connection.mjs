import { URL } from "node:url";

function positiveIntegerFromEnv(name, fallback, environment = process.env) {
  const value = environment[name];

  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

// Filenames whose SQL text no longer byte-for-byte matches what a live database recorded in
// `grogoni_schema_migrations` when the migration actually ran, together with every checksum
// verified to have been legitimately applied for that file. This is an explicit, audited
// allowlist keyed by exact checksum - not a way to silence checksum drift in general. A
// migration runner still fails closed for any applied checksum that is not exactly one of the
// values listed here (see isAcceptedMigrationChecksum below).
const legacyMigrationChecksums = new Map([
  [
    "014_cp2_phase1_auth_security_relational.sql",
    new Set([
      "bd441b79fc96f268acba7a251cb12d688a61b98b5d608809924ede780d84282a",
      "695019b487acf03ba6dfe87c64c5dd4204bbb52bfb9d551d8623cff2519560a6"
    ])
  ],
  // 051_single_identity_single_store.sql: production's grogoni_schema_migrations row for this
  // file was stamped with a checksum that does not match the current file's SHA-256. Verified
  // against the production database and added on 2026-08-15.
  [
    "051_single_identity_single_store.sql",
    new Set(["5d42eb07544456684e82cec84ca085388f73909f8c1eab2353f1128a4f02d2a9"])
  ]
]);

export function isAcceptedMigrationChecksum(
  filename,
  appliedChecksum,
  currentChecksum,
  legacyChecksums = legacyMigrationChecksums
) {
  return (
    appliedChecksum === currentChecksum ||
    legacyChecksums.get(filename)?.has(appliedChecksum) === true
  );
}

export { legacyMigrationChecksums };

export function normalizeDatabaseUrl(connectionString) {
  return connectionString
    .trim()
    .replace(/([?&])sslmode=(?:prefer|require|verify-ca)(?=&|$)/gi, "$1sslmode=verify-full");
}

export function readDatabaseUrl(environment = process.env) {
  for (const name of ["DIRECT_DATABASE_URL", "DATABASE_URL"]) {
    const value = environment[name];
    if (value !== undefined && value.trim() !== "") {
      return normalizeDatabaseUrl(value);
    }
  }

  return null;
}

/** `user@host:port/database` with no password, for logs and errors. */
export function describeDatabaseTarget(connectionString) {
  try {
    const url = new URL(connectionString);
    const user = url.username ? `${decodeURIComponent(url.username)}@` : "";
    return `${user}${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`;
  } catch {
    return "an unparseable database URL";
  }
}

/** The database a URL names. A Neon pooler host and its direct host are the same database. */
function databaseIdentity(connectionString) {
  try {
    const url = new URL(connectionString);
    const [first, ...rest] = url.hostname.toLowerCase().split(".");
    const host = [first.replace(/-pooler$/u, ""), ...rest].join(".");
    return `${decodeURIComponent(url.username)}@${host}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return connectionString.trim();
  }
}

/**
 * The database a migration or rollback changes. Stricter than readDatabaseUrl, because the
 * scripts load .env: a DIRECT_DATABASE_URL from .env silently beat a DATABASE_URL given on the
 * command line, and migrations ran against a remote database instead of a local one.
 *
 * MIGRATION_DATABASE_URL names the target outright. Otherwise, when DIRECT_DATABASE_URL and
 * DATABASE_URL are both set they must name the same database, or nothing runs.
 */
export function readSchemaChangeDatabaseUrl(environment = process.env) {
  const value = (name) => environment[name]?.trim() ?? "";
  const explicit = value("MIGRATION_DATABASE_URL");
  if (explicit !== "") return normalizeDatabaseUrl(explicit);
  const direct = value("DIRECT_DATABASE_URL");
  const pooled = value("DATABASE_URL");
  if (environment.NODE_ENV === "production") {
    if (direct === "")
      throw new Error("DIRECT_DATABASE_URL is required for production migrations.");
    return normalizeDatabaseUrl(direct);
  }
  if (direct !== "" && pooled !== "" && databaseIdentity(direct) !== databaseIdentity(pooled)) {
    throw new Error(
      `DIRECT_DATABASE_URL (${describeDatabaseTarget(direct)}) and DATABASE_URL ` +
        `(${describeDatabaseTarget(pooled)}) name different databases. One of them may come ` +
        "from .env. Set MIGRATION_DATABASE_URL to the database you mean."
    );
  }
  const chosen = direct !== "" ? direct : pooled;
  return chosen === "" ? null : normalizeDatabaseUrl(chosen);
}

export function databasePoolConfig(
  connectionString,
  {
    applicationName = "grogoni-db-task",
    environment = process.env,
    max,
    poolMaxFallback = 1,
    useQueryTimeouts = true
  } = {}
) {
  const normalizedConnectionString = normalizeDatabaseUrl(connectionString);
  const sslRequired =
    !/[?&]sslmode=/i.test(normalizedConnectionString) &&
    (normalizedConnectionString.includes(".neon.tech") ||
      normalizedConnectionString.includes(".neon.database"));

  return {
    application_name: applicationName,
    connectionString: normalizedConnectionString,
    connectionTimeoutMillis: positiveIntegerFromEnv("DB_CONNECTION_TIMEOUT_MS", 5000, environment),
    idleTimeoutMillis: positiveIntegerFromEnv("DB_IDLE_TIMEOUT_MS", 30000, environment),
    max: max ?? positiveIntegerFromEnv("DB_POOL_MAX", poolMaxFallback, environment),
    ...(useQueryTimeouts
      ? {
          query_timeout: positiveIntegerFromEnv("DB_QUERY_TIMEOUT_MS", 15000, environment),
          statement_timeout: positiveIntegerFromEnv("DB_STATEMENT_TIMEOUT_MS", 15000, environment)
        }
      : {}),
    ...(sslRequired ? { ssl: true } : {})
  };
}
