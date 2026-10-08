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
  query_timeout: 5000,
  statement_timeout: 5000
};
const transaction: Transaction = async (action) => {
  const client = new pg.Client(clientOptions);
  try {
    await client.connect();
    await client.query("begin");
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
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
const application = createApplicationRoutes({ transaction });
const handler = createHandler({
  applicationRoutes: async (request, path) =>
    (await auth(request, path)) ?? (await sessions(request, path)) ?? application(request, path),
  complete: true,
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
