import { createPublicKey, randomBytes, randomUUID, type JsonWebKey } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  credentialHash,
  verifyCredential,
  correlation,
  hash,
  seal,
  unseal,
  verifyTotp,
  type AuthSecrets
} from "./credentials.ts";
import { iso, sessionCookie, type SqlClient, type Transaction } from "./session-routes.ts";

type Row = Record<string, unknown>;
export interface PhoneIdentity {
  e164: string;
  country?: string;
  nationalNumber: string;
}
interface Dependencies {
  transaction: Transaction;
  secrets: AuthSecrets;
  normalizePhone: (value: string, country?: string) => PhoneIdentity;
  passwordEnabled?: boolean;
  passkeysEnabled?: () => boolean;
}
const postPaths = new Set([
  "/auth/continue",
  "/auth/login/methods",
  "/auth/identify",
  "/auth/pin/login",
  "/auth/pin/store-login",
  "/auth/login/password",
  "/auth/pin/signup",
  "/auth/pin/continue",
  "/auth/signup/start",
  "/auth/signup/complete",
  "/auth/pin/setup",
  "/auth/mfa/challenge",
  "/auth/mfa/verify",
  "/auth/session/refresh",
  "/session/refresh"
]);
const getPaths = new Set(["/auth/bootstrap", "/auth/credentials/status", "/auth/pin/status"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = 86400000;
const accountSelect = `select a.id as account_id, a.primary_auth_channel,
  a.primary_auth_destination, a.identity_level, a.status, a.deleted_at,
  u.id as user_id, u.display_name, u.language, u.phone_number_e164,
  u.phone_country_code, u.phone_national_number, u.phone_verification_status,
  u.phone_added_at, u.phone_updated_at, u.phone_source, u.public_phone_enabled
  from accounts a join users u on u.account_id = a.id`;

class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}
function error(status: number, code: string, message: string) {
  return Response.json({ code, message }, { status });
}
const invalidLogin = () =>
  error(401, "auth_credentials_invalid", "The account credentials are invalid.");
function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new AuthError(400, "request_invalid", `${name} is invalid.`);
  return value;
}
function pin(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}$/.test(value))
    throw new AuthError(400, "pin_invalid", "PIN must be exactly 4 digits.");
  return value;
}
function email(value: unknown): string {
  const result = text(value, "email").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result))
    throw new AuthError(400, "destination_invalid", "Email address is invalid.");
  return result;
}
async function body(request: Request): Promise<Row> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  )
    throw new AuthError(415, "content_type_invalid", "Use application/json.");
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, "request_invalid", "A JSON body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 8192) {
        await reader.cancel();
        throw new AuthError(413, "request_too_large", "The request is too large.");
      }
      chunks.push(chunk.value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result as Row;
  } catch (cause) {
    if (cause instanceof AuthError) throw cause;
    throw new AuthError(400, "request_invalid", "A JSON object is required.");
  } finally {
    reader.releaseLock();
  }
}
function publicActor(row: Row) {
  return {
    account: {
      id: row.account_id,
      primaryAuthChannel: row.primary_auth_channel,
      primaryAuthDestination: row.primary_auth_destination,
      identityLevel: row.identity_level,
      status: row.status,
      deletedAt: row.deleted_at ? iso(row.deleted_at) : null
    },
    user: {
      id: row.user_id,
      accountId: row.account_id,
      displayName: row.display_name,
      language: row.language,
      phoneNumberE164: row.phone_number_e164 ?? null,
      phoneCountryCode: row.phone_country_code ?? null,
      phoneNationalNumber: row.phone_national_number ?? null,
      phoneVerificationStatus: row.phone_verification_status ?? null,
      phoneAddedAt: row.phone_added_at ? iso(row.phone_added_at) : null,
      phoneUpdatedAt: row.phone_updated_at ? iso(row.phone_updated_at) : null,
      phoneSource: row.phone_source ?? null,
      publicPhoneEnabled: row.public_phone_enabled === true
    }
  };
}
function sessionView(row: Row) {
  return {
    id: row.id,
    expiresAt: iso(row.expires_at),
    inactivityExpiresAt: iso(row.inactivity_expires_at),
    absoluteExpiresAt: iso(row.absolute_expires_at)
  };
}
function deviceView(row: Row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    platform: row.platform,
    browserOrApp: row.browser_or_app,
    sessionFamilyId: row.session_family_id,
    status: "active",
    createdAt: iso(row.created_at),
    lastUsedAt: iso(row.last_used_at),
    rotatedAt: null,
    expiresAt: iso(row.refresh_expires_at),
    absoluteExpiresAt: iso(row.absolute_expires_at),
    revokedAt: null,
    revocationReason: null,
    current: true
  };
}
type MirrorTable =
  | "cp2_accounts"
  | "cp2_users"
  | "cp2_account_identities"
  | "cp2_password_credentials"
  | "cp2_account_pin_hashes"
  | "cp2_sessions"
  | "cp2_mfa_factors"
  | "cp2_recovery_codes"
  | "cp2_auth_transactions"
  | "cp2_device_account_bootstraps"
  | "cp2_device_recovery_credentials";
async function mirror(client: SqlClient, table: MirrorTable, id: string, record: Row) {
  await client.query(
    `insert into ${table} (entity_id, account_id, user_id, record)
    values ($1, $2, $3, $4::jsonb) on conflict (entity_id) do update
    set record = excluded.record, account_id = excluded.account_id,
      user_id = excluded.user_id, updated_at = now()`,
    [id, record.accountId ?? null, record.userId ?? null, JSON.stringify(record)]
  );
}
function sessionRecord(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value instanceof Date ? value.toISOString() : value
    ])
  );
}
async function lock(client: SqlClient, key: string) {
  await client.query("select pg_advisory_xact_lock($1::bigint)", [
    Buffer.from(hash(key), "hex").readBigInt64BE().toString()
  ]);
}

export function createAuthRoutes({
  transaction,
  secrets,
  normalizePhone,
  passwordEnabled = true,
  passkeysEnabled = () => false
}: Dependencies) {
  if (Object.values(secrets).some((value) => value.trim().length < 32))
    throw new Error("Production authentication secrets are required.");
  function identifier(data: Row, login = false) {
    const type = login ? (data.method ?? data.channel) : data.type;
    if (type !== "phone" && type !== "email")
      throw new AuthError(400, "channel_invalid", "Use phone or email.");
    const raw = text(login ? (data.contact ?? data.destination) : data.identifier, "identifier");
    if (type === "email") return { type, value: email(raw), phone: null };
    try {
      const phone = normalizePhone(
        raw,
        data.country === undefined ? undefined : text(data.country, "country", 2)
      );
      return { type, value: phone.e164, phone };
    } catch {
      throw new AuthError(400, "INVALID_PHONE_NUMBER", "Enter a valid phone number.");
    }
  }
  async function findAccount(client: SqlClient, type: string, value: string, anyIdentity = false) {
    const result = await client.query(
      `${accountSelect} where
      (a.primary_auth_channel = $1 and a.primary_auth_destination = $2) or exists
      (select 1 from account_identities i where i.account_id = a.id and i.type = $1
        and i.normalized_value = $2 and ($3::boolean or i.type = 'phone' or i.verified_at is not null))
      order by u.created_at, u.id limit 1`,
      [type, value, anyIdentity]
    );
    return result.rows[0];
  }
  async function audit(client: SqlClient, event: string, key: string, account?: Row) {
    await client.query(
      `insert into auth_audit_events (account_id, user_id, event_type, metadata)
      values ($1, $2, $3, $4::jsonb)`,
      [
        account?.account_id ?? null,
        account?.user_id ?? null,
        event,
        JSON.stringify({ rateKey: key })
      ]
    );
  }
  async function limited(client: SqlClient, key: string, signup = false) {
    await lock(client, `auth-rate:${key}`);
    const result = await client.query(
      `select count(*)::int as attempts from auth_audit_events
      where metadata->>'rateKey' = $1 and event_type = $2
        and created_at > now() - interval '15 minutes'
        and created_at > coalesce((select max(created_at) from auth_audit_events
          where metadata->>'rateKey' = $1 and event_type = 'auth.edge.login_success'), '-infinity')`,
      [key, signup ? "auth.edge.signup_attempt" : "auth.edge.login_failure"]
    );
    return Number(result.rows[0]?.attempts ?? 0) >= (signup ? 10 : 5);
  }
  async function setPin(client: SqlClient, accountId: string, value: string) {
    const pinHash = credentialHash(accountId, value, secrets.pin, true);
    await client.query(
      `insert into account_pin_hashes (account_id, pin_hash) values ($1, $2)
      on conflict (account_id) do update set pin_hash = excluded.pin_hash, updated_at = now()`,
      [accountId, pinHash]
    );
    await mirror(client, "cp2_account_pin_hashes", accountId, { accountId, pinHash });
  }
  async function mfaChallenge(client: SqlClient, account: Row) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
    await client.query(
      `insert into auth_transactions (id, purpose, account_id, expires_at, created_at)
      values ($1, 'login_mfa', $2, $3, $4)`,
      [id, account.account_id, expiresAt, now]
    );
    await mirror(client, "cp2_auth_transactions", id, {
      id,
      purpose: "login_mfa",
      accountId: account.account_id,
      identifierType: null,
      identifierValue: null,
      providerChallengeId: null,
      verifiedAt: null,
      attempts: 0,
      expiresAt,
      consumedAt: null,
      metadata: {},
      createdAt: now
    });
    return { transactionId: id, factors: ["totp", "recovery_code"], expiresAt };
  }
  async function verifySecondFactor(
    client: SqlClient,
    accountId: string,
    factor: string,
    code: string
  ) {
    if (factor === "recovery_code") {
      const codeHash = correlation(`${accountId}:${code.trim().toUpperCase()}`, secrets.password);
      const recovered = (
        await client.query(
          `update recovery_codes set used_at = now()
        where account_id = $1 and code_hash = $2 and used_at is null returning *`,
          [accountId, codeHash]
        )
      ).rows[0];
      if (!recovered) return false;
      await mirror(client, "cp2_recovery_codes", String(recovered.id), sessionRecord(recovered));
      return true;
    }
    const row = (
      await client.query(
        `select * from mfa_factors where account_id = $1
      and verified_at is not null and disabled_at is null order by created_at, id limit 1 for update`,
        [accountId]
      )
    ).rows[0];
    if (!row) return false;
    const step = verifyTotp(
      unseal(String(row.secret_encrypted), secrets.encryption),
      code,
      Date.now(),
      row.last_used_step === null ? null : Number(row.last_used_step)
    );
    if (step === null) return false;
    await client.query("update mfa_factors set last_used_step = $2 where id = $1", [row.id, step]);
    await mirror(client, "cp2_mfa_factors", String(row.id), {
      id: row.id,
      accountId,
      type: row.factor_type,
      secret: row.secret_encrypted,
      lastUsedStep: step,
      verifiedAt: iso(row.verified_at),
      createdAt: iso(row.created_at),
      disabledAt: null
    });
    return true;
  }
  async function verifyMfa(client: SqlClient, request: Request, data: Row, challengeOnly: boolean) {
    const transactionId = text(data.transactionId, "transactionId", 36);
    if (!uuid.test(transactionId))
      throw new AuthError(400, "request_invalid", "transactionId is invalid.");
    const factor = challengeOnly ? "" : text(data.factor, "factor", 20);
    const code = challengeOnly ? "" : text(data.code, "code", 100);
    if (!challengeOnly && factor !== "totp" && factor !== "recovery_code")
      throw new AuthError(400, "mfa_factor_invalid", "MFA factor is invalid.");
    const challenge = (
      await client.query(
        `select * from auth_transactions where id = $1
      and purpose = 'login_mfa' and account_id is not null and consumed_at is null
      and expires_at > now() and attempts < 5 for update`,
        [transactionId]
      )
    ).rows[0];
    if (!challenge)
      return error(
        400,
        "auth_transaction_invalid",
        "The authentication request expired or is invalid."
      );
    const account = (
      await client.query(
        `${accountSelect} where a.id = $1 order by u.created_at, u.id limit 1 for update of a`,
        [challenge.account_id]
      )
    ).rows[0];
    if (!account || account.status !== "active" || account.deleted_at) return invalidLogin();
    if (challengeOnly)
      return Response.json({
        transactionId,
        factors: ["totp", "recovery_code"],
        expiresAt: iso(challenge.expires_at)
      });
    const key = correlation(`mfa:${account.account_id}`, secrets.audit);
    if (await limited(client, key))
      return error(429, "mfa_rate_limited", "Too many verification attempts. Try again later.");
    const valid = await verifySecondFactor(client, String(account.account_id), factor, code);
    const consumedAt = valid ? new Date().toISOString() : null;
    await client.query(
      "update auth_transactions set attempts = attempts + 1, consumed_at = $2 where id = $1",
      [transactionId, consumedAt]
    );
    await client.query(
      `update cp2_auth_transactions set record = record || $2::jsonb, updated_at = now()
      where entity_id = $1`,
      [transactionId, JSON.stringify({ attempts: Number(challenge.attempts) + 1, consumedAt })]
    );
    if (!valid) {
      await audit(client, "auth.edge.login_failure", key, account);
      return error(401, "mfa_code_invalid", "The verification code is invalid.");
    }
    await audit(client, "auth.edge.login_success", key, account);
    const session = await makeSession(client, account, request);
    return sessionResponse(account, session.row, session.refresh);
  }
  async function newAccount(
    client: SqlClient,
    id: { type: string; value: string; phone: PhoneIdentity | null },
    displayName?: string
  ) {
    const accountId = randomUUID();
    const userId = randomUUID();
    const now = new Date().toISOString();
    await client.query(
      `insert into accounts (id, primary_auth_channel, primary_auth_destination, created_at)
      values ($1, $2, $3, $4)`,
      [accountId, id.type, id.value, now]
    );
    await client.query(
      `insert into users (id, account_id, display_name, language, created_at,
      phone_number_e164, phone_country_code, phone_national_number, phone_verification_status,
      phone_added_at, phone_updated_at, phone_source)
      values ($1, $2, $3, 'en', $4, $5, $6, $7, $8, $9, $9, $10)`,
      [
        userId,
        accountId,
        displayName ?? `Trader ${id.value.slice(-4)}`,
        now,
        id.phone?.e164 ?? null,
        id.phone?.country ?? null,
        id.phone?.nationalNumber ?? null,
        id.phone ? "unverified" : null,
        id.phone ? now : null,
        id.phone ? "phone_login" : null
      ]
    );
    const row = (await client.query(`${accountSelect} where a.id = $1`, [accountId])).rows[0];
    const actor = publicActor(row);
    await mirror(client, "cp2_accounts", accountId, {
      ...actor.account,
      accountId,
      createdAt: now
    });
    await mirror(client, "cp2_users", userId, { ...actor.user, userId, createdAt: now });
    if (id.type !== "device") await addIdentity(client, row, id.type, id.value, true);
    return row;
  }
  async function addIdentity(
    client: SqlClient,
    row: Row,
    type: string,
    value: string,
    primary: boolean
  ) {
    const id = randomUUID();
    const now = new Date().toISOString();
    await client.query(
      `insert into account_identities (id, account_id, user_id, type,
      normalized_value, display_value, is_primary, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $5, $6, $7, $7)`,
      [id, row.account_id, row.user_id, type, value, primary, now]
    );
    await mirror(client, "cp2_account_identities", id, {
      id,
      accountId: row.account_id,
      userId: row.user_id,
      type,
      normalizedValue: value,
      displayValue: value,
      isPrimary: primary,
      verifiedAt: null,
      createdAt: now,
      updatedAt: now
    });
  }
  async function makeSession(client: SqlClient, account: Row, request: Request, previous?: Row) {
    const now = new Date();
    const absolute = previous
      ? iso(previous.absolute_expires_at)
      : new Date(now.getTime() + 180 * day).toISOString();
    const inactivity = new Date(
      Math.min(now.getTime() + 30 * day, Date.parse(absolute))
    ).toISOString();
    const refresh = randomBytes(32).toString("base64url");
    const metadata = (header: string, fallback: unknown, defaultValue: string) =>
      (request.headers.get(header)?.trim() || String(fallback ?? defaultValue)).slice(0, 200);
    const result = await client.query(
      `insert into sessions (id, account_id, user_id,
      expires_at, created_at, device_id, device_name, platform, browser_or_app,
      user_agent_hash, refresh_token_hash, session_family_id, refresh_expires_at,
      last_used_at, inactivity_expires_at, absolute_expires_at, rotated_from_session_id,
      authenticated_at, pin_verified_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$5,$13,$14,$15,$16,$17) returning *`,
      [
        randomUUID(),
        account.account_id,
        account.user_id,
        new Date(now.getTime() + 900000).toISOString(),
        now.toISOString(),
        metadata("x-grogoni-device-id", previous?.device_id, "unknown-device"),
        metadata("x-grogoni-device-name", previous?.device_name, "This device"),
        metadata("x-grogoni-platform", previous?.platform, "unknown"),
        metadata("x-grogoni-client", previous?.browser_or_app, "web"),
        hash(request.headers.get("user-agent") ?? ""),
        hash(refresh),
        previous?.session_family_id ?? randomUUID(),
        inactivity,
        absolute,
        previous?.id ?? null,
        previous ? iso(previous.authenticated_at) : now.toISOString(),
        previous ? previous.pin_verified_at : now.toISOString()
      ]
    );
    const row = result.rows[0];
    await mirror(client, "cp2_sessions", String(row.id), sessionRecord(row));
    return { row, refresh };
  }
  function sessionResponse(
    account: Row,
    row: Row,
    refresh: string,
    bootstrap = false,
    isNewAccount?: boolean
  ) {
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      `grogoni_session=${row.id}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=900`
    );
    headers.append(
      "Set-Cookie",
      `grogoni_refresh=${refresh}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${Math.max(0, Math.floor((Date.parse(iso(row.inactivity_expires_at)) - Date.now()) / 1000))}`
    );
    return Response.json(
      {
        ...publicActor(account),
        session: sessionView(row),
        ...(isNewAccount === undefined ? {} : { isNewAccount }),
        ...(bootstrap ? { authenticated: true, deviceSession: deviceView(row) } : {})
      },
      { headers }
    );
  }
  async function activeSession(client: SqlClient, request: Request) {
    const id = sessionCookie(request);
    if (!id) return null;
    const result = await client.query(
      `select s.* from sessions s join accounts a on a.id = s.account_id
      join users u on u.id = s.user_id and u.account_id = a.id where s.id = $1
      and s.revoked_at is null and s.expires_at > now() and s.inactivity_expires_at > now()
      and s.absolute_expires_at > now() and a.status = 'active' and a.deleted_at is null for update of s`,
      [id]
    );
    return result.rows[0] ?? null;
  }
  async function revokeFamily(client: SqlClient, row: Row, reason: string) {
    const result = await client.query(
      `update sessions set revoked_at = now(), revocation_reason = $2
      where session_family_id = $1 and revoked_at is null returning id, revoked_at`,
      [row.session_family_id, reason]
    );
    for (const revoked of result.rows) {
      await client.query(
        `update cp2_sessions set record = record || $2::jsonb, updated_at = now()
        where entity_id = $1`,
        [
          revoked.id,
          JSON.stringify({ revokedAt: iso(revoked.revoked_at), revocationReason: reason })
        ]
      );
    }
  }
  function refreshToken(request: Request): string | null {
    const cookies = (request.headers.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith("grogoni_refresh="));
    const token = cookies.length === 1 ? cookies[0].slice("grogoni_refresh=".length) : "";
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  }
  async function refreshSession(client: SqlClient, request: Request, token: string) {
    const first = (
      await client.query("select session_family_id from sessions where refresh_token_hash = $1", [
        hash(token)
      ])
    ).rows[0];
    if (!first) return error(401, "auth_refresh_revoked", "The refresh session is not valid.");
    await lock(client, `session-family:${first.session_family_id}`);
    const row = (
      await client.query("select * from sessions where refresh_token_hash = $1 for update", [
        hash(token)
      ])
    ).rows[0];
    const account = (
      await client.query(`${accountSelect} where a.id = $1 and u.id = $2 for update of a`, [
        row.account_id,
        row.user_id
      ])
    ).rows[0];
    if (!account || account.status !== "active" || account.deleted_at) {
      await revokeFamily(client, row, "account_status_changed");
      return invalidLogin();
    }
    if (
      [row.refresh_expires_at, row.inactivity_expires_at, row.absolute_expires_at].some(
        (value) => Date.parse(iso(value)) <= Date.now()
      )
    ) {
      await revokeFamily(client, row, "maximum_session_lifetime");
      return error(401, "auth_refresh_expired", "The refresh session has expired.");
    }
    if (row.revoked_at) {
      if (row.revocation_reason !== "rotated")
        return error(401, "auth_refresh_revoked", "The refresh session was revoked.");
      // Persist an encrypted replacement for the existing 15-second retry grace window.
      if (row.rotated_at && Date.now() - Date.parse(iso(row.rotated_at)) <= 15000) {
        const next = (
          await client.query(
            `select s.*, c.record->>'edgeRefreshToken' as encrypted_token
          from sessions s join cp2_sessions c on c.entity_id = s.id::text
          where s.rotated_from_session_id = $1 and s.revoked_at is null
            and s.expires_at > now() and s.inactivity_expires_at > now()`,
            [row.id]
          )
        ).rows[0];
        if (next?.encrypted_token)
          return sessionResponse(
            account,
            next,
            unseal(String(next.encrypted_token), secrets.encryption),
            true
          );
      }
      await revokeFamily(client, row, "refresh_token_reuse");
      return error(
        401,
        "auth_refresh_reuse_detected",
        "Refresh credential reuse was detected. Sign in again on this device."
      );
    }
    const next = await makeSession(client, account, request, row);
    await client.query(
      `update sessions set revoked_at = now(), rotated_at = now(),
      revocation_reason = 'rotated', last_used_at = now() where id = $1`,
      [row.id]
    );
    await client.query(
      `update cp2_sessions set record = record || jsonb_build_object(
      'revokedAt', now()::text, 'rotatedAt', now()::text, 'revocationReason', 'rotated'), updated_at = now()
      where entity_id = $1`,
      [row.id]
    );
    await client.query(
      `update cp2_sessions set record = record || $2::jsonb, updated_at = now()
      where entity_id = $1`,
      [next.row.id, JSON.stringify({ edgeRefreshToken: seal(next.refresh, secrets.encryption) })]
    );
    return sessionResponse(account, next.row, next.refresh, true);
  }

  return async (request: Request, path: string): Promise<Response | null> => {
    if (!(
      (request.method === "POST" && postPaths.has(path)) ||
      (request.method === "GET" && getPaths.has(path))
    ))
      return null;
    try {
      if (path === "/auth/continue") {
        const data = await body(request);
        return await transaction(async (client) => {
          const existing = await activeSession(client, request);
          if (existing) {
            const account = (
              await client.query(`${accountSelect} where a.id = $1`, [existing.account_id])
            ).rows[0];
            return Response.json({
              ...publicActor(account),
              session: sessionView(existing),
              isNewAccount: false
            });
          }
          const key = request.headers.get("idempotency-key")?.trim() ?? "";
          if (!/^[A-Za-z0-9_-]{32,128}$/.test(key))
            return error(
              400,
              "auth_continue_idempotency_required",
              "A secure Continue request key is required."
            );
          const jwk = data.devicePublicKeyJwk as Row | undefined;
          if (
            !jwk ||
            jwk.kty !== "EC" ||
            jwk.crv !== "P-256" ||
            typeof jwk.x !== "string" ||
            typeof jwk.y !== "string" ||
            jwk.d !== undefined
          )
            return error(400, "device_recovery_key_required", "A device public key is required.");
          const publicKey = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
          try {
            createPublicKey({ key: publicKey as JsonWebKey, format: "jwk" });
          } catch {
            return error(400, "device_recovery_key_invalid", "The device public key is invalid.");
          }
          const keyHash = hash(`grogoni-device-bootstrap:${key}`);
          const rateKey = correlation(
            `device:${request.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown"}`,
            secrets.audit
          );
          if (await limited(client, rateKey, true))
            return error(429, "auth_rate_limited", "Too many Continue attempts. Try again later.");
          await audit(client, "auth.edge.signup_attempt", rateKey);
          await lock(client, `device-bootstrap:${keyHash}`);
          const prior = (
            await client.query(
              "select record from cp2_device_account_bootstraps where entity_id = $1 and (record->>'expiresAt')::timestamptz > now()",
              [keyHash]
            )
          ).rows[0]?.record as Row | undefined;
          let account: Row;
          if (prior) {
            if (prior.keyFingerprint !== hash(JSON.stringify(publicKey)))
              return error(
                409,
                "device_bootstrap_conflict",
                "This Continue key belongs to another device."
              );
            account = (
              await client.query(
                `${accountSelect} where a.id = $1 and a.status = 'active' and a.deleted_at is null`,
                [prior.accountId]
              )
            ).rows[0];
            if (!account) return error(401, "auth_required", "The account is unavailable.");
          } else {
            account = await newAccount(
              client,
              {
                type: "device",
                value: `device:${randomBytes(24).toString("base64url")}`,
                phone: null
              },
              "Grogoni user"
            );
            await client.query("update accounts set identity_level = 'device' where id = $1", [
              account.account_id
            ]);
            account.identity_level = "device";
            await mirror(client, "cp2_accounts", String(account.account_id), {
              ...publicActor(account).account,
              accountId: account.account_id
            });
          }
          const credentialId = String(prior?.credentialId ?? randomUUID());
          const now = new Date().toISOString();
          await mirror(client, "cp2_device_recovery_credentials", credentialId, {
            id: credentialId,
            accountId: account.account_id,
            publicKeyJwk: publicKey,
            createdAt: now,
            updatedAt: now,
            revokedAt: null,
            lastAssertionHash: null,
            lastAssertionAt: null,
            lastSessionId: null
          });
          const session = await makeSession(client, account, request);
          await client.query("update sessions set pin_verified_at = null where id = $1", [
            session.row.id
          ]);
          session.row.pin_verified_at = null;
          await mirror(client, "cp2_sessions", String(session.row.id), sessionRecord(session.row));
          await mirror(client, "cp2_device_account_bootstraps", keyHash, {
            id: keyHash,
            accountId: account.account_id,
            sessionId: session.row.id,
            credentialId,
            keyFingerprint: hash(JSON.stringify(publicKey)),
            createdAt: now,
            expiresAt: new Date(Date.now() + 600000).toISOString()
          });
          const response = sessionResponse(account, session.row, session.refresh, false, !prior);
          const view = await response.json();
          return Response.json(
            { ...view, deviceRecoveryCredentialId: credentialId },
            { headers: response.headers }
          );
        });
      }
      if (path === "/auth/session/refresh" || path === "/session/refresh") {
        const token = refreshToken(request);
        const response = token
          ? await transaction((client) => refreshSession(client, request, token))
          : error(401, "auth_refresh_required", "A refresh session is required.");
        if (response.status === 401) {
          for (const name of ["grogoni_session", "grogoni_refresh"])
            response.headers.append(
              "Set-Cookie",
              `${name}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`
            );
        }
        return response;
      }
      if (getPaths.has(path))
        return await transaction(async (client) => {
          const session = await activeSession(client, request);
          if (!session)
            return error(
              401,
              path === "/auth/bootstrap" ? "auth_session_expired" : "auth_required",
              "Authentication is required."
            );
          if (path === "/auth/bootstrap") {
            const account = (
              await client.query(`${accountSelect} where a.id = $1 and u.id = $2`, [
                session.account_id,
                session.user_id
              ])
            ).rows[0];
            return Response.json({
              authenticated: true,
              ...publicActor(account),
              session: sessionView(session),
              deviceSession: deviceView(session)
            });
          }
          const result = (
            await client.query(
              `select exists(select 1 from account_pin_hashes where account_id = $1) as has_pin,
          exists(select 1 from password_credentials where account_id = $1) as has_password`,
              [session.account_id]
            )
          ).rows[0];
          return Response.json({
            hasPin: result.has_pin,
            ...(path === "/auth/pin/status" ? {} : { hasPassword: result.has_password })
          });
        });
      const data = await body(request);
      if (path === "/auth/mfa/challenge" || path === "/auth/mfa/verify")
        return await transaction((client) =>
          verifyMfa(client, request, data, path === "/auth/mfa/challenge")
        );
      if (path === "/auth/login/methods" || path === "/auth/identify") {
        identifier(data);
        if (path === "/auth/identify")
          return error(
            410,
            "auth_method_discovery_replaced",
            "Use the enumeration-safe login method endpoint."
          );
        return Response.json({
          preferred: "pin",
          passkeyAvailable: passkeysEnabled(),
          passwordFallback: passwordEnabled,
          recoveryAvailable: false,
          smsLogin: false
        });
      }
      if (path === "/auth/pin/setup") {
        const value = pin(data.pin);
        if (data.pinConfirmation !== undefined && value !== data.pinConfirmation)
          throw new AuthError(400, "pin_confirmation_invalid", "PINs do not match.");
        return await transaction(async (client) => {
          const session = await activeSession(client, request);
          if (!session) return error(401, "auth_required", "Authentication is required.");
          await client.query("select id from accounts where id = $1 for update", [
            session.account_id
          ]);
          if (Date.now() - Date.parse(iso(session.authenticated_at)) > 15 * 60000)
            return error(
              401,
              "auth_reauthentication_required",
              "Sign in again before changing credentials."
            );
          if (
            (
              await client.query(
                "select account_id from account_pin_hashes where account_id = $1",
                [session.account_id]
              )
            ).rows.length
          )
            return error(409, "pin_already_set", "A login PIN is already set for this account.");
          if (
            (
              await client.query(
                "select id from mfa_factors where account_id = $1 and verified_at is not null and disabled_at is null",
                [session.account_id]
              )
            ).rows.length
          ) {
            if (data.mfaCode === undefined)
              return error(401, "mfa_required", "Enter your second factor.");
            const code = text(data.mfaCode, "mfaCode", 100);
            const key = correlation(`mfa:${session.account_id}`, secrets.audit);
            if (await limited(client, key))
              return error(
                429,
                "mfa_rate_limited",
                "Too many verification attempts. Try again later."
              );
            if (
              !(await verifySecondFactor(
                client,
                String(session.account_id),
                /^\d{6}$/.test(code) ? "totp" : "recovery_code",
                code
              ))
            ) {
              await audit(client, "auth.edge.login_failure", key);
              return error(401, "mfa_code_invalid", "The verification code is invalid.");
            }
            await audit(client, "auth.edge.login_success", key);
          }
          await setPin(client, String(session.account_id), value);
          await client.query("update sessions set pin_verified_at = now() where id = $1", [
            session.id
          ]);
          await client.query(
            "update cp2_sessions set record = record || jsonb_build_object('pinVerifiedAt', now()::text), updated_at = now() where entity_id = $1",
            [session.id]
          );
          const account = (
            await client.query(`${accountSelect} where a.id = $1 and u.id = $2`, [
              session.account_id,
              session.user_id
            ])
          ).rows[0];
          return Response.json({ ...publicActor(account), session: sessionView(session) });
        });
      }
      if (path === "/auth/signup/complete") {
        if (!passwordEnabled)
          return error(403, "password_fallback_disabled", "Password fallback is disabled.");
        const transactionId = text(data.transactionId, "transactionId", 36);
        if (!uuid.test(transactionId))
          throw new AuthError(400, "request_invalid", "transactionId is invalid.");
        const displayName = text(data.displayName, "displayName", 100).trim();
        if (displayName.length < 2)
          throw new AuthError(400, "display_name_invalid", "Enter your display name.");
        const password = text(data.password, "password");
        if (password.length < 10)
          throw new AuthError(
            400,
            "password_invalid",
            "Use a password between 10 and 256 characters."
          );
        if (password !== data.passwordConfirmation)
          throw new AuthError(400, "password_confirmation_invalid", "Passwords do not match.");
        if (data.termsAccepted !== true || data.privacyAccepted !== true)
          throw new AuthError(
            400,
            "consent_required",
            "Accept the Terms and Privacy Policy to continue."
          );
        const extraEmail = data.email === undefined || data.email === "" ? null : email(data.email);
        return await transaction(async (client) => {
          const row = (
            await client.query(
              `select * from auth_transactions where id = $1 and purpose = 'signup'
            and consumed_at is null and expires_at > now() for update`,
              [transactionId]
            )
          ).rows[0];
          if (!row)
            return error(
              400,
              "auth_transaction_invalid",
              "The signup transaction is invalid or expired."
            );
          const metadata = row.metadata as Row;
          const id = identifier({ type: "phone", identifier: metadata.identifierValue });
          await lock(client, `signup:${id.type}:${id.value}`);
          if (await findAccount(client, id.type, id.value, true))
            return error(409, "account_exists", "Continue to sign in.");
          if (extraEmail && (await findAccount(client, "email", extraEmail, true)))
            return error(409, "identity_in_use", "That email cannot be linked to this account.");
          const account = await newAccount(client, id, displayName);
          if (extraEmail) await addIdentity(client, account, "email", extraEmail, false);
          const passwordHash = credentialHash(
            String(account.account_id),
            password,
            secrets.password,
            false
          );
          const now = new Date().toISOString();
          await client.query(
            `insert into password_credentials (account_id, password_hash, password_changed_at, created_at, updated_at)
            values ($1,$2,$3,$3,$3)`,
            [account.account_id, passwordHash, now]
          );
          await mirror(client, "cp2_password_credentials", String(account.account_id), {
            accountId: account.account_id,
            passwordHash,
            passwordChangedAt: now,
            createdAt: now,
            updatedAt: now
          });
          await client.query(
            "update auth_transactions set consumed_at = now(), account_id = $2 where id = $1",
            [row.id, account.account_id]
          );
          await client.query(
            "update cp2_auth_transactions set account_id = $2, record = record || $3::jsonb, updated_at = now() where entity_id = $1",
            [
              row.id,
              account.account_id,
              JSON.stringify({ accountId: account.account_id, consumedAt: now })
            ]
          );
          const session = await makeSession(client, account, request);
          return sessionResponse(account, session.row, session.refresh);
        });
      }
      const signup = path === "/auth/signup/start" || path === "/auth/pin/signup";
      const continuing = path === "/auth/pin/continue";
      const passwordLogin = path === "/auth/login/password";
      if (passwordLogin && !passwordEnabled)
        return error(403, "password_fallback_disabled", "Password fallback is disabled.");
      let id: ReturnType<typeof identifier>;
      if (path === "/auth/pin/store-login") {
        const value = text(data.grogoniId, "grogoniId", 100).trim().toUpperCase();
        id = { type: "email", value, phone: null };
      } else
        id = identifier(
          path === "/auth/signup/start"
            ? { ...data, type: "phone" }
            : passwordLogin
              ? data
              : {
                  ...data,
                  method:
                    data.method ?? data.channel ?? (signup || continuing ? "phone" : undefined)
                },
          !passwordLogin && path !== "/auth/signup/start"
        );
      if (path === "/auth/pin/signup" && id.type !== "phone")
        return error(400, "phone_pin_signup_only", "PIN signup requires a phone number.");
      const value =
        path === "/auth/signup/start"
          ? ""
          : passwordLogin
            ? text(data.password, "password")
            : pin(data.pin);
      return await transaction(async (client) => {
        let account =
          path === "/auth/pin/store-login"
            ? (
                await client.query(
                  `${accountSelect} join business_memberships m on m.user_id = u.id
            join businesses b on b.id = m.business_id where upper(b.grogoni_id) = $1
            and m.role = 'owner' and not exists
              (select 1 from cp2_account_deletion_requests d
                where d.record->>'businessId' = b.id::text and d.record->>'status' = 'QUARANTINED')
            order by u.created_at limit 1`,
                  [id.value]
                )
              ).rows[0]
            : await findAccount(client, id.type, id.value, signup);
        const key = correlation(
          account ? `account:${account.account_id}` : `${id.type}:${id.value}`,
          secrets.audit
        );
        if (await limited(client, key, signup))
          return error(
            429,
            signup ? "auth_rate_limited" : "pin_rate_limited",
            "Too many attempts. Try again later."
          );
        if (signup) await audit(client, "auth.edge.signup_attempt", key);
        if (path === "/auth/signup/start") {
          if (account) return error(409, "account_exists", "Continue to sign in.");
          const transactionId = randomUUID();
          const now = new Date().toISOString();
          const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
          const metadata = { identifierValue: id.value, phoneVerificationRequired: false };
          await client.query(
            `insert into auth_transactions (id, purpose, identifier_type, identifier_hash, expires_at, metadata, created_at)
            values ($1,'signup','phone',$2,$3,$4::jsonb,$5)`,
            [
              transactionId,
              correlation(id.value, secrets.audit),
              expiresAt,
              JSON.stringify(metadata),
              now
            ]
          );
          await mirror(client, "cp2_auth_transactions", transactionId, {
            id: transactionId,
            purpose: "signup",
            accountId: null,
            identifierType: "phone",
            identifierValue: id.value,
            providerChallengeId: null,
            verifiedAt: null,
            attempts: 0,
            expiresAt,
            consumedAt: null,
            metadata: { phoneVerificationRequired: false },
            createdAt: now
          });
          return Response.json({ transactionId, expiresAt, verificationRequired: false });
        }
        if (signup || (continuing && !account)) {
          await lock(client, `signup:${id.type}:${id.value}`);
          const existing = await findAccount(client, id.type, id.value, true);
          if (existing) {
            if (signup) return error(409, "account_exists", "Continue to sign in.");
            account = await findAccount(client, id.type, id.value);
            if (!account) return error(409, "identity_in_use", "That identity is already in use.");
          } else {
            account = await newAccount(client, id);
            await setPin(client, String(account.account_id), value);
            const session = await makeSession(client, account, request);
            return sessionResponse(
              account,
              session.row,
              session.refresh,
              false,
              continuing ? true : undefined
            );
          }
        }
        if (account) {
          const state = (
            await client.query("select status, deleted_at from accounts where id = $1 for update", [
              account.account_id
            ])
          ).rows[0];
          if (state?.status !== "active" || state.deleted_at) account = undefined;
        }
        const credential = account
          ? (
              await client.query(
                passwordLogin
                  ? "select password_hash as credential from password_credentials where account_id = $1"
                  : "select pin_hash as credential from account_pin_hashes where account_id = $1",
                [account.account_id]
              )
            ).rows[0]?.credential
          : undefined;
        const secret = passwordLogin ? secrets.password : secrets.pin;
        const valid = credential
          ? verifyCredential(
              String(account!.account_id),
              value,
              String(credential),
              secret,
              !passwordLogin
            )
          : "invalid";
        if (!account || valid === "invalid") {
          if (!credential) credentialHash("unknown-account", value, secret, !passwordLogin);
          await audit(client, "auth.edge.login_failure", key);
          return invalidLogin();
        }
        if (
          passwordLogin &&
          (
            await client.query(
              "select id from mfa_factors where account_id = $1 and verified_at is not null and disabled_at is null",
              [account.account_id]
            )
          ).rows.length
        ) {
          await audit(client, "auth.edge.login_success", key, account);
          return Response.json({ mfaRequired: true, ...(await mfaChallenge(client, account)) });
        }
        if (valid === "legacy") await setPin(client, String(account.account_id), value);
        await audit(client, "auth.edge.login_success", key, account);
        const session = await makeSession(client, account, request);
        return sessionResponse(
          account,
          session.row,
          session.refresh,
          false,
          continuing ? false : undefined
        );
      });
    } catch (cause) {
      if (cause instanceof AuthError) return error(cause.status, cause.code, cause.message);
      if ((cause as { code?: string })?.code === "23505")
        return error(409, "identity_in_use", "That identity is already in use. Sign in instead.");
      throw cause;
    }
  };
}
