import { createRequire } from "node:module";
import { randomInt, randomUUID, createHmac } from "node:crypto";
import { URL } from "node:url";
import { Agent, request as httpsRequest } from "node:https";
import { resolve4 } from "node:dns/promises";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { databasePoolConfig } from "../services/api/scripts/database-connection.mjs";
import { seal, totpCode } from "../supabase/functions/api/credentials.ts";

if (!process.argv.includes("--live"))
  throw new Error("Pass --live to run disposable auth fixtures.");
const require = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool(databasePoolConfig(process.env.DATABASE_URL, { max: 1 }));
const base =
  process.env.SMOKE_API_URL ?? "https://gnmndzsughifhboqvsgd.supabase.co/functions/v1/api";
// Use DNS queries directly when the host environment's OS resolver caches a negative answer.
// HTTPS still verifies the original hostname and certificate normally.
const agent = new Agent({
  keepAlive: true,
  lookup(hostname, options, callback) {
    resolve4(hostname).then((addresses) => {
      if (options.all)
        callback(
          null,
          addresses.map((address) => ({ address, family: 4 }))
        );
      else callback(null, addresses[0], 4);
    }, callback);
  }
});
const fixturePhone = randomInt(0, 999);
const phones = Array.from(
  { length: 2 },
  (_, offset) => `+442079460${String(fixturePhone + offset).padStart(3, "0")}`
);
const fixtureEmail = `edge-auth-${randomUUID()}@example.invalid`;
const fixtureDevice = `edge-auth-${randomUUID()}`;
const accountIds = new Set();
const transactionIds = new Set();
const password = `Disposable-${randomUUID()}`;
const correlation = (value) =>
  createHmac("sha256", process.env.AUTH_AUDIT_HMAC_SECRET).update(value).digest("hex");
const rateKeys = new Set(phones.map((phone) => correlation(`phone:${phone}`)));
function cookies(response) {
  return response.headers
    .getSetCookie()
    .filter((value) => /^grogoni_(session|refresh)=/.test(value))
    .map((value) => value.split(";")[0])
    .join("; ");
}
async function call(path, method = "POST", data = {}, cookie = "") {
  const response = await new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      base + path,
      {
        agent,
        method,
        headers: {
          origin: "https://grogoni.com",
          "x-region": process.env.SMOKE_FUNCTION_REGION ?? "us-east-1",
          "content-type": "application/json",
          cookie,
          "x-grogoni-device-id": fixtureDevice,
          "x-grogoni-device-name": "Disposable test"
        },
        signal: globalThis.AbortSignal.timeout(30000)
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("error", reject);
        incoming.on("end", () => {
          const headers = new globalThis.Headers();
          for (let i = 0; i < incoming.rawHeaders.length; i += 2)
            headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
          resolve(
            new globalThis.Response(Buffer.concat(chunks), { status: incoming.statusCode, headers })
          );
        });
      }
    );
    outgoing.on("error", reject);
    outgoing.end(method === "POST" ? JSON.stringify(data) : undefined);
  });
  const result = await response.json();
  // Avoid displaying credentials, cookies, or account identifiers on failure.
  return { response, result };
}
function status(result, expected, label) {
  assert.equal(
    result.response.status,
    expected,
    `${label}: HTTP ${result.response.status}, ${result.result.code ?? "unexpected response"}`
  );
}
function capture(result) {
  if (result.result.account?.id) {
    accountIds.add(result.result.account.id);
    rateKeys.add(correlation(`account:${result.result.account.id}`));
  }
  return cookies(result.response);
}
try {
  const used = await pool.query(
    "select id from accounts where primary_auth_destination = any($1::text[])",
    [phones]
  );
  assert.equal(
    used.rows.length,
    0,
    "Fixture phone is already in use; rerun to generate a new one."
  );
  const methods = await call("/auth/login/methods", "POST", {
    type: "phone",
    identifier: phones[0]
  });
  status(methods, 200, "Login methods");
  assert.equal(methods.result.preferred, "pin");
  assert.equal(methods.result.passkeyAvailable, process.env.SMOKE_EXPECT_PASSKEYS !== "false");
  console.log("PASS login method discovery");

  const started = await call("/auth/signup/start", "POST", {
    type: "phone",
    identifier: phones[0]
  });
  status(started, 200, "Signup start");
  transactionIds.add(started.result.transactionId);
  const signupBody = {
    transactionId: started.result.transactionId,
    displayName: "Disposable auth test",
    password,
    passwordConfirmation: password,
    email: fixtureEmail,
    termsAccepted: true,
    privacyAccepted: true
  };
  const signup = await call("/auth/signup/complete", "POST", signupBody);
  status(signup, 200, "Signup complete");
  const signupCookie = capture(signup);
  status(await call("/auth/signup/complete", "POST", signupBody), 400, "Consumed signup rejected");
  const bootstrap = await call("/auth/bootstrap", "GET", {}, signupCookie);
  status(bootstrap, 200, "Bootstrap");
  assert.equal(bootstrap.result.authenticated, true);
  assert.equal(bootstrap.result.user.phoneNumberE164, phones[0]);
  console.log("PASS atomic password signup, transaction consumption, and bootstrap");

  status(
    await call("/auth/pin/setup", "POST", { pin: "1234", pinConfirmation: "1234" }, signupCookie),
    200,
    "PIN setup"
  );
  status(
    await call("/auth/pin/setup", "POST", { pin: "4321" }, signupCookie),
    409,
    "Duplicate PIN setup"
  );
  const credentials = await call("/auth/credentials/status", "GET", {}, signupCookie);
  status(credentials, 200, "Credential status");
  assert.equal(credentials.result.hasPin, true);
  assert.equal(credentials.result.hasPassword, true);
  console.log("PASS PIN setup and credential status");

  status(
    await call("/auth/login/password", "POST", {
      type: "phone",
      identifier: phones[0],
      password: "incorrect-password"
    }),
    401,
    "Wrong password"
  );
  const passwordLogin = await call("/auth/login/password", "POST", {
    type: "phone",
    identifier: phones[0],
    password
  });
  status(passwordLogin, 200, "Password login");
  capture(passwordLogin);

  const factorId = randomUUID();
  const mfaSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const accountId = signup.result.account.id;
  await pool.query(
    `insert into mfa_factors (id, account_id, factor_type, secret_encrypted, verified_at, created_at)
    values ($1, $2, 'totp', $3, now(), now())`,
    [factorId, accountId, seal(mfaSecret, process.env.AUTH_TOKEN_ENCRYPTION_KEY)]
  );
  async function challenge() {
    const r = await call("/auth/login/password", "POST", {
      type: "phone",
      identifier: phones[0],
      password
    });
    status(r, 200, "MFA password challenge");
    assert.equal(r.result.mfaRequired, true);
    assert.equal(cookies(r.response), "", "Password-only MFA login must not issue cookies.");
    transactionIds.add(r.result.transactionId);
    return r.result.transactionId;
  }
  const challengeId = await challenge();
  status(
    await call("/auth/mfa/challenge", "POST", { transactionId: challengeId }),
    200,
    "MFA discovery"
  );
  status(
    await call("/auth/mfa/verify", "POST", {
      transactionId: challengeId,
      factor: "totp",
      code: "invalid"
    }),
    401,
    "Invalid MFA code"
  );
  const attempt = (
    await pool.query("select attempts from auth_transactions where id = $1", [challengeId])
  ).rows[0];
  assert.equal(attempt.attempts, 1, "Failed MFA attempts must persist.");
  const mfaData = {
    transactionId: challengeId,
    factor: "totp",
    code: totpCode(mfaSecret, Math.floor(Date.now() / 30000))
  };
  const results = await Promise.all([
    call("/auth/mfa/verify", "POST", mfaData),
    call("/auth/mfa/verify", "POST", mfaData)
  ]);
  assert.deepEqual(
    results.map((r) => r.response.status).sort(),
    [200, 400],
    "MFA transactions must be single-use under concurrency."
  );
  for (const result of results) if (result.response.status === 200) capture(result);
  const step = Number(
    (await pool.query("select last_used_step from mfa_factors where id = $1", [factorId])).rows[0]
      .last_used_step
  );
  const nextChallenge = await challenge();
  status(
    await call("/auth/mfa/verify", "POST", {
      transactionId: nextChallenge,
      factor: "totp",
      code: totpCode(mfaSecret, step)
    }),
    401,
    "TOTP replay rejection"
  );
  const recoveryId = randomUUID();
  const recoveryCode = "ABCD-1234";
  const codeHash = createHmac("sha256", process.env.PASSWORD_HASH_SECRET)
    .update(`${accountId}:${recoveryCode}`)
    .digest("hex");
  await pool.query(
    "insert into recovery_codes (id, account_id, code_hash, created_at) values ($1,$2,$3,now())",
    [recoveryId, accountId, codeHash]
  );
  const recovered = await call("/auth/mfa/verify", "POST", {
    transactionId: nextChallenge,
    factor: "recovery_code",
    code: recoveryCode
  });
  status(recovered, 200, "Recovery code verification");
  capture(recovered);
  const recoveryReuse = await challenge();
  status(
    await call("/auth/mfa/verify", "POST", {
      transactionId: recoveryReuse,
      factor: "recovery_code",
      code: recoveryCode
    }),
    401,
    "Recovery code reuse rejected"
  );
  const mirror = await pool.query("select record from cp2_recovery_codes where entity_id = $1", [
    recoveryId
  ]);
  assert.ok(mirror.rows[0].record.usedAt);
  rateKeys.add(correlation(`mfa:${accountId}`));
  console.log(
    "PASS MFA challenge, failed attempts, concurrent consumption, TOTP replay, and recovery codes"
  );

  const pinLogin = await call("/auth/pin/login", "POST", {
    method: "phone",
    contact: phones[0],
    pin: "1234"
  });
  status(pinLogin, 200, "PIN login");
  const loginCookie = capture(pinLogin);
  console.log("PASS password and PIN login");

  const [first, retry] = await Promise.all([
    call("/auth/session/refresh", "POST", {}, loginCookie),
    call("/auth/session/refresh", "POST", {}, loginCookie)
  ]);
  status(first, 200, "Concurrent refresh");
  status(retry, 200, "Concurrent refresh retry");
  assert.equal(
    first.result.session.id,
    retry.result.session.id,
    "Concurrent refresh must share one replacement."
  );
  const refreshedCookie = capture(first);
  assert.equal(refreshedCookie, capture(retry));
  status(await call("/session", "GET", {}, loginCookie), 401, "Old access session revoked");
  status(await call("/session", "GET", {}, refreshedCookie), 200, "Replacement access session");
  const oldId = pinLogin.result.session.id;
  await pool.query(
    "update sessions set rotated_at = now() - interval '16 seconds' where id = $1 and account_id = $2",
    [oldId, signup.result.account.id]
  );
  const replay = await call("/auth/session/refresh", "POST", {}, loginCookie);
  status(replay, 401, "Refresh reuse");
  assert.equal(replay.result.code, "auth_refresh_reuse_detected");
  status(await call("/session", "GET", {}, refreshedCookie), 401, "Family revoked after reuse");
  console.log("PASS concurrent refresh grace, rotation, and reuse detection");

  for (let i = 0; i < 5; i++)
    status(
      await call("/auth/pin/login", "POST", { method: "phone", contact: phones[0], pin: "9999" }),
      401,
      "Wrong PIN"
    );
  status(
    await call("/auth/pin/login", "POST", { method: "phone", contact: phones[0], pin: "1234" }),
    429,
    "Durable lockout"
  );
  console.log("PASS failed-attempt persistence and account lockout");

  const pinSignup = await call("/auth/pin/signup", "POST", {
    method: "phone",
    contact: phones[1],
    pin: "2345"
  });
  status(pinSignup, 200, "PIN signup");
  const pinSignupCookie = capture(pinSignup);
  const logout = await call("/auth/logout", "POST", {}, pinSignupCookie);
  status(logout, 200, "Logout");
  assert.equal(logout.result.revoked, true);
  status(
    await call("/auth/session/refresh", "POST", {}, pinSignupCookie),
    401,
    "Logged-out refresh rejected"
  );
  console.log("PASS PIN signup and logout");

  const counts = await pool.query(
    `select (select count(*) from sessions where account_id = any($1::uuid[]))::int as relational,
    (select count(*) from cp2_sessions where account_id = any($1::text[]))::int as compatibility`,
    [[...accountIds]]
  );
  assert.equal(counts.rows[0].relational, counts.rows[0].compatibility);
  const stale = await pool.query(
    `select s.id from sessions s join cp2_sessions c on c.entity_id = s.id::text
    where s.account_id = any($1::uuid[]) and s.revoked_at is not null and c.record->>'revokedAt' is null`,
    [[...accountIds]]
  );
  assert.equal(stale.rows.length, 0);
  console.log("PASS relational and compatibility session parity");
} finally {
  try {
    await cleanup();
  } finally {
    agent.destroy();
  }
}
async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Recover IDs even if an HTTP response was lost after the transaction committed.
    const recovered = await client.query(
      `select a.id from accounts a
      where a.primary_auth_destination = any($1::text[]) and exists
        (select 1 from sessions s where s.account_id = a.id and s.device_id = $2)`,
      [phones, fixtureDevice]
    );
    for (const row of recovered.rows) {
      accountIds.add(row.id);
      rateKeys.add(correlation(`account:${row.id}`));
    }
    const ids = [...accountIds];
    await client.query(
      "delete from auth_audit_events where account_id = any($1::uuid[]) or metadata->>'rateKey' = any($2::text[])",
      [ids, [...rateKeys]]
    );
    for (const table of [
      "cp2_sessions",
      "cp2_account_identities",
      "cp2_account_pin_hashes",
      "cp2_password_credentials",
      "cp2_mfa_factors",
      "cp2_recovery_codes",
      "cp2_users",
      "cp2_accounts"
    ]) {
      await client.query(`delete from ${table} where account_id = any($1::text[])`, [ids]);
    }
    await client.query(
      "delete from cp2_auth_transactions where account_id = any($1::text[]) or entity_id = any($2::text[])",
      [ids, [...transactionIds]]
    );
    await client.query(
      "delete from auth_transactions where account_id = any($1::uuid[]) or id = any($2::uuid[])",
      [ids, [...transactionIds]]
    );
    await client.query("delete from sessions where account_id = any($1::uuid[])", [ids]);
    await client.query("delete from account_identities where account_id = any($1::uuid[])", [ids]);
    await client.query("delete from password_credentials where account_id = any($1::uuid[])", [
      ids
    ]);
    await client.query("delete from account_pin_hashes where account_id = any($1::uuid[])", [ids]);
    await client.query("delete from mfa_factors where account_id = any($1::uuid[])", [ids]);
    await client.query("delete from recovery_codes where account_id = any($1::uuid[])", [ids]);
    await client.query("delete from users where account_id = any($1::uuid[])", [ids]);
    await client.query("delete from accounts where id = any($1::uuid[])", [ids]);
    await client.query("commit");
    const left = await client.query("select id from accounts where id = any($1::uuid[])", [ids]);
    assert.equal(left.rows.length, 0);
    console.log("PASS disposable authentication fixtures removed");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
