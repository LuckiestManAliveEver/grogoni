import { Buffer } from "node:buffer";
import { hash } from "./credentials.ts";

export interface SqlClient {
  query: (
    sql: string,
    values?: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}
export type Transaction = <T>(action: (client: SqlClient) => Promise<T>) => Promise<T>;
const sessionPaths = new Set(["/session", "/auth/session", "/api/auth/session"]);
const logoutPaths = new Set(["/logout", "/auth/logout", "/api/auth/logout"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error("Invalid database timestamp.");
}

export function sessionCookie(request: Request): string | null {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("grogoni_session="));
  if (values.length !== 1) return null;
  const value = values[0].slice("grogoni_session=".length);
  return uuid.test(value) ? value : null;
}

export function createSessionRoutes(transaction: Transaction) {
  return async (request: Request, path: string): Promise<Response | null> => {
    if (!(
      (request.method === "GET" && sessionPaths.has(path)) ||
      (request.method === "POST" && logoutPaths.has(path))
    ))
      return null;
    const id = sessionCookie(request);
    if (request.method === "GET") {
      if (id === null)
        return Response.json(
          { code: "auth_required", message: "Authentication is required." },
          { status: 401 }
        );
      const view = await transaction(async (client) => {
        const result = await client.query(
          `
          select a.id as account_id, a.primary_auth_channel, a.primary_auth_destination,
            a.identity_level, a.status, a.created_at as account_created_at,
            u.id as user_id, u.display_name, u.language, u.created_at as user_created_at,
            s.id as session_id, s.expires_at, s.inactivity_expires_at, s.absolute_expires_at
          from sessions s join accounts a on a.id = s.account_id
            join users u on u.id = s.user_id and u.account_id = a.id
          where s.id = $1 and s.revoked_at is null and s.expires_at > now()
            and s.inactivity_expires_at > now() and s.absolute_expires_at > now()
            and a.status = 'active' and a.deleted_at is null
        `,
          [id]
        );
        const row = result.rows[0];
        if (!row) return null;
        return {
          account: {
            id: row.account_id,
            primaryAuthChannel: row.primary_auth_channel,
            primaryAuthDestination: row.primary_auth_destination,
            identityLevel: row.identity_level,
            status: row.status,
            createdAt: iso(row.account_created_at)
          },
          user: {
            id: row.user_id,
            accountId: row.account_id,
            displayName: row.display_name,
            language: row.language,
            createdAt: iso(row.user_created_at)
          },
          session: {
            id: row.session_id,
            expiresAt: iso(row.expires_at),
            inactivityExpiresAt: iso(row.inactivity_expires_at),
            absoluteExpiresAt: iso(row.absolute_expires_at)
          }
        };
      });
      return view
        ? Response.json(view)
        : Response.json(
            { code: "auth_required", message: "Authentication is required." },
            { status: 401 }
          );
    }
    const revoked =
      id === null
        ? false
        : await transaction(async (client) => {
            const session = (
              await client.query("select session_family_id from sessions where id = $1", [id])
            ).rows[0];
            if (!session) return false;
            await client.query("select pg_advisory_xact_lock($1::bigint)", [
              Buffer.from(hash(`session-family:${session.session_family_id}`), "hex")
                .readBigInt64BE()
                .toString()
            ]);
            const result = await client.query(
              `
        update sessions set revoked_at = now(), revocation_reason = 'logout'
        where session_family_id = (select session_family_id from sessions where id = $1)
          and account_id = (select account_id from sessions where id = $1)
          and revoked_at is null returning id, revoked_at
      `,
              [id]
            );
            if (!result.rows[0]) return false;
            await client.query(
              `
        update cp2_sessions set record = record || jsonb_build_object(
          'revokedAt', $2::text, 'revocationReason', 'logout'), updated_at = now()
        where entity_id = any($1::text[])
      `,
              [result.rows.map((row) => row.id), iso(result.rows[0].revoked_at)]
            );
            return true;
          });
    const headers = new Headers();
    for (const name of ["grogoni_session", "grogoni_refresh"]) {
      headers.append("Set-Cookie", `${name}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`);
    }
    return Response.json({ revoked }, { headers });
  };
}
