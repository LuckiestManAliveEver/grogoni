import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import { OwnerNodeBroker } from "../services/api/src/inference/owner-node-broker";
import {
  probationAllowedWrites,
  probationAllows,
  probationRefusedReads,
  probationRefusedWrites
} from "../services/api/src/cp2/recovery-probation-routes";

const phone = "+254711000444";

/** Every `METHOD /path` the full API registers, from Fastify's route tree. */
function registeredRoutes(tree: string): string[] {
  const stack: Array<{ depth: number; path: string }> = [];
  const routes = new Set<string>();
  for (const line of tree.split("\n")) {
    const match = /^((?:│ {3}| {4})*)(?:├── |└── )(.*)$/u.exec(line);
    if (match === null) continue;
    const depth = match[1]!.length / 4;
    const node = /^(.*?)(?: \(([A-Z, ]+)\))?$/u.exec(match[2]!)!;
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
    const path = (stack[stack.length - 1]?.path ?? "") + node[1]!;
    stack.push({ depth, path });
    for (const method of node[2]?.split(", ") ?? [])
      if (method !== "HEAD") routes.add(`${method} ${path}`);
  }
  return [...routes].sort();
}

/** Fastify prints `/:a|:b` when two routes share a path with different parameter names. */
function variants(route: string): string[] {
  const [method, path] = route.split(" ") as [string, string];
  const segments = path.split("/").map((segment) => segment.split("|"));
  let paths = [""];
  for (const options of segments.slice(1))
    paths = paths.flatMap((prefix) => options.map((option) => `${prefix}/${option}`));
  return paths.map((candidate) => `${method} ${candidate}`);
}

/** Every optional route group switched on, so conditional routes are classified too. */
function fullApi(store = createCp2Store()) {
  return buildApi({
    cp2: {
      store,
      ownerNodeBroker: new OwnerNodeBroker({ signingSecret: "s".repeat(32), jobTimeoutMs: 1000 })
    }
  });
}

async function writeRoutes(): Promise<string[]> {
  const app = fullApi();
  await app.ready();
  try {
    const routes = registeredRoutes(app.printRoutes({ commonPrefix: false })).filter(
      (route) => !route.startsWith("GET ") && !route.startsWith("OPTIONS ")
    );
    // Guards the parser itself: an empty tree would make every check below pass.
    expect(routes.length).toBeGreaterThan(300);
    return routes;
  } finally {
    await app.close();
  }
}

describe("probation route classification", () => {
  it("classifies every registered write route exactly once", async () => {
    const unclassified = (await writeRoutes()).filter(
      (route) =>
        !variants(route).some(
          (variant) =>
            probationAllowedWrites.has(variant) || probationRefusedWrites[variant] !== undefined
        )
    );
    // A new write route lands here. Add it to probationAllowedWrites or probationRefusedWrites in
    // services/api/src/cp2/recovery-probation-routes.ts. Until then it is refused during probation.
    expect(unclassified).toEqual([]);
    const both = [...probationAllowedWrites].filter(
      (route) => probationRefusedWrites[route] !== undefined
    );
    expect(both).toEqual([]);
  });

  it("names no route that does not exist", async () => {
    const registered = new Set((await writeRoutes()).flatMap(variants));
    const stale = [...probationAllowedWrites, ...Object.keys(probationRefusedWrites)].filter(
      (route) => !registered.has(route)
    );
    expect(stale).toEqual([]);
  });

  it("refuses unknown writes and the side-effecting reads, and allows everything else read", () => {
    expect(probationAllows("POST", "/a/route/nobody/classified")).toBe(false);
    expect(probationAllows("GET", "/a/route/nobody/classified")).toBe(true);
    for (const route of Object.keys(probationRefusedReads)) {
      const [method, url] = route.split(" ") as [string, string];
      expect(probationAllows(method, url)).toBe(false);
    }
    expect(probationAllows("POST", "/auth/passkeys/register/verify")).toBe(true);
    expect(probationAllows("POST", "/auth/password/change")).toBe(false);
  });
});

describe("probation route guard", () => {
  async function probationFixture() {
    const store = createCp2Store();
    const owner = store.signupWithPhonePin({ destination: phone, pin: "1234" });
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const credentialId = store.continueWithDevice({
      sessionId: owner.session.id,
      idempotencyKey: null,
      devicePublicKeyJwk: keys.publicKey.export({ format: "jwk" }),
      deviceSecurity: true
    }).deviceRecoveryCredentialId!;
    const snapshot = store.snapshot();
    snapshot.deviceRecoveryCredentials!.find((key) => key.id === credentialId)!.attested = true;
    const live = createCp2Store();
    live.hydrateSnapshot(snapshot);
    const started = live.startRecoveryApproval({
      identifier: phone,
      client: "Chrome",
      clientKey: "browser"
    });
    const options = await live.beginRecoveryApproval({
      sessionId: owner.session.id,
      code: started.code,
      method: "device",
      credentialId
    });
    if (options.method !== "device") throw new Error("expected a device challenge");
    const { challenge } = options;
    await live.approveRecoveryApproval({
      sessionId: owner.session.id,
      requestId: options.requestId,
      method: "device",
      credentialId,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      signature: sign(
        "sha256",
        Buffer.from(
          `grogoni-device-recovery:v1:${credentialId}:${challenge.issuedAt}:${challenge.nonce}`
        ),
        { key: keys.privateKey, dsaEncoding: "ieee-p1363" }
      ).toString("base64url")
    });
    const browser = live.recoveryApprovalStatus(started);
    if (browser.status !== "approved") throw new Error("expected approval");
    const app = fullApi(live);
    return {
      app,
      probation: `grogoni_session=${browser.session.id}`,
      trusted: `grogoni_session=${owner.session.id}`
    };
  }

  it("refuses a probation session on refused, unclassified and side-effecting routes, across the whole API", async () => {
    const { app, probation, trusted } = await probationFixture();
    try {
      const call = (method: "GET" | "POST", url: string, cookie: string) =>
        app.inject({
          method,
          url,
          headers: { cookie, "content-type": "application/json" },
          ...(method === "POST" ? { payload: {} } : {})
        });
      for (const [method, url] of [
        ["POST", "/auth/password/change"],
        ["POST", "/businesses/00000000-0000-4000-8000-000000000000/staff/invitations"],
        ["POST", "/v1/mcp/tokens"],
        ["GET", "/auth/oauth/google/start"],
        ["GET", "/v1/inference/owner-node"]
      ] as const) {
        const refused = await call(method, url, probation);
        expect({ url, status: refused.statusCode, code: refused.json().code }).toEqual({
          url,
          status: 403,
          code: "recovery_approval_probation"
        });
        const allowed = await call(method, url, trusted);
        // A websocket route hit without an upgrade answers with an empty body.
        const code = allowed.body
          ? (JSON.parse(allowed.body) as { code?: string }).code
          : undefined;
        expect({ url, code }).not.toEqual({
          url,
          code: "recovery_approval_probation"
        });
      }
      // Ordinary reads and allowed writes still work for the recovered browser.
      const session = await call("GET", "/auth/session", probation);
      expect(session.statusCode).toBe(200);
      const passkey = await call("POST", "/auth/passkeys/register/options", probation);
      expect(passkey.json<{ code?: string }>().code).not.toBe("recovery_approval_probation");

      // A write route missing from the allowlist (a new route nobody classified) is refused.
      const allowlist = probationAllowedWrites as Set<string>;
      allowlist.delete("POST /auth/passkeys/register/options");
      try {
        const unclassified = await call("POST", "/auth/passkeys/register/options", probation);
        expect(unclassified.json<{ code?: string }>().code).toBe("recovery_approval_probation");
      } finally {
        allowlist.add("POST /auth/passkeys/register/options");
      }
    } finally {
      await app.close();
    }
  });
});
