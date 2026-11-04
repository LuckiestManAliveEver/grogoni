import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

const origin = "http://localhost:5173";
const phone = "+254712345699";
const assertion: AuthenticationResponseJSON = {
  id: "registered-passkey",
  rawId: "registered-passkey",
  type: "public-key",
  clientExtensionResults: {},
  response: {
    authenticatorData: "AQID",
    clientDataJSON: "AQID",
    signature: "AQID",
    userHandle: "user-handle"
  }
};

function fixture(userVerified = true) {
  const seed = createCp2Store();
  const original = seed.signupWithPhonePin({ destination: phone, pin: "1234" });
  const snapshot = seed.snapshot();
  snapshot.passkeys = [
    {
      id: assertion.id,
      accountId: original.account.id,
      userId: original.user.id,
      webauthnUserId: "user-handle",
      publicKey: "AQID",
      counter: 0,
      label: "Registered phone",
      deviceType: "singleDevice",
      backedUp: false,
      transports: ["internal"],
      createdAt: new Date().toISOString(),
      lastUsedAt: null
    }
  ];
  const verifier = vi.fn(async () => ({
    verified: true,
    authenticationInfo: {
      newCounter: 1,
      credentialID: assertion.id,
      credentialBackedUp: false,
      credentialDeviceType: "singleDevice" as const,
      origin,
      rpID: "localhost",
      userVerified
    }
  }));
  const store = createCp2Store({ passkeyAuthenticationVerifier: verifier });
  store.hydrateSnapshot(snapshot);
  return { store, original, verifier };
}

async function prove(
  store: ReturnType<typeof createCp2Store>,
  identifier = phone,
  now = new Date()
) {
  const challenge = await store.beginPasskeyAuthentication({
    rpId: "localhost",
    origin,
    purpose: "pin_recovery",
    recoveryIdentifier: identifier,
    now
  });
  const session = await store.completePasskeyAuthentication({
    ceremonyId: challenge.ceremonyId,
    rpId: "localhost",
    origin,
    response: assertion,
    now
  });
  return { session, challenge };
}

describe("device security passkey recovery", () => {
  it("issues account-bound single-use proof, persists it, resets PIN and revokes older sessions", async () => {
    const { store, original, verifier } = fixture();
    const { session, challenge } = await prove(store);
    expect(verifier).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: challenge.options.challenge,
        expectedOrigin: origin,
        expectedRPID: "localhost",
        requireUserVerification: true
      })
    );
    const restored = createCp2Store();
    restored.hydrateSnapshot(store.snapshot());
    expect(
      restored.recoverPhoneAccountPinWithDevice({ sessionId: session.session.id, pin: "5678" })
        .account.id
    ).toBe(original.account.id);
    expect(restored.getSession(original.session.id)).toBeNull();
    expect(() =>
      restored.recoverPasswordWithDevice({
        sessionId: session.session.id,
        password: "secure new password"
      })
    ).toThrow(/Verify this device/u);
    await expect(
      store.completePasskeyAuthentication({
        ceremonyId: challenge.ceremonyId,
        rpId: "localhost",
        origin,
        response: assertion
      })
    ).rejects.toMatchObject({ code: "passkey_ceremony_invalid" });
  });

  it("also permits a password reset without the old password", async () => {
    const { store, original } = fixture();
    const { session } = await prove(store);
    expect(
      store.recoverPasswordWithDevice({
        sessionId: session.session.id,
        password: "secure new password"
      }).account.id
    ).toBe(original.account.id);
    expect(() =>
      store.recoverPhoneAccountPinWithDevice({ sessionId: session.session.id, pin: "5678" })
    ).toThrow(/Verify this device/u);
    expect(store.getSession(original.session.id)).toBeNull();
  });

  it("does not confuse device capability, account existence, and enrollment", async () => {
    const { store } = fixture();
    const known = await store.beginPasskeyAuthentication({
      rpId: "localhost",
      purpose: "pin_recovery",
      recoveryIdentifier: phone
    });
    const unknown = await store.beginPasskeyAuthentication({
      rpId: "localhost",
      purpose: "pin_recovery",
      recoveryIdentifier: "+254799999999"
    });
    expect(known.options.allowCredentials).toEqual(unknown.options.allowCredentials);
    expect(known.options.userVerification).toBe("required");
    await expect(
      store.completePasskeyAuthentication({
        ceremonyId: unknown.ceremonyId,
        rpId: "localhost",
        origin,
        response: assertion
      })
    ).rejects.toMatchObject({ code: "passkey_account_mismatch" });
    expect(
      store.snapshot().authTransactions?.filter((t) => t.metadata.deviceRecoverySessionId)
    ).toHaveLength(0);
  });

  it("rejects a missing credential, failed user verification, wrong origin, wrong RP and expired challenges", async () => {
    for (const failure of ["missing", "verification", "origin", "rp", "expiry"] as const) {
      const { store, verifier } = fixture(failure !== "verification");
      const now = new Date();
      const challenge = await store.beginPasskeyAuthentication({
        rpId: "localhost",
        origin,
        purpose: "pin_recovery",
        recoveryIdentifier: phone,
        now
      });
      if (failure === "missing") {
        const snapshot = store.snapshot();
        snapshot.passkeys = [];
        store.hydrateSnapshot(snapshot);
      }
      await expect(
        store.completePasskeyAuthentication({
          ceremonyId: challenge.ceremonyId,
          rpId: failure === "rp" ? "attacker.example" : "localhost",
          origin: failure === "origin" ? "https://attacker.example" : origin,
          response: assertion,
          now: new Date(now.getTime() + (failure === "expiry" ? 6 * 60_000 : 0))
        })
      ).rejects.toHaveProperty("code");
      if (failure !== "verification") expect(verifier).not.toHaveBeenCalled();
      expect(
        store.snapshot().authTransactions?.filter((t) => t.metadata.deviceRecoverySessionId)
      ).toHaveLength(0);
    }
  });

  it("enforces origin and request throttling on recovery ceremonies", async () => {
    const { store } = fixture();
    const app = buildApi({ cp2: { store } });
    try {
      const denied = await app.inject({
        method: "POST",
        url: "/auth/passkeys/login/options",
        headers: { origin: "https://attacker.example" },
        payload: { purpose: "pin_recovery", identifier: phone }
      });
      expect(denied.statusCode).toBe(403);
      for (let index = 0; index < 10; index++) {
        const result = await app.inject({
          method: "POST",
          url: "/auth/passkeys/login/options",
          headers: { origin },
          payload: { purpose: "pin_recovery", identifier: phone }
        });
        expect(result.statusCode).toBe(200);
      }
      const limited = await app.inject({
        method: "POST",
        url: "/auth/passkeys/login/options",
        headers: { origin },
        payload: { purpose: "pin_recovery", identifier: phone }
      });
      expect(limited.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
  it("revokes an outstanding passkey recovery grant when that credential is removed", async () => {
    const { store, original } = fixture();
    const { session } = await prove(store);
    store.revokePasskey({ sessionId: original.session.id, credentialId: assertion.id });
    expect(() =>
      store.recoverPhoneAccountPinWithDevice({ sessionId: session.session.id, pin: "5678" })
    ).toThrow(/Verify this device/u);
  });

  it("expires a first-PIN setup grant and consumes it when setup succeeds", async () => {
    for (const expired of [false, true]) {
      const { store } = fixture();
      const snapshot = store.snapshot();
      snapshot.accountPinHashes = [];
      store.hydrateSnapshot(snapshot);
      const now = new Date();
      const { session } = await prove(store, phone, now);
      if (expired) {
        expect(() =>
          store.setAccountPin({
            sessionId: session.session.id,
            pin: "5678",
            now: new Date(now.getTime() + 6 * 60_000)
          })
        ).toThrow(/Verify this device/u);
      } else {
        store.setAccountPin({ sessionId: session.session.id, pin: "5678", now });
        expect(() =>
          store.recoverPasswordWithDevice({
            sessionId: session.session.id,
            password: "secure new password",
            now
          })
        ).toThrow(/Verify this device/u);
      }
    }
  });

  it("notifies the owner and keeps a successful reset successful when email delivery fails", async () => {
    const { store, original } = fixture();
    store.createBusiness({
      sessionId: original.session.id,
      name: "Recovery test shop",
      language: "en"
    });
    const snapshot = store.snapshot();
    snapshot.accountIdentities = [
      ...(snapshot.accountIdentities ?? []),
      {
        id: "verified-email",
        accountId: original.account.id,
        userId: original.user.id,
        type: "email",
        normalizedValue: "owner@example.test",
        displayValue: "owner@example.test",
        isPrimary: false,
        verifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];
    store.hydrateSnapshot(snapshot);
    const { session } = await prove(store);
    const sendRecoveryNotification = vi.fn(async () => "failed" as const);
    const app = buildApi({
      cp2: {
        store,
        emailProvider: {
          name: "test",
          exposesDevOtp: false,
          sendOtp: async () => {},
          sendEncryptedMessageNotification: async () => "sent",
          sendRecoveryNotification
        }
      }
    });
    try {
      const result = await app.inject({
        method: "POST",
        url: "/auth/pin/recover/device",
        headers: { cookie: `grogoni_session=${session.session.id}` },
        payload: { pin: "5678" }
      });
      expect(result.statusCode).toBe(200);
      expect(sendRecoveryNotification).toHaveBeenCalledWith({
        to: "owner@example.test",
        sessionId: session.session.id,
        credential: "PIN"
      });
      expect(store.snapshot().notifications).toContainEqual(
        expect.objectContaining({ type: "security_event", title: "Account PIN recovered" })
      );
    } finally {
      await app.close();
    }
  });
  it("verifies real WebAuthn signatures and rejects tampered or unverified assertions", async () => {
    for (const failure of ["none", "signature", "challenge", "origin", "uv"] as const) {
      const seed = createCp2Store();
      const original = seed.signupWithPhonePin({ destination: phone, pin: "1234" });
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jwk = publicKey.export({ format: "jwk" });
      const cose = Buffer.concat([
        Buffer.from("a5010203262001215820", "hex"),
        Buffer.from(jwk.x!, "base64url"),
        Buffer.from("225820", "hex"),
        Buffer.from(jwk.y!, "base64url")
      ]);
      const id = Buffer.from("real-recovery-credential").toString("base64url");
      const userHandle = Buffer.from(original.account.id).toString("base64url");
      const snapshot = seed.snapshot();
      snapshot.passkeys = [
        {
          id,
          accountId: original.account.id,
          userId: original.user.id,
          webauthnUserId: userHandle,
          publicKey: cose.toString("base64url"),
          counter: 0,
          label: "Test device",
          deviceType: "singleDevice",
          backedUp: false,
          transports: ["internal"],
          createdAt: new Date().toISOString(),
          lastUsedAt: null
        }
      ];
      const store = createCp2Store();
      store.hydrateSnapshot(snapshot);
      const challenge = await store.beginPasskeyAuthentication({
        rpId: "localhost",
        origin,
        purpose: "pin_recovery",
        recoveryIdentifier: phone
      });
      const clientData = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: failure === "challenge" ? "wrong-challenge" : challenge.options.challenge,
          origin: failure === "origin" ? "https://attacker.example" : origin
        })
      );
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(1);
      const authData = Buffer.concat([
        createHash("sha256").update("localhost").digest(),
        Buffer.from([failure === "uv" ? 1 : 5]),
        counter
      ]);
      const signature = sign(
        "sha256",
        Buffer.concat([authData, createHash("sha256").update(clientData).digest()]),
        privateKey
      );
      const response: AuthenticationResponseJSON = {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          authenticatorData: authData.toString("base64url"),
          clientDataJSON: clientData.toString("base64url"),
          signature: (failure === "signature"
            ? Buffer.alloc(signature.length)
            : signature
          ).toString("base64url"),
          userHandle
        }
      };
      const result = store.completePasskeyAuthentication({
        ceremonyId: challenge.ceremonyId,
        origin,
        rpId: "localhost",
        response
      });
      if (failure === "none") {
        const session = await result;
        expect(
          store.recoverPhoneAccountPinWithDevice({ sessionId: session.session.id, pin: "5678" })
            .account.id
        ).toBe(original.account.id);
      } else await expect(result).rejects.toMatchObject({ code: "passkey_authentication_invalid" });
    }
  });
  it("does not honor legacy grants that predate user-verified recovery enrollment", async () => {
    const { store } = fixture();
    const { session } = await prove(store);
    const snapshot = store.snapshot();
    for (const transaction of snapshot.authTransactions ?? [])
      delete transaction.metadata.recoveryCredentialId;
    store.hydrateSnapshot(snapshot);
    expect(() =>
      store.recoverPhoneAccountPinWithDevice({ sessionId: session.session.id, pin: "5678" })
    ).toThrow(/Verify this device/u);
  });
});
