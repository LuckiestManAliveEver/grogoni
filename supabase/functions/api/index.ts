import pg from "npm:pg@8.22.0";
import {
  parsePhoneNumberWithError,
  isSupportedCountry,
  type CountryCode
} from "npm:libphonenumber-js@1.13.9/max";
import { createHandler } from "./handler.ts";
import { connectDatabase } from "./database-connection.ts";
import { createSessionRoutes } from "./session-routes.ts";
import { createAuthRoutes } from "./auth-routes.ts";
import { createApplicationRoutes, type EdgeJobOutcome } from "./application-routes.ts";
import { createPublicRoutes } from "./public-routes.ts";
import { createJobTransaction } from "./job-transaction.ts";
import { coordinateStoreRequest } from "./store-coordination.ts";
import type { Transaction } from "./session-routes.ts";
import {
  createRateLimiter,
  forwardingHeaders,
  RateLimitExceededError,
  rateLimitedResponse,
  readRateLimitPolicy
} from "./rate-limit.ts";

const connectionString = Deno.env.get("DATABASE_URL")?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required.");
const url = new URL(connectionString);
if (!["postgres:", "postgresql:"].includes(url.protocol))
  throw new Error("DATABASE_URL must use PostgreSQL.");
if (!["localhost", "127.0.0.1"].includes(url.hostname))
  url.searchParams.set("sslmode", "verify-full");
const clientOptions = {
  connectionString: url.toString(),
  connectionTimeoutMillis: 10000,
  query_timeout: 15000,
  statement_timeout: 15000
};
const pool = new pg.Pool({ ...clientOptions, max: 4, idleTimeoutMillis: 30000 });
pool.on("error", () => console.error(JSON.stringify({ event: "edge_idle_connection_failed" })));
const rateLimiter = createRateLimiter(readRateLimitPolicy((name) => Deno.env.get(name)));
let lastTransactionFailure: {
  at: string;
  stage: string;
  category: string;
  code: string | null;
} | null = null;
const transaction: Transaction = async (action) => {
  let client: pg.PoolClient | undefined;
  let discardConnection = false;
  let stage = "connect";
  try {
    client = await pool.connect();
    stage = "rate_limit";
    await rateLimiter.check(client);
    stage = "begin";
    await client.query("begin");
    await client.query("set local lock_timeout = '10s'");
    stage = "store_coordination";
    await coordinateStoreRequest(client);
    stage = "action";
    const result = await action(client);
    stage = "commit";
    await client.query("commit");
    return result;
  } catch (error) {
    if (error instanceof RateLimitExceededError) throw error;
    recordTransactionFailure(stage, error);
    await client?.query("rollback").catch(() => {
      discardConnection = true;
    });
    throw error;
  } finally {
    client?.release(discardConnection);
  }
};
function recordTransactionFailure(stage: string, error: unknown) {
  lastTransactionFailure = {
    at: new Date().toISOString(),
    stage,
    category:
      error instanceof Error && /timeout|timed out/i.test(error.message)
        ? "timeout"
        : "database_failure",
    code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : null
  };
  console.error(JSON.stringify({ event: "edge_transaction_failed", ...lastTransactionFailure }));
}
// Job records live outside the store snapshot; writing one takes no store lock.
const recordTransaction: Transaction = async (action) => {
  const client = await connectDatabase(() => new pg.Client(clientOptions));
  try {
    await client.query("begin");
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
    recordTransactionFailure("job_record", error);
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
};
const jobTransaction = createJobTransaction({
  connect: () => connectDatabase(() => new pg.Client(clientOptions)),
  onFailure: recordTransactionFailure
});
const sessions = createSessionRoutes(transaction);
const auth = createAuthRoutes({
  transaction,
  secrets: {
    pin: Deno.env.get("PIN_HASH_SECRET") ?? "",
    password: Deno.env.get("PASSWORD_HASH_SECRET") ?? "",
    audit: Deno.env.get("AUTH_AUDIT_HMAC_SECRET") ?? "",
    encryption: Deno.env.get("AUTH_TOKEN_ENCRYPTION_KEY") ?? ""
  },
  passwordEnabled: Deno.env.get("AUTH_PASSWORD_FALLBACK_ENABLED") !== "false",
  passkeysEnabled: () => Deno.env.get("AUTH_PASSKEYS_ENABLED") !== "false",
  normalizePhone: (value, country) => {
    const normalizedCountry = country?.toUpperCase();
    if (normalizedCountry && !isSupportedCountry(normalizedCountry))
      throw new Error("Invalid country.");
    if (!normalizedCountry && !value.trim().startsWith("+"))
      throw new Error("International phone required.");
    const phone = parsePhoneNumberWithError(value, {
      defaultCountry: normalizedCountry as CountryCode | undefined,
      extract: false
    });
    if (
      !phone.isValid() ||
      !phone.country ||
      (normalizedCountry && phone.country !== normalizedCountry)
    )
      throw new Error("Invalid phone.");
    return { e164: phone.number, country: phone.country, nationalNumber: phone.nationalNumber };
  }
});
const application = createApplicationRoutes({
  transaction,
  jobToken: Deno.env.get("BACKGROUND_JOB_TOKEN") ?? "",
  recordTransaction,
  runJob: async (jobName) => {
    const runtime = await getDomain();
    if (runtime === null) throw new Error("The domain runtime failed to start.");
    return runtime.runJob(jobName);
  }
});
const publicRoutes = createPublicRoutes(transaction);
let domain: {
  routes: (request: Request, path: string) => Promise<Response | null>;
  runJob: (jobName: string) => Promise<EdgeJobOutcome>;
} | null = null;
let domainStartupError: string | null = null;
let domainInitialization: Promise<typeof domain> | undefined;
function getDomain() {
  return (domainInitialization ??= (async () => {
    try {
      const { createEdgeDomainRoutes } = await import("./domain-bundle.mjs");
      domain = await createEdgeDomainRoutes({ transaction, jobTransaction });
      domainStartupError = null;
      return domain;
    } catch (error) {
      domainStartupError = error instanceof Error ? error.name : "Domain initialization failed";
      console.error(
        JSON.stringify({ event: "edge_domain_startup_failed", errorType: domainStartupError })
      );
      domainInitialization = undefined;
      return null;
    }
  })());
}
async function routeRequest(request: Request, path: string): Promise<Response | null> {
  if (path === "/internal/edge/domain-startup") {
    const token = Deno.env.get("AUTH_AUDIT_HMAC_SECRET");
    if (!token || request.headers.get("x-edge-diagnostic-token") !== token)
      return Response.json({ code: "auth_required" }, { status: 401 });
    return Response.json({
      ready: domain !== null,
      error: domainStartupError,
      lastTransactionFailure,
      forwardingHeaders: forwardingHeaders(request)
    });
  }
  return (
    (await auth(request, path)) ??
    (await sessions(request, path)) ??
    (await publicRoutes(request, path)) ??
    (path === "/realtime" || path.startsWith("/v1/realtime/") || path.startsWith("/internal/jobs/")
      ? application(request, path)
      : ((await (await getDomain())?.routes(request, path)) ??
        (domain === null ? Response.json({ code: "service_unavailable" }, { status: 503 }) : null)))
  );
}
const handler = createHandler({
  complete: async () => (await getDomain()) !== null,
  databaseProvider:
    url.hostname.endsWith(".neon.tech") || url.hostname.endsWith(".neon.database")
      ? "neon"
      : "postgres",
  applicationRoutes: (request, path) =>
    rateLimiter
      .run(request, path, () => routeRequest(request, path))
      .catch((error: unknown) => {
        if (error instanceof RateLimitExceededError) return rateLimitedResponse(error);
        throw error;
      }),
  allowedOrigins: (Deno.env.get("WEB_ORIGINS") ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  checkDatabase: async () => {
    await pool.query("select 1");
  }
});
Deno.serve(handler);
