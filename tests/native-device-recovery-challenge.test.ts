import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";

const phone = "+254711223344";
function fixture(deviceSecurity = true) {
  const store = createCp2Store();
  const session = store.signupWithPhonePin({ destination: phone, pin: "3927" });
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
  { challengeId, ...challenge }: { challengeId: string; nonce: string; issuedAt: number }
) {
  return {
    credentialId,
    ...challenge,
    ...(challengeId ? { challengeId } : {}),
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
      restored.recoverPhoneAccountPinWithDevice({ sessionId: recovered.session.id, pin: "5193" })
        .account.id
    ).toBe(session.account.id);
    expect(() =>
      restored.recoverPhoneAccountPinWithDevice({ sessionId: recovered.session.id, pin: "3140" })
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
      store.recoverPhoneAccountPinWithDevice({ sessionId: recovered.session.id, pin: "5193" })
    ).toThrow(/Verify this device/u);
    const next = store.beginDeviceRecovery({ credentialId, identifier: phone });
    await expect(
      store.recoverWithDeviceCredential(assertion(credentialId, privateKey, next))
    ).rejects.toMatchObject({ code: "device_recovery_invalid" });
  });
  it("requires the challenge for an enrolled key whatever the id's case", async () => {
    const { store, credentialId, privateKey } = fixture();
    const challenge = store.beginDeviceRecovery({
      credentialId: credentialId.toUpperCase(),
      identifier: phone
    });
    const { challengeId: _challengeId, ...payload } = assertion(
      credentialId,
      privateKey,
      challenge
    );
    void _challengeId;
    await expect(
      store.recoverWithDeviceCredential({
        ...payload,
        credentialId: credentialId.toUpperCase()
      })
    ).rejects.toMatchObject({ code: "device_recovery_challenge_required" });
  });
  describe("which accounts a plain browser key can restore", () => {
    async function guest() {
      const store = createCp2Store();
      const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const created = store.continueWithDevice({
        sessionId: null,
        idempotencyKey: "plain-key-rule-idempotency-key-000000000001",
        devicePublicKeyJwk: publicKey.export({ format: "jwk" })
      });
      const restore = async () => {
        const credentialId = created.deviceRecoveryCredentialId!;
        const nonce = "plain-key-rule-nonce-0000000000000001";
        const issuedAt = Date.now();
        return store.recoverWithDeviceCredential(
          assertion(credentialId, privateKey, { challengeId: "", nonce, issuedAt })
        );
      };
      const addPasskey = () => {
        const snapshot = store.snapshot();
        snapshot.passkeys = [
          { id: "passkey", accountId: created.account.id } as (typeof snapshot.passkeys)[number]
        ];
        store.hydrateSnapshot(snapshot);
      };
      const addPhoneIdentity = () => {
        store.updateOwnerPhone({
          sessionId: created.session.id,
          phoneNumber: "+254 700 123 456",
          country: "KE"
        });
      };
      return { store, created, restore, addPasskey, addPhoneIdentity };
    }

    it("refuses a guest with a phone and only a password", async () => {
      const { store, created, restore, addPhoneIdentity } = await guest();
      addPhoneIdentity();
      store.createPassword({ sessionId: created.session.id, password: "secure first password" });
      await expect(restore()).rejects.toMatchObject({ code: "device_recovery_invalid" });
    });

    it("refuses a phone-primary account with only a passkey", async () => {
      const { store, restore, addPasskey, created } = await guest();
      const snapshot = store.snapshot();
      const account = snapshot.accounts.find((item) => item.id === created.account.id)!;
      account.primaryAuthChannel = "phone";
      store.hydrateSnapshot(snapshot);
      addPasskey();
      await expect(restore()).rejects.toMatchObject({ code: "device_recovery_invalid" });
    });

    it("keeps restoring a guest with a password but no phone to log in with", async () => {
      const { store, created, restore } = await guest();
      store.createPassword({ sessionId: created.session.id, password: "secure first password" });
      await expect(restore()).resolves.toHaveProperty("session");
    });

    it("keeps restoring a guest whose passkey cannot sign in", async () => {
      const { restore, addPasskey, addPhoneIdentity } = await guest();
      addPhoneIdentity();
      addPasskey();
      await expect(restore()).resolves.toHaveProperty("session");
    });
  });

  it("refuses a key without screen-lock enrollment for a real account", async () => {
    const { store, credentialId, privateKey } = fixture(false);
    const sessions = store.snapshot().sessions.length;
    const challenge = store.beginDeviceRecovery({ credentialId, identifier: phone });
    await expect(
      store.recoverWithDeviceCredential(assertion(credentialId, privateKey, challenge))
    ).rejects.toMatchObject({ code: "device_recovery_invalid" });
    expect(store.snapshot().sessions).toHaveLength(sessions);
  });
});
