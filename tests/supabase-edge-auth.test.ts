import { describe, expect, it, vi } from "vitest";
import { createAuthRoutes } from "../supabase/functions/api/auth-routes";
import {
  credentialHash,
  verifyCredential,
  hash,
  seal,
  unseal,
  totpCode,
  verifyTotp
} from "../supabase/functions/api/credentials";
import type { SqlClient, Transaction } from "../supabase/functions/api/session-routes";
import { createHandler } from "../supabase/functions/api/handler";

const id = "00000000-0000-4000-8000-000000000001";
const secrets = {
  pin: "p".repeat(64),
  password: "w".repeat(64),
  audit: "a".repeat(64),
  encryption: "e".repeat(64)
};
const account = {
  account_id: id,
  user_id: id,
  status: "active",
  deleted_at: null,
  primary_auth_channel: "phone",
  primary_auth_destination: "+254712345678",
  identity_level: "strong",
  display_name: "Test user",
  language: "en"
};
const now = new Date().toISOString();
const session = {
  id,
  account_id: id,
  user_id: id,
  created_at: now,
  last_used_at: now,
  authenticated_at: now,
  pin_verified_at: now,
  expires_at: new Date(Date.now() + 900000).toISOString(),
  refresh_expires_at: new Date(Date.now() + 86400000).toISOString(),
  inactivity_expires_at: new Date(Date.now() + 86400000).toISOString(),
  absolute_expires_at: new Date(Date.now() + 86400000 * 180).toISOString(),
  session_family_id: id,
  revoked_at: null,
  device_id: "test-device",
  device_name: "Test",
  browser_or_app: "web",
  platform: "test"
};
function request(path: string, data: unknown = {}, cookie = "", method = "POST") {
  return new Request(`https://example.com${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    ...(method === "POST" ? { body: JSON.stringify(data) } : {})
  });
}
function setup(query: SqlClient["query"], passwordEnabled = true) {
  const transaction = vi.fn(async <T>(action: (client: SqlClient) => Promise<T>) =>
    action({ query })
  );
  const routes = createAuthRoutes({
    transaction: transaction as Transaction,
    secrets,
    passwordEnabled,
    normalizePhone: (value) => {
      if (value !== "+254712345678") throw new Error();
      return { e164: value, country: "KE", nationalNumber: "712345678" };
    }
  });
  return { routes, transaction };
}
function loginQuery(credential: string, attempts = 0, mfa = false) {
  return vi.fn(async (sql: string) => {
    if (sql.includes("from accounts a")) return { rows: [account] };
    if (sql.includes("select status, deleted_at")) return { rows: [account] };
    if (sql.includes("count(*)::int")) return { rows: [{ attempts }] };
    if (sql.includes("as credential")) return { rows: [{ credential }] };
    if (sql.includes("from mfa_factors")) return { rows: mfa ? [{ id }] : [] };
    if (sql.includes("insert into sessions")) return { rows: [session] };
    return { rows: [] };
  });
}

describe("Edge credential compatibility", () => {
  it.each([true, false])(
    "preserves scrypt formats and verifies secret and credential (PIN=%s)",
    (pin) => {
      const value = pin ? "1234" : "password-long-enough";
      const stored = credentialHash(id, value, secrets.pin, pin);
      expect(
        stored.startsWith(pin ? "scrypt$v2$16384$8$1$" : "scrypt$password-v1$32768$8$1$")
      ).toBe(true);
      expect(verifyCredential(id, value, stored, secrets.pin, pin)).toBe("current");
      expect(verifyCredential(id, "wrong", stored, secrets.pin, pin)).toBe("invalid");
      expect(verifyCredential(id, value, stored, secrets.password, pin)).toBe("invalid");
      expect(verifyCredential("other", value, stored, secrets.pin, pin)).toBe("invalid");
    }
  );
  it("accepts legacy PINs only after verification", () => {
    const stored = hash(`${id}:1234`);
    expect(verifyCredential(id, "1234", stored, secrets.pin, true)).toBe("legacy");
    expect(verifyCredential(id, "4321", stored, secrets.pin, true)).toBe("invalid");
  });
  it("rejects invalid hash parameters and malformed salts", () => {
    for (const stored of ["invalid", "scrypt$v2$999999$8$1$AA$AA", "scrypt$v2$16384$8$1$AA$AA"])
      expect(verifyCredential(id, "1234", stored, secrets.pin, true)).toBe("invalid");
  });
  it("encrypts refresh grace tokens with authenticated envelopes", () => {
    const envelope = seal("private-refresh-token", secrets.encryption);
    expect(envelope).not.toContain("private-refresh-token");
    expect(unseal(envelope, secrets.encryption)).toBe("private-refresh-token");
    expect(() => unseal(envelope, secrets.pin)).toThrow();
  });
});

describe("native Edge authentication routes", () => {
  it("does not enumerate accounts or advertise unfinished passkeys/recovery", async () => {
    const query = vi.fn();
    const { routes, transaction } = setup(query);
    for (const identifier of ["known@example.com", "unknown@example.com"]) {
      const r = await routes(
        request("/auth/login/methods", { type: "email", identifier }),
        "/auth/login/methods"
      );
      expect(await r!.json()).toEqual({
        preferred: "pin",
        passkeyAvailable: false,
        passwordFallback: true,
        recoveryAvailable: false,
        smsLogin: false
      });
    }
    expect(transaction).not.toHaveBeenCalled();
  });
  it("validates phone input and four-digit PINs before querying", async () => {
    const { routes, transaction } = setup(vi.fn());
    for (const data of [
      { method: "phone", contact: "bad", pin: "1234" },
      { method: "phone", contact: "+254712345678", pin: "12345" }
    ]) {
      expect((await routes(request("/auth/pin/login", data), "/auth/pin/login"))!.status).toBe(400);
    }
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([null, [], "invalid", { large: "x".repeat(9000) }])(
    "rejects invalid/oversized body %j",
    async (data) => {
      const { routes, transaction } = setup(vi.fn());
      const r = await routes(request("/auth/pin/login", data), "/auth/pin/login");
      expect([400, 413]).toContain(r!.status);
      expect(transaction).not.toHaveBeenCalled();
    }
  );
  it("rejects malformed JSON and wrong content type", async () => {
    const { routes } = setup(vi.fn());
    const malformed = new Request("https://example.com/auth/pin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    expect((await routes(malformed, "/auth/pin/login"))!.status).toBe(400);
    const wrong = new Request("https://example.com/auth/pin/login", { method: "POST", body: "{}" });
    expect((await routes(wrong, "/auth/pin/login"))!.status).toBe(415);
  });
  it.each([true, false])(
    "creates secure sessions after credential verification (PIN=%s)",
    async (pin) => {
      const value = pin ? "1234" : "password-long-enough";
      const path = pin ? "/auth/pin/login" : "/auth/login/password";
      const query = loginQuery(
        credentialHash(id, value, pin ? secrets.pin : secrets.password, pin)
      );
      const { routes } = setup(query);
      const r = await routes(
        request(
          path,
          pin
            ? { method: "phone", contact: "+254712345678", pin: value }
            : { type: "phone", identifier: "+254712345678", password: value }
        ),
        path
      );
      expect(r!.status).toBe(200);
      expect((await r!.json()).account.id).toBe(id);
      const cookies = r!.headers.getSetCookie();
      expect(cookies).toHaveLength(2);
      for (const cookie of cookies) {
        expect(cookie).toContain("HttpOnly; Secure; SameSite=None");
      }
      expect(query.mock.calls.some(([sql]) => sql.includes("insert into cp2_sessions"))).toBe(true);
    }
  );
  it("commits failed-attempt audit rows instead of throwing and rolling them back", async () => {
    const query = loginQuery(credentialHash(id, "1234", secrets.pin, true));
    const { routes, transaction } = setup(query);
    const r = await routes(
      request("/auth/pin/login", { method: "phone", contact: "+254712345678", pin: "4321" }),
      "/auth/pin/login"
    );
    expect(r!.status).toBe(401);
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into auth_audit_events"))).toBe(
      true
    );
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into sessions"))).toBe(false);
    expect(await transaction.mock.results[0].value).toBeInstanceOf(Response);
  });
  it("uses a durable lock and rejects login after five failures", async () => {
    const query = loginQuery("unused", 5);
    const { routes } = setup(query);
    const r = await routes(
      request("/auth/pin/login", { method: "phone", contact: "+254712345678", pin: "1234" }),
      "/auth/pin/login"
    );
    expect(r!.status).toBe(429);
    expect(query.mock.calls.some(([sql]) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes("as credential"))).toBe(false);
  });
  it("does not bypass MFA on password login", async () => {
    const query = loginQuery(
      credentialHash(id, "password-long-enough", secrets.password, false),
      0,
      true
    );
    const { routes } = setup(query);
    const r = await routes(
      request("/auth/login/password", {
        type: "phone",
        identifier: "+254712345678",
        password: "password-long-enough"
      }),
      "/auth/login/password"
    );
    expect(r!.status).toBe(200);
    const result = await r!.json();
    expect(result.mfaRequired).toBe(true);
    expect(result.factors).toEqual(["totp", "recovery_code"]);
    expect(result.transactionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r!.headers.getSetCookie()).toHaveLength(0);
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into sessions"))).toBe(false);
  });
  it("honors password fallback configuration", async () => {
    const { routes, transaction } = setup(vi.fn(), false);
    const r = await routes(request("/auth/login/password", {}), "/auth/login/password");
    expect(r!.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
  });
  it("requires signup consent and matching passwords before accessing Neon", async () => {
    const { routes, transaction } = setup(vi.fn());
    const base = {
      transactionId: id,
      displayName: "Test",
      password: "password-long-enough",
      passwordConfirmation: "password-long-enough",
      termsAccepted: true,
      privacyAccepted: true
    };
    for (const data of [
      { ...base, termsAccepted: false },
      { ...base, passwordConfirmation: "different" }
    ]) {
      expect(
        (await routes(request("/auth/signup/complete", data), "/auth/signup/complete"))!.status
      ).toBe(400);
    }
    expect(transaction).not.toHaveBeenCalled();
  });
  it("does not query Neon for missing, malformed, or duplicate refresh cookies", async () => {
    const query = vi.fn();
    const { routes } = setup(query);
    for (const cookie of [
      "",
      "grogoni_refresh=bad",
      `grogoni_refresh=${"a".repeat(43)}; grogoni_refresh=${"a".repeat(43)}`
    ]) {
      const r = await routes(request("/auth/session/refresh", {}, cookie), "/auth/session/refresh");
      expect(r!.status).toBe(401);
      expect(r!.headers.getSetCookie()).toHaveLength(2);
    }
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects browser origins before executing authentication", async () => {
    const { routes, transaction } = setup(vi.fn());
    const handler = createHandler({
      applicationRoutes: routes,
      allowedOrigins: ["https://grogoni.com"],
      checkDatabase: vi.fn()
    });
    const r = await handler(
      new Request("https://example.com/api/auth/pin/login", {
        method: "POST",
        headers: { origin: "https://attacker.example", "content-type": "application/json" },
        body: "{}"
      })
    );
    expect(r.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
  });
  it("leaves unrelated routes and methods untouched", async () => {
    const { routes } = setup(vi.fn());
    expect(await routes(request("/businesses"), "/businesses")).toBeNull();
    expect(await routes(request("/auth/pin/login", {}, "", "GET"), "/auth/pin/login")).toBeNull();
  });
  it("rejects consumed signup transactions without creating credentials", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const { routes } = setup(query);
    const response = await routes(
      request("/auth/signup/complete", {
        transactionId: id,
        displayName: "Test",
        password: "password-long-enough",
        passwordConfirmation: "password-long-enough",
        termsAccepted: true,
        privacyAccepted: true
      }),
      "/auth/signup/complete"
    );
    expect(response!.status).toBe(400);
    expect(query.mock.calls).toHaveLength(1);
  });
  it.each(["/auth/bootstrap", "/auth/credentials/status", "/auth/pin/status"])(
    "protects %s",
    async (path) => {
      const query = vi.fn();
      const { routes } = setup(query);
      expect((await routes(request(path, {}, "", "GET"), path))!.status).toBe(401);
      expect(query).not.toHaveBeenCalled();
    }
  );
  it("requires an authenticated session for PIN setup", async () => {
    const query = vi.fn();
    const { routes } = setup(query);
    expect(
      (await routes(request("/auth/pin/setup", { pin: "1234" }), "/auth/pin/setup"))!.status
    ).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("native Edge MFA", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const challenge = {
    id,
    account_id: id,
    attempts: 0,
    expires_at: new Date(Date.now() + 600000).toISOString()
  };
  function mfaQuery(
    options: {
      validTransaction?: boolean;
      lastStep?: number;
      recovery?: boolean;
      suspended?: boolean;
      attempts?: number;
    } = {}
  ) {
    return vi.fn(async (sql: string) => {
      if (sql.includes("select * from auth_transactions"))
        return { rows: options.validTransaction === false ? [] : [challenge] };
      if (sql.includes("from accounts a"))
        return { rows: [{ ...account, status: options.suspended ? "suspended" : "active" }] };
      if (sql.includes("count(*)::int")) return { rows: [{ attempts: options.attempts ?? 0 }] };
      if (sql.includes("select * from mfa_factors"))
        return {
          rows: [
            {
              id,
              account_id: id,
              factor_type: "totp",
              secret_encrypted: seal(secret, secrets.encryption),
              verified_at: now,
              created_at: now,
              last_used_step: options.lastStep ?? null
            }
          ]
        };
      if (sql.includes("update recovery_codes"))
        return {
          rows: options.recovery
            ? [{ id, account_id: id, code_hash: "private", used_at: now, created_at: now }]
            : []
        };
      if (sql.includes("insert into sessions")) return { rows: [session] };
      return { rows: [] };
    });
  }
  it("matches the RFC 6238 SHA-1 test vector and prevents time-step replay", () => {
    expect(totpCode(secret, 1)).toBe("287082");
    expect(verifyTotp(secret, "287082", 59000, null)).toBe(1);
    expect(verifyTotp(secret, "287082", 59000, 1)).toBeNull();
    expect(verifyTotp(secret, "bad", 59000, null)).toBeNull();
  });
  it("requires an active, unconsumed purpose-bound transaction for challenge discovery", async () => {
    const query = mfaQuery();
    const { routes } = setup(query);
    const r = await routes(
      request("/auth/mfa/challenge", { transactionId: id }),
      "/auth/mfa/challenge"
    );
    expect(r!.status).toBe(200);
    expect(await r!.json()).toEqual({
      transactionId: id,
      factors: ["totp", "recovery_code"],
      expiresAt: challenge.expires_at
    });
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into sessions"))).toBe(false);
    expect(query.mock.calls[0][0]).toContain("attempts < 5");
  });
  it("issues a session only after verified TOTP and mirrors the consumed step and transaction", async () => {
    const query = mfaQuery();
    const { routes } = setup(query);
    const code = totpCode(secret, Math.floor(Date.now() / 30000));
    const r = await routes(
      request("/auth/mfa/verify", { transactionId: id, factor: "totp", code }),
      "/auth/mfa/verify"
    );
    expect(r!.status).toBe(200);
    expect((await r!.json()).account.id).toBe(id);
    expect(r!.headers.getSetCookie()).toHaveLength(2);
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into cp2_mfa_factors"))).toBe(
      true
    );
    expect(query.mock.calls.some(([sql]) => sql.includes("update cp2_auth_transactions"))).toBe(
      true
    );
  });
  it("persists failed verification without creating a session", async () => {
    const query = mfaQuery({ lastStep: Math.floor(Date.now() / 30000) + 1 });
    const { routes, transaction } = setup(query);
    const code = totpCode(secret, Math.floor(Date.now() / 30000));
    const r = await routes(
      request("/auth/mfa/verify", { transactionId: id, factor: "totp", code }),
      "/auth/mfa/verify"
    );
    expect(r!.status).toBe(401);
    expect((await r!.json()).code).toBe("mfa_code_invalid");
    expect(query.mock.calls.some(([sql]) => sql.includes("attempts = attempts + 1"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into sessions"))).toBe(false);
    expect(await transaction.mock.results[0].value).toBeInstanceOf(Response);
  });
  it("atomically consumes single-use recovery codes", async () => {
    const query = mfaQuery({ recovery: true });
    const { routes } = setup(query);
    const r = await routes(
      request("/auth/mfa/verify", {
        transactionId: id,
        factor: "recovery_code",
        code: "ABCD-EFGH"
      }),
      "/auth/mfa/verify"
    );
    expect(r!.status).toBe(200);
    expect(query.mock.calls.some(([sql]) => sql.includes("used_at is null returning *"))).toBe(
      true
    );
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into cp2_recovery_codes"))).toBe(
      true
    );
  });
  it.each([{ validTransaction: false }, { suspended: true }, { attempts: 5 }])(
    "rejects unusable transactions/accounts and durable lockout %j",
    async (options) => {
      const query = mfaQuery(options);
      const { routes } = setup(query);
      const r = await routes(
        request("/auth/mfa/verify", { transactionId: id, factor: "totp", code: "123456" }),
        "/auth/mfa/verify"
      );
      expect([400, 401, 429]).toContain(r!.status);
      expect(query.mock.calls.some(([sql]) => sql.includes("insert into sessions"))).toBe(false);
    }
  );
  it("rejects invalid factor types", async () => {
    const query = mfaQuery();
    const { routes } = setup(query);
    const r = await routes(
      request("/auth/mfa/verify", { transactionId: id, factor: "sms", code: "123456" }),
      "/auth/mfa/verify"
    );
    expect(r!.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("durable refresh sessions", () => {
  const token = "r".repeat(43);
  function refreshQuery(old: Record<string, unknown>, replacement?: Record<string, unknown>) {
    return vi.fn(async (sql: string) => {
      if (sql.startsWith("select session_family_id")) return { rows: [{ session_family_id: id }] };
      if (sql.startsWith("select * from sessions")) return { rows: [old] };
      if (sql.includes("from accounts a")) return { rows: [account] };
      if (sql.includes("as encrypted_token")) return { rows: replacement ? [replacement] : [] };
      if (sql.includes("insert into sessions"))
        return { rows: [{ ...session, id: "00000000-0000-4000-8000-000000000002" }] };
      if (sql.includes("returning id, revoked_at")) return { rows: [{ id, revoked_at: now }] };
      return { rows: [] };
    });
  }
  it("rotates the access session and stores only an encrypted grace token", async () => {
    const query = refreshQuery(session);
    const { routes } = setup(query);
    const r = await routes(
      request("/auth/session/refresh", {}, `grogoni_refresh=${token}`),
      "/auth/session/refresh"
    );
    expect(r!.status).toBe(200);
    const result = await r!.json();
    expect(result.authenticated).toBe(true);
    expect(result.deviceSession.current).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(query.mock.calls.some(([sql]) => sql.includes("revocation_reason = 'rotated'"))).toBe(
      true
    );
    expect(query.mock.calls.some(([sql]) => sql.includes("record = record || $2::jsonb"))).toBe(
      true
    );
  });
  it("reuses the persisted replacement within the retry grace period", async () => {
    const query = refreshQuery(
      { ...session, revoked_at: now, revocation_reason: "rotated", rotated_at: now },
      {
        ...session,
        id: "00000000-0000-4000-8000-000000000002",
        encrypted_token: seal(token, secrets.encryption)
      }
    );
    const { routes } = setup(query);
    const r = await routes(
      request("/auth/session/refresh", {}, `grogoni_refresh=${token}`),
      "/auth/session/refresh"
    );
    expect(r!.status).toBe(200);
    expect(r!.headers.getSetCookie()[1]).toContain(token);
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into sessions"))).toBe(false);
  });
  it("revokes the family and commits the revocation on reuse after grace", async () => {
    const query = refreshQuery({
      ...session,
      revoked_at: now,
      revocation_reason: "rotated",
      rotated_at: new Date(Date.now() - 16000).toISOString()
    });
    const { routes, transaction } = setup(query);
    const r = await routes(
      request("/auth/session/refresh", {}, `grogoni_refresh=${token}`),
      "/auth/session/refresh"
    );
    expect(r!.status).toBe(401);
    expect((await r!.json()).code).toBe("auth_refresh_reuse_detected");
    expect(query.mock.calls.some(([sql]) => sql.includes("where session_family_id = $1"))).toBe(
      true
    );
    expect(query.mock.calls.some(([sql]) => sql.includes("update cp2_sessions"))).toBe(true);
    expect(await transaction.mock.results[0].value).toBeInstanceOf(Response);
  });
  it("revokes expired families and rejects logged-out credentials", async () => {
    for (const old of [
      { ...session, absolute_expires_at: new Date(Date.now() - 1000).toISOString() },
      { ...session, revoked_at: now, revocation_reason: "logout" }
    ]) {
      const query = refreshQuery(old);
      const { routes } = setup(query);
      const r = await routes(
        request("/auth/session/refresh", {}, `grogoni_refresh=${token}`),
        "/auth/session/refresh"
      );
      expect(r!.status).toBe(401);
      expect(query.mock.calls.some(([sql]) => sql.includes("insert into sessions"))).toBe(false);
    }
  });
});
