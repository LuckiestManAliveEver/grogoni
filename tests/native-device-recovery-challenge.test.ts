import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";

const phone = "+254711223344";
function fixture(deviceSecurity = true) {
  const store = createCp2Store();
  const session = store.signupWithPhonePin({ destination: phone, pin: "1234" });
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const enrollment = store.continueWithDevice({
    sessionId: session.session.id,
    idempotencyKey: null,
    devicePublicKeyJwk: publicKey.export({ format: "jwk" }),
    deviceSecurity
  });
  const credentialId = enrollment.deviceRecoveryCredentialId!;
  return { store, session, credentialId, privateKey };
}
function assertion(
  credentialId: string,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  challenge: { challengeId: string; nonce: string; issuedAt: number }
) {
  return {
    credentialId,
    ...challenge,
    signature: sign(
      "sha256",
      Buffer.from(
        `grogoni-device-recovery:v1:${credentialId}:${challenge.issuedAt}:${challenge.nonce}`
      ),
      { key: privateKey, dsaEncoding: "ieee-p1363" }
    ).toString("base64url")
  };
}

describe("native device recovery challenges", () => {
  it("accepts an enrolled signing key once, persists proof and allows one PIN reset", async () => {
    const { store, session, credentialId, privateKey } = fixture();
    const challenge = store.beginDeviceRecovery({ credentialId, identifier: phone });
    const payload = assertion(credentialId, privateKey, challenge);
    const { challengeId: _challengeId, ...withoutChallenge } = payload;
    void _challengeId;
    await expect(store.recoverWithDeviceCredential(withoutChallenge)).rejects.toMatchObject({
      code: "device_recovery_challenge_required"
    });
    const restored = createCp2Store();
    restored.hydrateSnapshot(store.snapshot());
    const recovered = await restored.recoverWithDeviceCredential(payload);
    await expect(restored.recoverWithDeviceCredential(payload)).rejects.toMatchObject({
      code: "auth_transaction_invalid"
    });
    expect(
      restored.recoverPhoneAccountPinWithDevice({ sessionId: recovered.session.id, pin: "5678" })
        .account.id
    ).toBe(session.account.id);
    expect(() =>
      restored.recoverPhoneAccountPinWithDevice({ sessionId: recovered.session.id, pin: "6789" })
    ).toThrow(/Verify this device/u);
  });

  it("rejects expired challenges, account mismatches, altered nonces and invalid signatures", async () => {
    for (const failure of ["expiry", "account", "nonce", "signature"] as const) {
      const { store, credentialId, privateKey } = fixture();
      const now = new Date();
      const challenge = store.beginDeviceRecovery({
        credentialId,
        identifier: failure === "account" ? "+254799999999" : phone,
        now
      });
      const payload = assertion(credentialId, privateKey, challenge);
      if (failure === "nonce") payload.nonce = "A".repeat(32);
      if (failure === "signature") payload.signature = "A".repeat(86);
      await expect(
        store.recoverWithDeviceCredential({
          ...payload,
          now: new Date(now.getTime() + (failure === "expiry" ? 3 * 60_000 : 0))
        })
      ).rejects.toHaveProperty("code");
      expect(
        store
          .snapshot()
          .authTransactions?.filter((transaction) => transaction.metadata.deviceRecoverySessionId)
      ).toHaveLength(0);
    }
  });

  it("supports multiple devices and revokes credentials and outstanding grants account-safely", async () => {
    const { store, session, credentialId, privateKey } = fixture();
    const second = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    store.continueWithDevice({
      sessionId: session.session.id,
      idempotencyKey: null,
      devicePublicKeyJwk: second.publicKey.export({ format: "jwk" })
    });
    expect(store.listDeviceRecoveryCredentials({ sessionId: session.session.id })).toHaveLength(2);
    const challenge = store.beginDeviceRecovery({ credentialId, identifier: phone });
    const recovered = await store.recoverWithDeviceCredential(
      assertion(credentialId, privateKey, challenge)
    );
    store.revokeDeviceRecoveryCredential({ sessionId: session.session.id, credentialId });
    expect(store.listDeviceRecoveryCredentials({ sessionId: session.session.id })).toHaveLength(1);
    expect(() =>
      store.recoverPhoneAccountPinWithDevice({ sessionId: recovered.session.id, pin: "5678" })
    ).toThrow(/Verify this device/u);
    const next = store.beginDeviceRecovery({ credentialId, identifier: phone });
    await expect(
      store.recoverWithDeviceCredential(assertion(credentialId, privateKey, next))
    ).rejects.toMatchObject({ code: "device_recovery_invalid" });
  });
  it("keeps legacy recovery keys usable for session restoration without authorizing credential resets", async () => {
    const { store, credentialId, privateKey } = fixture(false);
    const challenge = store.beginDeviceRecovery({ credentialId, identifier: phone });
    const restored = await store.recoverWithDeviceCredential(
      assertion(credentialId, privateKey, challenge)
    );
    expect(store.getSession(restored.session.id)).not.toBeNull();
    const snapshot = store.snapshot();
    snapshot.accountPinHashes = [];
    store.hydrateSnapshot(snapshot);
    expect(() => store.setAccountPin({ sessionId: restored.session.id, pin: "5678" })).toThrow(
      /Sign in/u
    );

    expect(() =>
      store.recoverPhoneAccountPinWithDevice({ sessionId: restored.session.id, pin: "5678" })
    ).toThrow(/Verify this device/u);
    await expect(
      store.beginPasskeyRegistration({ sessionId: restored.session.id, rpId: "localhost" })
    ).rejects.toHaveProperty("code");
  });
});
