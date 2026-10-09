import pg from "npm:pg@8.22.0";
import {
  parsePhoneNumberWithError,
  isSupportedCountry,
  type CountryCode
} from "npm:libphonenumber-js@1.13.9/max";
import { createHandler } from "./handler.ts";
import { createSessionRoutes } from "./session-routes.ts";
import { createAuthRoutes } from "./auth-routes.ts";
import { createApplicationRoutes } from "./application-routes.ts";
import { createPublicRoutes } from "./public-routes.ts";
import type { Transaction } from "./session-routes.ts";

const connectionString = Deno.env.get("DATABASE_URL")?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required for the Neon database.");
const url = new URL(connectionString);
if (!url.hostname.endsWith(".neon.tech") && !url.hostname.endsWith(".neon.database")) {
  throw new Error("This deployment requires a Neon database connection.");
}
url.searchParams.set("sslmode", "verify-full");
const clientOptions = {
  connectionString: url.toString(),
  connectionTimeoutMillis: 5000,
  query_timeout: 15000,
  statement_timeout: 15000
};
let lastTransactionFailure: {
  at: string;
  stage: string;
  category: string;
  code: string | null;
} | null = null;
const transaction: Transaction = async (action) => {
  const client = new pg.Client(clientOptions);
  let stage = "connect";
  try {
    await client.connect();
    stage = "begin";
    await client.query("begin");
    await client.query("set local lock_timeout = '10s'");
    stage = "store_lock";
    await client.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
    stage = "action";
    const result = await action(client);
    stage = "commit";
    await client.query("commit");
    return result;
  } catch (error) {
    lastTransactionFailure = {
      at: new Date().toISOString(),
      stage,
      category:
        error instanceof Error && /timeout|timed out/i.test(error.message)
          ? "timeout"
          : "database_failure",
      code:
        typeof error === "object" && error !== null && "code" in error ? String(error.code) : null
    };
    console.error(JSON.stringify({ event: "edge_transaction_failed", ...lastTransactionFailure }));
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
};
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
  passkeysEnabled: () => domain !== null && Deno.env.get("AUTH_PASSKEYS_ENABLED") !== "false",
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
  jobToken: Deno.env.get("BACKGROUND_JOB_TOKEN") ?? ""
});
const publicRoutes = createPublicRoutes(transaction);
let domain: { routes: (request: Request, path: string) => Promise<Response | null> } | null = null;
let domainStartupError: string | null = null;
try {
  const { createEdgeDomainRoutes } = await import("./domain-bundle.mjs");
  domain = await createEdgeDomainRoutes({ transaction });
} catch (error) {
  domainStartupError =
    error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : "Domain initialization failed";
  console.error("Edge domain initialization failed", domainStartupError);
}
const handler = createHandler({
  applicationRoutes: async (request, path) => {
    if (path === "/internal/edge/domain-startup") {
      const token = Deno.env.get("AUTH_AUDIT_HMAC_SECRET");
      if (!token || request.headers.get("x-edge-diagnostic-token") !== token)
        return Response.json({ code: "auth_required" }, { status: 401 });
      return Response.json({
        ready: domain !== null,
        error: domainStartupError,
        lastTransactionFailure
      });
    }
    return (
      (await auth(request, path)) ??
      (await sessions(request, path)) ??
      (await domain?.routes(request, path)) ??
      (await publicRoutes(request, path)) ??
      (domain === null
        ? Response.json({ code: "service_unavailable" }, { status: 503 })
        : path === "/realtime" ||
            path.startsWith("/v1/realtime/") ||
            path.startsWith("/internal/jobs/")
          ? application(request, path)
          : null)
    );
  },
  complete: domain !== null,
  allowedOrigins: (Deno.env.get("WEB_ORIGINS") ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  checkDatabase: async () => {
    const client = new pg.Client(clientOptions);
    try {
      await client.connect();
      await client.query("select 1");
    } finally {
      await client.end();
    }
  }
});
Deno.serve(handler);
