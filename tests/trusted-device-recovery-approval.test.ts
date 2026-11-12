import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { buildApi } from "../services/api/src/app";
import { createCp2Store, type Cp2Snapshot } from "../services/api/src/cp2/store";
import {
  approvalHashMatches,
  describeApprovalClient,
  hashApprovalValue,
  normalizeApprovalCode
} from "../services/api/src/cp2/domains/recovery-approval/shared";
import {
  createEdgeSnapshotScope,
  recoveryApprovalLockKey,
  recoveryApprovalTransactionScope
} from "../services/api/src/cp2/edge-snapshot-scope";

const phone = "+254711000222";
const otherPhone = "+254711000333";
const origin = "http://localhost:5173";
type Store = ReturnType<typeof createCp2Store>;
type KeyPair = ReturnType<typeof generateKeyPairSync>;

const passkeyAssertion: AuthenticationResponseJSON = {
  id: "owner-passkey",
  rawId: "owner-passkey",
  type: "public-key",
  clientExtensionResults: {},
  response: {
    authenticatorData: "AQID",
    clientDataJSON: "AQID",
    signature: "AQID",
    userHandle: "owner-handle"
  }
};

function passkeyVerifier(userVerified = true) {
  return vi.fn(async () => ({
    verified: true,
    authenticationInfo: {
      newCounter: 7,
      credentialID: passkeyAssertion.id,
      credentialBackedUp: false,
      credentialDeviceType: "singleDevice" as const,
      origin,
      rpID: "localhost",
      userVerified
    }
  }));
}

/** Each call is one request against state persisted by the previous one, as on Edge. */
function requestScope(snapshot: Cp2Snapshot, verifier = passkeyVerifier()): Store {
  const store = createCp2Store({ passkeyAuthenticationVerifier: verifier });
  store.hydrateSnapshot(structuredClone(snapshot));
  return store;
}

/** A phone account signed in on an Android phone that has device security turned on. */
function trustedAndroidOwner(destination = phone, deviceSecurity = true, attested = true) {
  const store = createCp2Store();
  const owner = store.signupWithPhonePin({ destination, pin: "1234" });
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const enrolled = store.continueWithDevice({
    sessionId: owner.session.id,
    idempotencyKey: null,
    devicePublicKeyJwk: keys.publicKey.export({ format: "jwk" }),
    deviceSecurity
  });
  const snapshot = store.snapshot();
  // Android Key Attestation is verified at enrollment (android-key-attestation.ts). A test key
  // has no Google chain, so the fixture records the verdict the server would have reached.
  const credential = snapshot.deviceRecoveryCredentials?.find(
    (candidate) => candidate.id === enrolled.deviceRecoveryCredentialId
  );
  if (credential !== undefined) credential.attested = attested;
  return {
    snapshot,
    owner,
    credentialId: enrolled.deviceRecoveryCredentialId!,
    privateKey: keys.privateKey
  };
}

/** The same signature the Android app makes after the screen-lock prompt (DeviceRecoveryKey.kt). */
function androidSignature(
  credentialId: string,
  privateKey: KeyPair["privateKey"],
  challenge: { nonce: string; issuedAt: number }
): string {
  return sign(
    "sha256",
    Buffer.from(
      `grogoni-device-recovery:v1:${credentialId}:${challenge.issuedAt}:${challenge.nonce}`
    ),
    { key: privateKey, dsaEncoding: "ieee-p1363" }
  ).toString("base64url");
}

async function approveOnAndroid(
  snapshot: Cp2Snapshot,
  input: {
    sessionId: string;
    code: string;
    credentialId: string;
    privateKey: KeyPair["privateKey"];
  }
) {
  const options = requestScope(snapshot);
  const challenge = await options.beginRecoveryApproval({
    sessionId: input.sessionId,
    code: input.code,
    method: "device",
    credentialId: input.credentialId
  });
  if (challenge.method !== "device") throw new Error("expected a device challenge");
  const afterOptions = options.snapshot();
  const approve = requestScope(afterOptions);
  await approve.approveRecoveryApproval({
    sessionId: input.sessionId,
    requestId: challenge.requestId,
    method: "device",
    credentialId: input.credentialId,
    challengeId: challenge.challenge.challengeId,
    nonce: challenge.challenge.nonce,
    issuedAt: challenge.challenge.issuedAt,
    signature: androidSignature(input.credentialId, input.privateKey, challenge.challenge)
  });
  return approve.snapshot();
}

function start(snapshot: Cp2Snapshot, identifier = phone, client = "Chrome on Android") {
  const store = requestScope(snapshot);
  const started = store.startRecoveryApproval({ clientKey: "client-a", identifier, client });
  return { started, snapshot: store.snapshot() };
}

describe("trusted-device recovery approval", () => {
  it("lets a locked-out browser in after the Android phone approves with its screen lock", async () => {
    const owner = trustedAndroidOwner();
    const { started, snapshot: afterStart } = start(owner.snapshot);
    expect(started.code).toMatch(/^\d{6}$/u);
    expect(started.pollSecret.length).toBeGreaterThanOrEqual(43);

    expect(requestScope(afterStart).recoveryApprovalStatus(started)).toMatchObject({
      status: "pending"
    });
    const pending = requestScope(afterStart).pendingRecoveryApprovals({
      sessionId: owner.owner.session.id
    });
    expect(pending.phone).toBe(phone);
    expect(pending.requests).toEqual([
      expect.objectContaining({ requestId: started.transactionId, client: "Chrome on Android" })
    ]);
    expect(JSON.stringify(pending)).not.toContain(started.code);

    const approved = await approveOnAndroid(afterStart, {
      sessionId: owner.owner.session.id,
      code: started.code,
      credentialId: owner.credentialId,
      privateKey: owner.privateKey
    });

    const collect = requestScope(approved);
    const browser = collect.recoveryApprovalStatus(started);
    if (browser.status !== "approved") throw new Error(`expected approval, got ${browser.status}`);
    expect(browser.account.id).toBe(owner.owner.account.id);
    expect(browser.session.id).not.toBe(owner.owner.session.id);
    const afterCollect = collect.snapshot();

    // One approval, one session: polling again never mints a second one.
    expect(requestScope(afterCollect).recoveryApprovalStatus(started)).toEqual({
      status: "expired"
    });

    // The new browser session may create its own passkey straight away.
    const enroll = requestScope(afterCollect);
    await expect(
      enroll.beginPasskeyRegistration({ sessionId: browser.session.id, rpId: "localhost", origin })
    ).resolves.toMatchObject({ ceremonyId: expect.any(String) });

    // And it holds exactly one credential reset.
    const reset = requestScope(afterCollect);
    expect(
      reset.recoverPhoneAccountPinWithDevice({ sessionId: browser.session.id, pin: "5678" }).account
        .id
    ).toBe(owner.owner.account.id);
    expect(() =>
      reset.recoverPhoneAccountPinWithDevice({ sessionId: browser.session.id, pin: "6789" })
    ).toThrow(/Verify this device/u);
  });

  it("approves with a user-verified passkey on a signed-in browser", async () => {
    const seed = createCp2Store();
    const owner = seed.signupWithPhonePin({ destination: phone, pin: "1234" });
    const snapshot = seed.snapshot();
    snapshot.passkeys = [
      {
        id: passkeyAssertion.id,
        accountId: owner.account.id,
        userId: owner.user.id,
        webauthnUserId: "owner-handle",
        publicKey: "AQID",
        counter: 0,
        label: "Laptop",
        deviceType: "singleDevice",
        backedUp: false,
        transports: ["internal"],
        createdAt: new Date().toISOString(),
        lastUsedAt: null
      }
    ];
    const { started, snapshot: afterStart } = start(snapshot);
    const options = requestScope(afterStart);
    const challenge = await options.beginRecoveryApproval({
      sessionId: owner.session.id,
      code: started.code,
      method: "passkey",
      rpId: "localhost",
      origin
    });
    if (challenge.method !== "passkey") throw new Error("expected a passkey challenge");
    expect(challenge.options).toMatchObject({
      userVerification: "required",
      allowCredentials: [expect.objectContaining({ id: passkeyAssertion.id })]
    });
    const afterOptions = options.snapshot();

    // The approval ceremony can never be used to log in.
    await expect(
      requestScope(afterOptions).completePasskeyAuthentication({
        ceremonyId: challenge.ceremonyId,
        rpId: "localhost",
        origin,
        response: passkeyAssertion
      })
    ).rejects.toMatchObject({ code: "passkey_ceremony_invalid" });

    const approve = requestScope(afterOptions);
    await approve.approveRecoveryApproval({
      sessionId: owner.session.id,
      requestId: challenge.requestId,
      method: "passkey",
      ceremonyId: challenge.ceremonyId,
      response: passkeyAssertion,
      rpId: "localhost",
      origin
    });
    const browser = requestScope(approve.snapshot()).recoveryApprovalStatus(started);
    expect(browser).toMatchObject({ status: "approved", account: { id: owner.account.id } });
  });

  it("refuses a passkey assertion without user verification", async () => {
    const seed = createCp2Store();
    const owner = seed.signupWithPhonePin({ destination: phone, pin: "1234" });
    const snapshot = seed.snapshot();
    snapshot.passkeys = [
      {
        id: passkeyAssertion.id,
        accountId: owner.account.id,
        userId: owner.user.id,
        webauthnUserId: "owner-handle",
        publicKey: "AQID",
        counter: 0,
        label: "Laptop",
        deviceType: "singleDevice",
        backedUp: false,
        transports: ["internal"],
        createdAt: new Date().toISOString(),
        lastUsedAt: null
      }
    ];
    const { started, snapshot: afterStart } = start(snapshot);
    const unverified = passkeyVerifier(false);
    const options = requestScope(afterStart, unverified);
    const challenge = await options.beginRecoveryApproval({
      sessionId: owner.session.id,
      code: started.code,
      method: "passkey",
      rpId: "localhost",
      origin
    });
    if (challenge.method !== "passkey") throw new Error("expected a passkey challenge");
    const approve = requestScope(options.snapshot(), unverified);
    await expect(
      approve.approveRecoveryApproval({
        sessionId: owner.session.id,
        requestId: challenge.requestId,
        method: "passkey",
        ceremonyId: challenge.ceremonyId,
        response: passkeyAssertion,
        rpId: "localhost",
        origin
      })
    ).rejects.toMatchObject({ code: "recovery_approval_proof_invalid" });
    expect(requestScope(approve.snapshot()).recoveryApprovalStatus(started)).toMatchObject({
      status: "pending"
    });
  });

  it("asks an owner with no passkey to add one before approving from a browser", async () => {
    const seed = createCp2Store();
    const owner = seed.signupWithPhonePin({ destination: phone, pin: "1234" });
    const { started, snapshot } = start(seed.snapshot());
    await expect(
      requestScope(snapshot).beginRecoveryApproval({
        sessionId: owner.session.id,
        code: started.code,
        method: "passkey",
        rpId: "localhost",
        origin
      })
    ).rejects.toMatchObject({ code: "recovery_approval_passkey_missing" });
  });

  it("ends every open request for the number after 5 wrong codes", async () => {
    const owner = trustedAndroidOwner();
    const { started, snapshot } = start(owner.snapshot);
    let state = snapshot;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const store = requestScope(state);
      const wrong = started.code === "000000" ? "111111" : "000000";
      await expect(
        store.beginRecoveryApproval({
          sessionId: owner.owner.session.id,
          code: wrong,
          method: "device",
          credentialId: owner.credentialId
        })
      ).rejects.toMatchObject({ code: "recovery_approval_code_invalid" });
      state = store.snapshot();
    }
    await expect(
      requestScope(state).beginRecoveryApproval({
        sessionId: owner.owner.session.id,
        code: started.code,
        method: "device",
        credentialId: owner.credentialId
      })
    ).rejects.toMatchObject({ code: "recovery_approval_code_invalid" });
    expect(requestScope(state).recoveryApprovalStatus(started)).toEqual({ status: "expired" });
  });

  it("never matches another account's request, whatever the code", async () => {
    const victim = trustedAndroidOwner(phone);
    const { started, snapshot } = start(victim.snapshot);
    const other = requestScope(snapshot);
    const attacker = other.signupWithPhonePin({ destination: otherPhone, pin: "4321" });
    await expect(
      other.beginRecoveryApproval({
        sessionId: attacker.session.id,
        code: started.code,
        method: "device",
        credentialId: victim.credentialId
      })
    ).rejects.toMatchObject({ code: "recovery_approval_code_invalid" });
    expect(other.pendingRecoveryApprovals({ sessionId: attacker.session.id }).requests).toEqual([]);
  });

  it("refuses the plain browser key and revoked Android keys as approvers", async () => {
    const plain = trustedAndroidOwner(phone, false);
    const first = start(plain.snapshot);
    await expect(
      requestScope(first.snapshot).beginRecoveryApproval({
        sessionId: plain.owner.session.id,
        code: first.started.code,
        method: "device",
        credentialId: plain.credentialId
      })
    ).rejects.toMatchObject({ code: "recovery_approval_device_missing" });

    const revokedOwner = trustedAndroidOwner(phone);
    const revoke = requestScope(revokedOwner.snapshot);
    revoke.revokeDeviceRecoveryCredential({
      sessionId: revokedOwner.owner.session.id,
      credentialId: revokedOwner.credentialId
    });
    const second = start(revoke.snapshot());
    await expect(
      requestScope(second.snapshot).beginRecoveryApproval({
        sessionId: revokedOwner.owner.session.id,
        code: second.started.code,
        method: "device",
        credentialId: revokedOwner.credentialId
      })
    ).rejects.toMatchObject({ code: "recovery_approval_device_missing" });
  });

  it.each(["nonce", "signature", "challenge", "expired", "session", "replay"] as const)(
    "rejects a tampered Android approval (%s) and allows exactly one try per challenge",
    async (failure) => {
      const owner = trustedAndroidOwner();
      const { started, snapshot } = start(owner.snapshot);
      const now = new Date();
      const options = requestScope(snapshot);
      const challenge = await options.beginRecoveryApproval({
        sessionId: owner.owner.session.id,
        code: started.code,
        method: "device",
        credentialId: owner.credentialId,
        now
      });
      if (challenge.method !== "device") throw new Error("expected a device challenge");
      let afterOptions = options.snapshot();
      let sessionId = owner.owner.session.id;
      if (failure === "session") {
        const second = requestScope(afterOptions);
        // The same owner, signed in elsewhere: a challenge belongs to the session that asked.
        sessionId = second.loginWithAccountPin({
          channel: "phone",
          destination: phone,
          pin: "1234"
        }).session.id;
        afterOptions = second.snapshot();
      }
      const signed = {
        ...challenge.challenge,
        signature: androidSignature(owner.credentialId, owner.privateKey, challenge.challenge)
      };
      const tampered = {
        ...signed,
        ...(failure === "nonce" ? { nonce: "A".repeat(32) } : {}),
        ...(failure === "signature" ? { signature: "A".repeat(86) } : {}),
        ...(failure === "challenge" ? { challengeId: crypto.randomUUID() } : {})
      };
      const approve = requestScope(afterOptions);
      const attempt = (store: Store, payload: typeof signed) =>
        store.approveRecoveryApproval({
          sessionId,
          requestId: challenge.requestId,
          method: "device",
          credentialId: owner.credentialId,
          ...payload,
          now: new Date(now.getTime() + (failure === "expired" ? 3 * 60_000 : 0))
        });
      if (failure === "replay") {
        await attempt(approve, signed);
        await expect(attempt(requestScope(approve.snapshot()), signed)).rejects.toHaveProperty(
          "code"
        );
        return;
      }
      await expect(attempt(approve, tampered)).rejects.toHaveProperty("code");
      // The challenge is spent even by a failed try: the honest signature no longer works.
      await expect(attempt(requestScope(approve.snapshot()), signed)).rejects.toHaveProperty(
        "code"
      );
      expect(requestScope(approve.snapshot()).recoveryApprovalStatus(started)).not.toMatchObject({
        status: "approved"
      });
    }
  );

  it("lets the owner decline, and a declined request can never be approved", async () => {
    const owner = trustedAndroidOwner();
    const { started, snapshot } = start(owner.snapshot);
    const decline = requestScope(snapshot);
    decline.declineRecoveryApproval({
      sessionId: owner.owner.session.id,
      requestId: started.transactionId
    });
    const afterDecline = decline.snapshot();
    expect(requestScope(afterDecline).recoveryApprovalStatus(started)).toEqual({
      status: "declined"
    });
    await expect(
      requestScope(afterDecline).beginRecoveryApproval({
        sessionId: owner.owner.session.id,
        code: started.code,
        method: "device",
        credentialId: owner.credentialId
      })
    ).rejects.toMatchObject({ code: "recovery_approval_code_invalid" });
  });

  it("withdraws an approval when the approving key is revoked before the browser collects", async () => {
    const owner = trustedAndroidOwner();
    const { started, snapshot } = start(owner.snapshot);
    const approved = await approveOnAndroid(snapshot, {
      sessionId: owner.owner.session.id,
      code: started.code,
      credentialId: owner.credentialId,
      privateKey: owner.privateKey
    });
    const revoke = requestScope(approved);
    revoke.revokeDeviceRecoveryCredential({
      sessionId: owner.owner.session.id,
      credentialId: owner.credentialId
    });
    const afterRevoke = revoke.snapshot();
    const sessionsBefore = afterRevoke.sessions.length;
    const collect = requestScope(afterRevoke);
    expect(collect.recoveryApprovalStatus(started)).toEqual({ status: "declined" });
    expect(collect.snapshot().sessions).toHaveLength(sessionsBefore);
  });

  it("lets the owner withdraw an approval the browser has not collected", async () => {
    const owner = trustedAndroidOwner();
    const { started, snapshot } = start(owner.snapshot);
    const approved = await approveOnAndroid(snapshot, {
      sessionId: owner.owner.session.id,
      code: started.code,
      credentialId: owner.credentialId,
      privateKey: owner.privateKey
    });
    const undo = requestScope(approved);
    expect(
      undo.declineRecoveryApproval({
        sessionId: owner.owner.session.id,
        requestId: started.transactionId
      })
    ).toEqual({ declined: true });
    expect(requestScope(undo.snapshot()).recoveryApprovalStatus(started)).toEqual({
      status: "declined"
    });
  });

  it("refuses an Android key whose screen lock was never proven by attestation", async () => {
    // Without attestation, deviceSecurity is the client's own claim: a session that knew the PIN
    // could enroll a software key and use it to approve its own browser at any later time.
    const owner = trustedAndroidOwner(phone, true, false);
    const { started, snapshot } = start(owner.snapshot);
    await expect(
      requestScope(snapshot).beginRecoveryApproval({
        sessionId: owner.owner.session.id,
        code: started.code,
        method: "device",
        credentialId: owner.credentialId
      })
    ).rejects.toMatchObject({ code: "recovery_approval_device_missing" });
  });

  it.each([phone, "+254799999222"])(
    "limits one requester to 5 codes for %s in 10 minutes without locking out anyone else",
    (identifier) => {
      const owner = trustedAndroidOwner();
      let state = owner.snapshot;
      const now = Date.now();
      for (let index = 0; index < 5; index += 1) {
        const store = requestScope(state);
        store.startRecoveryApproval({
          identifier,
          client: "Chrome",
          clientKey: "attacker",
          now: new Date(now + index * 1000)
        });
        state = store.snapshot();
      }
      expect(() =>
        requestScope(state).startRecoveryApproval({
          identifier,
          client: "Chrome",
          clientKey: "attacker",
          now: new Date(now + 6000)
        })
      ).toThrow(expect.objectContaining({ code: "recovery_approval_rate_limited" }));
      // The owner, from their own address, is never refused because of someone else.
      expect(() =>
        requestScope(state).startRecoveryApproval({
          identifier,
          client: "Chrome",
          clientKey: "owner",
          now: new Date(now + 7000)
        })
      ).not.toThrow();
      expect(() =>
        requestScope(state).startRecoveryApproval({
          identifier,
          client: "Chrome",
          clientKey: "attacker",
          now: new Date(now + 11 * 60_000)
        })
      ).not.toThrow();
    }
  );

  it("refuses new codes when a number is full instead of cancelling the owner's", () => {
    const owner = trustedAndroidOwner();
    let state = owner.snapshot;
    const now = Date.now();
    const begin = (clientKey: string, offset: number) => {
      const store = requestScope(state);
      const started = store.startRecoveryApproval({
        identifier: phone,
        client: clientKey,
        clientKey,
        now: new Date(now + offset)
      });
      state = store.snapshot();
      return started;
    };
    const mine = begin("owner", 0);
    // A flood with a fresh, spoofed requester key every time.
    for (let index = 1; index < 10; index += 1) begin(`spoofed-${index}`, index * 1000);
    expect(() => begin("spoofed-10", 10_000)).toThrow(
      expect.objectContaining({ code: "recovery_approval_busy" })
    );
    const open = requestScope(state).pendingRecoveryApprovals({
      sessionId: owner.owner.session.id
    });
    expect(open.requests).toHaveLength(10);
    expect(requestScope(state).recoveryApprovalStatus(mine)).toMatchObject({ status: "pending" });
  });

  it("never signs out devices that were logged in before, when the browser resets the PIN", async () => {
    const owner = trustedAndroidOwner();
    const elsewhere = requestScope(owner.snapshot);
    const other = elsewhere.loginWithAccountPin({
      channel: "phone",
      destination: phone,
      pin: "1234"
    });
    const { started, snapshot } = start(elsewhere.snapshot());
    const approved = await approveOnAndroid(snapshot, {
      sessionId: owner.owner.session.id,
      code: started.code,
      credentialId: owner.credentialId,
      privateKey: owner.privateKey
    });
    const collect = requestScope(approved);
    const browser = collect.recoveryApprovalStatus(started);
    if (browser.status !== "approved") throw new Error("expected approval");
    const reset = requestScope(collect.snapshot());
    reset.recoverPhoneAccountPinWithDevice({ sessionId: browser.session.id, pin: "5678" });
    const after = reset.snapshot();
    const revoked = (id: string) => after.sessions.find((session) => session.id === id)?.revokedAt;
    expect(revoked(owner.owner.session.id)).toBeNull();
    expect(revoked(other.session.id)).toBeNull();
    expect(revoked(browser.session.id)).toBeNull();
  });

  /** An approved and collected browser session, plus the state it left behind. */
  async function letBrowserIn() {
    const owner = trustedAndroidOwner();
    const { started, snapshot } = start(owner.snapshot);
    const approved = await approveOnAndroid(snapshot, {
      sessionId: owner.owner.session.id,
      code: started.code,
      credentialId: owner.credentialId,
      privateKey: owner.privateKey
    });
    const collect = requestScope(approved);
    const browser = collect.recoveryApprovalStatus(started);
    if (browser.status !== "approved") throw new Error("expected approval");
    return { owner, started, browser, collected: collect.snapshot() };
  }

  it("keeps the browser on probation: it cannot remove the owner's devices or credentials", async () => {
    const { owner, browser, collected } = await letBrowserIn();
    const store = requestScope(collected);
    const sessionId = browser.session.id;
    expect(() =>
      store.revokeDeviceSession({ sessionId, targetSessionId: owner.owner.session.id })
    ).toThrow(expect.objectContaining({ code: "recovery_approval_probation" }));
    expect(() =>
      store.revokeDeviceRecoveryCredential({ sessionId, credentialId: owner.credentialId })
    ).toThrow(expect.objectContaining({ code: "recovery_approval_probation" }));
    expect(() => store.revokePasskey({ sessionId, credentialId: "owner-passkey" })).toThrow(
      expect.objectContaining({ code: "recovery_approval_probation" })
    );
    expect(() => store.logoutAll(sessionId)).toThrow(
      expect.objectContaining({ code: "recovery_approval_probation" })
    );
    // The owner's own device is not on probation.
    expect(() =>
      store.revokeDeviceSession({ sessionId: owner.owner.session.id, targetSessionId: sessionId })
    ).not.toThrow();
    // After 24 hours (the approval record's expiry) the browser is an ordinary session.
    const ended = structuredClone(collected);
    for (const record of ended.authTransactions ?? [])
      if (record.metadata.recoveryApprovalRequest === true)
        record.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(
      requestScope(ended).revokeDeviceRecoveryCredential({
        sessionId,
        credentialId: owner.credentialId
      })
    ).toMatchObject({ revoked: true });
  });

  it("lists the browser for 24 hours, and undo removes everything it added", async () => {
    const { owner, started, browser, collected } = await letBrowserIn();
    const listed = requestScope(collected).pendingRecoveryApprovals({
      sessionId: owner.owner.session.id
    });
    expect(listed.recentApprovals).toEqual([
      expect.objectContaining({ requestId: started.transactionId, client: "Chrome on Android" })
    ]);

    // The browser resets the PIN, adds its own passkey, and logs in again with it.
    const reset = requestScope(collected);
    reset.recoverPhoneAccountPinWithDevice({ sessionId: browser.session.id, pin: "5678" });
    const afterReset = reset.snapshot();
    const later = new Date(Date.now() + 1000).toISOString();
    afterReset.passkeys = [
      ...(afterReset.passkeys ?? []),
      {
        id: "attacker-passkey",
        accountId: owner.owner.account.id,
        userId: owner.owner.user.id,
        webauthnUserId: "attacker",
        publicKey: "AQID",
        counter: 0,
        label: "Attacker",
        deviceType: "singleDevice",
        backedUp: false,
        transports: ["internal"],
        createdAt: later,
        lastUsedAt: null
      }
    ];
    // A sign-in phone it added, through any path, and the profile phone it changed.
    afterReset.accountIdentities = [
      ...(afterReset.accountIdentities ?? []),
      {
        id: "attacker-phone",
        accountId: owner.owner.account.id,
        userId: owner.owner.user.id,
        type: "phone",
        normalizedValue: "+442079460999",
        displayValue: "+442079460999",
        isPrimary: false,
        verifiedAt: null,
        createdAt: later,
        updatedAt: later
      }
    ];
    afterReset.users = afterReset.users.map((user) =>
      user.id === owner.owner.user.id ? { ...user, phoneNumberE164: "+442079460999" } : user
    );
    afterReset.userIdentities = [
      ...(afterReset.userIdentities ?? []),
      {
        id: "attacker-google",
        accountId: owner.owner.account.id,
        userId: owner.owner.user.id,
        provider: "google",
        providerSubject: "attacker-subject",
        email: "attacker@example.test",
        emailVerified: true,
        displayName: "Attacker",
        avatarUrl: null,
        linkedAt: later,
        lastLoginAt: null,
        encryptedAccessToken: null,
        encryptedRefreshToken: null,
        encryptedIdToken: null,
        tokenType: null,
        tokenExpiresAt: null,
        scope: null,
        updatedAt: later
      } as never
    ];
    const relogin = requestScope(afterReset);
    const second = relogin.loginWithAccountPin({
      channel: "phone",
      destination: phone,
      pin: "5678"
    });

    const undo = requestScope(relogin.snapshot());
    undo.declineRecoveryApproval({
      sessionId: owner.owner.session.id,
      requestId: started.transactionId
    });
    const after = undo.snapshot();
    const revoked = (id: string) => after.sessions.find((session) => session.id === id)?.revokedAt;
    expect(revoked(browser.session.id)).not.toBeNull();
    expect(revoked(second.session.id)).not.toBeNull();
    expect(revoked(owner.owner.session.id)).toBeNull();
    expect((after.passkeys ?? []).map((passkey) => passkey.id)).not.toContain("attacker-passkey");
    expect((after.userIdentities ?? []).map((identity) => identity.id)).not.toContain(
      "attacker-google"
    );
    expect((after.accountIdentities ?? []).map((identity) => identity.id)).not.toContain(
      "attacker-phone"
    );
    expect(after.users.find((user) => user.id === owner.owner.user.id)?.phoneNumberE164).not.toBe(
      "+442079460999"
    );
    // The PIN the browser set no longer works; the owner's own PIN works again.
    expect(() =>
      requestScope(after).loginWithAccountPin({ channel: "phone", destination: phone, pin: "5678" })
    ).toThrow();
    expect(
      requestScope(after).loginWithAccountPin({ channel: "phone", destination: phone, pin: "1234" })
        .account.id
    ).toBe(owner.owner.account.id);
    expect(
      after.deviceRecoveryCredentials?.find((key) => key.id === owner.credentialId)?.revokedAt
    ).toBeNull();
    expect(
      requestScope(after).pendingRecoveryApprovals({ sessionId: owner.owner.session.id })
        .recentApprovals
    ).toEqual([]);

    // Past 24 hours there is nothing left to undo.
    const expired = structuredClone(collected);
    expired.authTransactions!.find((record) => record.id === started.transactionId)!.expiresAt =
      new Date(Date.now() - 1000).toISOString();
    expect(() =>
      requestScope(expired).declineRecoveryApproval({
        sessionId: owner.owner.session.id,
        requestId: started.transactionId
      })
    ).toThrow(expect.objectContaining({ code: "recovery_approval_not_found" }));
  });

  it("keeps a fresh login after the approval on probation too", async () => {
    // Attack: reset the PIN through the grant, log in again with it, and act from the new session.
    const { owner, started, browser, collected } = await letBrowserIn();
    const reset = requestScope(collected);
    reset.recoverPhoneAccountPinWithDevice({ sessionId: browser.session.id, pin: "5678" });
    const relogin = requestScope(reset.snapshot());
    const fresh = relogin.loginWithAccountPin({
      channel: "phone",
      destination: phone,
      pin: "5678"
    });
    const state = relogin.snapshot();
    const probation = expect.objectContaining({ code: "recovery_approval_probation" });
    expect(() =>
      requestScope(state).revokeDeviceRecoveryCredential({
        sessionId: fresh.session.id,
        credentialId: owner.credentialId
      })
    ).toThrow(probation);
    expect(() => requestScope(state).logoutAll(fresh.session.id)).toThrow(probation);
    expect(() =>
      requestScope(state).revokeDeviceSession({
        sessionId: fresh.session.id,
        targetSessionId: owner.owner.session.id
      })
    ).toThrow(probation);
    // Nor can it undo, decline or approve.
    expect(() =>
      requestScope(state).declineRecoveryApproval({
        sessionId: fresh.session.id,
        requestId: started.transactionId
      })
    ).toThrow(probation);
    // The owner still can.
    expect(
      requestScope(state).declineRecoveryApproval({
        sessionId: owner.owner.session.id,
        requestId: started.transactionId
      })
    ).toEqual({ declined: true });
  });

  it("does not let the browser undo its own approval to end probation", async () => {
    const { owner, started, browser, collected } = await letBrowserIn();
    expect(() =>
      requestScope(collected).declineRecoveryApproval({
        sessionId: browser.session.id,
        requestId: started.transactionId
      })
    ).toThrow(expect.objectContaining({ code: "recovery_approval_probation" }));
    expect(
      requestScope(collected).pendingRecoveryApprovals({ sessionId: owner.owner.session.id })
        .recentApprovals
    ).toHaveLength(1);
  });

  it("does not let a probation session approve another browser", async () => {
    const { browser, collected } = await letBrowserIn();
    const { started } = start(collected, phone, "Second browser");
    await expect(
      requestScope(collected).beginRecoveryApproval({
        sessionId: browser.session.id,
        code: started.code,
        method: "passkey",
        rpId: "localhost",
        origin
      })
    ).rejects.toMatchObject({ code: "recovery_approval_probation" });
  });

  it("treats a refreshed device as the same trusted device, and undo keeps it", async () => {
    const owner = trustedAndroidOwner();
    // A second device, logged in before any approval.
    const laptopLogin = requestScope(owner.snapshot);
    const laptop = laptopLogin.loginWithAccountPin({
      channel: "phone",
      destination: phone,
      pin: "1234"
    });
    const metadata = {
      deviceId: "laptop",
      deviceName: "Laptop",
      platform: "web",
      browserOrApp: "Chrome",
      userAgent: "Chrome"
    };
    const refreshToken = laptopLogin.prepareDeviceSession(laptop.session.id, metadata);
    const { started, snapshot } = start(laptopLogin.snapshot());
    const approved = await approveOnAndroid(snapshot, {
      sessionId: owner.owner.session.id,
      code: started.code,
      credentialId: owner.credentialId,
      privateKey: owner.privateKey
    });
    const collect = requestScope(approved);
    const browser = collect.recoveryApprovalStatus(started);
    if (browser.status !== "approved") throw new Error("expected approval");
    // After the approval, the laptop's session refreshes: a new record in the same family.
    const refresh = requestScope(collect.snapshot());
    const renewed = refresh.refreshSessionCredential({ refreshToken, metadata });
    expect(renewed.session.id).not.toBe(laptop.session.id);
    const state = refresh.snapshot();
    expect(() =>
      requestScope(state).revokeDeviceSession({
        sessionId: renewed.session.id,
        targetSessionId: browser.session.id
      })
    ).not.toThrow();
    const undo = requestScope(state);
    undo.declineRecoveryApproval({
      sessionId: owner.owner.session.id,
      requestId: started.transactionId
    });
    const after = undo.snapshot();
    const revoked = (id: string) => after.sessions.find((session) => session.id === id)?.revokedAt;
    expect(revoked(renewed.session.id)).toBeNull();
    expect(revoked(browser.session.id)).not.toBeNull();
  });

  /**
   * Every operation that writes sessions, credentials, sign-in identities or recovery settings.
   * A new one belongs here: a probation session must be refused, a trusted device must not be.
   */
  const guardedOperations: Array<[string, (store: Store, sessionId: string) => unknown]> = [
    [
      "sign out a device",
      (store, sessionId) =>
        store.revokeDeviceSession({ sessionId, targetSessionId: crypto.randomUUID() })
    ],
    ["log out everywhere", (store, sessionId) => store.logoutAll(sessionId)],
    [
      "remove a passkey",
      (store, sessionId) => store.revokePasskey({ sessionId, credentialId: "none" })
    ],
    [
      "revoke a device key",
      (store, sessionId) =>
        store.revokeDeviceRecoveryCredential({ sessionId, credentialId: crypto.randomUUID() })
    ],
    [
      "enroll a device-security key",
      (store, sessionId) =>
        store.continueWithDevice({
          sessionId,
          idempotencyKey: null,
          devicePublicKeyJwk: generateKeyPairSync("ec", {
            namedCurve: "prime256v1"
          }).publicKey.export({ format: "jwk" }),
          deviceSecurity: true
        })
    ],
    [
      "reset the PIN without a grant",
      (store, sessionId) => store.recoverAccountPin({ sessionId, pin: "4444" })
    ],
    [
      "change the PIN",
      (store, sessionId) => store.changeAccountPin({ sessionId, currentPin: "5678", pin: "4444" })
    ],
    [
      "change the password",
      (store, sessionId) =>
        store.changePassword({
          sessionId,
          currentPassword: "correct horse battery",
          password: "another long password"
        })
    ],
    ["set up an authenticator", (store, sessionId) => store.setupTotp({ sessionId })],
    [
      "regenerate MFA recovery codes",
      (store, sessionId) => store.regenerateMfaRecoveryCodes({ sessionId })
    ],
    [
      "disable an MFA factor",
      (store, sessionId) => store.disableMfaFactor({ sessionId, factorId: "none", code: "000000" })
    ],
    [
      "add a backup email",
      (store, sessionId) =>
        store.beginEmailIdentityUpgrade({ sessionId, email: "attacker@example.test" })
    ],
    [
      "merge an email identity",
      (store, sessionId) =>
        store.beginEmailIdentityMerge({
          sessionId,
          email: "attacker@example.test",
          targetAccountId: crypto.randomUUID(),
          challengeId: crypto.randomUUID()
        })
    ],
    [
      "change the owner phone",
      (store, sessionId) =>
        store.updateOwnerPhone({ sessionId, phoneNumber: "0799000111", country: "KE" })
    ],
    [
      "link a sign-in provider",
      (store, sessionId) =>
        store.beginOAuthSession({
          accountSessionId: sessionId,
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          codeChallenge: "c".repeat(43),
          codeVerifier: "v".repeat(43),
          csrfToken: "csrf",
          provider: "google",
          redirectUri: "https://grogoni.com/auth/oauth/google/callback",
          state: "state"
        })
    ],
    [
      "disconnect a sign-in provider",
      (store, sessionId) =>
        store.disconnectSocialAccount({
          sessionId,
          businessId: crypto.randomUUID(),
          identityId: "x"
        })
    ],
    [
      "create a first shop whose phone becomes a sign-in identity",
      (store, sessionId) =>
        store.createBusiness({
          sessionId,
          name: "Attacker shop",
          language: "en",
          phoneNumber: "+442079460999",
          phoneCountry: "GB"
        } as never)
    ],
    [
      "disconnect a login provider",
      (store, sessionId) => store.disconnectLoginAccount({ sessionId, identityId: "x" })
    ],
    [
      "create a password",
      (store, sessionId) => store.createPassword({ sessionId, password: "another long password" })
    ],
    [
      "mint an API token",
      (store, sessionId) =>
        store.createMcpAccessToken({ sessionId, name: "x", scopes: ["mcp:read"] } as never)
    ],
    [
      "invite staff",
      (store, sessionId) =>
        store.inviteStaff({ sessionId, businessId: crypto.randomUUID(), role: "manager" } as never)
    ],
    [
      "change a staff role",
      (store, sessionId) =>
        store.changeStaffRole({ sessionId, businessId: crypto.randomUUID() } as never)
    ],
    [
      "delete a shop",
      (store, sessionId) =>
        store.requestShopDeletion({
          sessionId,
          businessId: crypto.randomUUID(),
          shopId: crypto.randomUUID()
        })
    ],
    [
      "delete the account",
      (store, sessionId) =>
        store.requestAccountDeletion({
          sessionId,
          businessId: crypto.randomUUID(),
          deletion: {} as never
        })
    ]
  ];

  it.each(guardedOperations)(
    "refuses to %s from a probation session, and allows a trusted device to try",
    async (_name, operation) => {
      const { owner, browser, collected } = await letBrowserIn();
      const refused = await Promise.resolve()
        .then(() => operation(requestScope(collected), browser.session.id))
        .then(
          () => null,
          (error: unknown) => error
        );
      expect(refused).toMatchObject({ code: "recovery_approval_probation" });
      const trusted = await Promise.resolve()
        .then(() => operation(requestScope(collected), owner.owner.session.id))
        .then(
          () => null,
          (error: unknown) => error
        );
      expect(trusted).not.toMatchObject({ code: "recovery_approval_probation" });
    }
  );

  it("refuses to join another account into one with a browser on probation", async () => {
    // Attack: a device account made days earlier, with its own passkey, is merged in after the
    // phished approval. Its credentials would keep their old createdAt and survive undo.
    const { browser, collected } = await letBrowserIn();
    const reset = requestScope(collected);
    reset.recoverPhoneAccountPinWithDevice({ sessionId: browser.session.id, pin: "5678" });
    const merge = requestScope(reset.snapshot());
    const attacker = merge.continueWithDevice({
      sessionId: null,
      idempotencyKey: crypto.randomUUID(),
      devicePublicKeyJwk: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
        format: "jwk"
      })
    });
    expect(() =>
      merge.mergeCurrentDeviceAccountWithPin({
        sessionId: attacker.session.id,
        channel: "phone",
        destination: phone,
        pin: "5678"
      })
    ).toThrow(expect.objectContaining({ code: "recovery_approval_probation" }));
  });

  it("revokes API tokens minted since the browser got in", async () => {
    const { owner, started, collected } = await letBrowserIn();
    const state = structuredClone(collected);
    const later = new Date(Date.now() + 1000).toISOString();
    state.mcpAccessTokens = [
      ...(state.mcpAccessTokens ?? []),
      {
        id: "attacker-token",
        accountId: owner.owner.account.id,
        userId: owner.owner.user.id,
        createdBySessionId: null,
        tokenHash: "f".repeat(64),
        name: "attacker",
        scopes: ["mcp:act"],
        shopId: null,
        createdAt: later,
        expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        lastUsedAt: null,
        revokedAt: null
      } as never
    ];
    const undo = requestScope(state);
    undo.declineRecoveryApproval({
      sessionId: owner.owner.session.id,
      requestId: started.transactionId
    });
    expect(
      undo.snapshot().mcpAccessTokens?.find((token) => token.id === "attacker-token")?.revokedAt
    ).not.toBeNull();
  });

  function e2eeKey() {
    const jwk = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
      format: "jwk"
    }) as { kty: "EC"; crv: "P-256"; x: string; y: string };
    return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  }

  it("does not let a probation session re-key or revive the owner's E2EE device", async () => {
    // Attack: list the owner's device ids, then register one of them with the attacker's key,
    // so the owner's encrypted messages are encrypted to the attacker.
    const { owner, browser, collected } = await letBrowserIn();
    const setup = requestScope(collected);
    const ownerKey = e2eeKey();
    setup.registerE2eeDevice({
      sessionId: owner.owner.session.id,
      deviceId: "owner-laptop-device",
      label: "Laptop",
      publicKey: ownerKey
    });
    const state = setup.snapshot();
    expect(() =>
      requestScope(state).registerE2eeDevice({
        sessionId: browser.session.id,
        deviceId: "owner-laptop-device",
        label: "Laptop",
        publicKey: e2eeKey()
      })
    ).toThrow(expect.objectContaining({ code: "recovery_approval_probation" }));
    // Re-announcing the same key is a heartbeat, and the browser's own new device is fine.
    expect(() =>
      requestScope(state).registerE2eeDevice({
        sessionId: browser.session.id,
        deviceId: "owner-laptop-device",
        label: "Laptop",
        publicKey: ownerKey
      })
    ).not.toThrow();
    expect(() =>
      requestScope(state).registerE2eeDevice({
        sessionId: browser.session.id,
        deviceId: "recovered-browser-device",
        label: "Browser",
        publicKey: e2eeKey()
      })
    ).not.toThrow();
  });

  it("does not trust a browser still on probation when a second browser is approved", async () => {
    const { owner, browser, collected } = await letBrowserIn();
    const { started, snapshot } = start(collected, phone, "Second browser");
    const approved = await approveOnAndroid(snapshot, {
      sessionId: owner.owner.session.id,
      code: started.code,
      credentialId: owner.credentialId,
      privateKey: owner.privateKey
    });
    const collect = requestScope(approved);
    expect(collect.recoveryApprovalStatus(started)).toMatchObject({ status: "approved" });
    const after = collect.snapshot();
    const second = after.authTransactions!.find((record) => record.id === started.transactionId)!;
    const trusted = JSON.parse(String(second.metadata.recoveryApprovalTrustedFamilies)) as string[];
    const browserFamily = after.sessions.find(
      (session) => session.id === browser.session.id
    )!.sessionFamilyId;
    expect(trusted).not.toContain(browserFamily);
  });

  it("lets the probation browser set its first PIN once, with its grant", async () => {
    const { browser, collected } = await letBrowserIn();
    const state = structuredClone(collected);
    state.accountPinHashes = [];
    const store = requestScope(state);
    expect(
      store.setAccountPin({ sessionId: browser.session.id, pin: "5678", pinConfirmation: "5678" })
    ).toBeDefined();
    expect(() =>
      store.setAccountPin({ sessionId: browser.session.id, pin: "4444", pinConfirmation: "4444" })
    ).toThrow();
  });

  it("does not let a passkey or device key added during probation approve another browser", async () => {
    const { owner, collected } = await letBrowserIn();
    const later = new Date(Date.now() + 1000).toISOString();
    const state = structuredClone(collected);
    state.passkeys = [
      {
        id: passkeyAssertion.id,
        accountId: owner.owner.account.id,
        userId: owner.owner.user.id,
        webauthnUserId: "owner-handle",
        publicKey: "AQID",
        counter: 0,
        label: "Added by the browser",
        deviceType: "singleDevice",
        backedUp: false,
        transports: ["internal"],
        createdAt: later,
        lastUsedAt: null
      }
    ];
    const key = state.deviceRecoveryCredentials!.find((item) => item.id === owner.credentialId)!;
    key.createdAt = later;
    const { started, snapshot } = start(state, phone, "Another browser");
    await expect(
      requestScope(snapshot).beginRecoveryApproval({
        sessionId: owner.owner.session.id,
        code: started.code,
        method: "passkey",
        rpId: "localhost",
        origin
      })
    ).rejects.toMatchObject({ code: "recovery_approval_passkey_missing" });
    await expect(
      requestScope(snapshot).beginRecoveryApproval({
        sessionId: owner.owner.session.id,
        code: started.code,
        method: "device",
        credentialId: owner.credentialId
      })
    ).rejects.toMatchObject({ code: "recovery_approval_device_missing" });
  });

  it("revoking the approving key before the reset cancels the browser's grant", async () => {
    const owner = trustedAndroidOwner();
    const { started, snapshot } = start(owner.snapshot);
    const approved = await approveOnAndroid(snapshot, {
      sessionId: owner.owner.session.id,
      code: started.code,
      credentialId: owner.credentialId,
      privateKey: owner.privateKey
    });
    const collect = requestScope(approved);
    const browser = collect.recoveryApprovalStatus(started);
    if (browser.status !== "approved") throw new Error("expected approval");
    const revoke = requestScope(collect.snapshot());
    revoke.revokeDeviceRecoveryCredential({
      sessionId: owner.owner.session.id,
      credentialId: owner.credentialId
    });
    expect(() =>
      requestScope(revoke.snapshot()).recoverPhoneAccountPinWithDevice({
        sessionId: browser.session.id,
        pin: "5678"
      })
    ).toThrow(/Verify this device/u);
  });

  it("starts the same way for unknown numbers and never reveals whether one is registered", () => {
    const empty = createCp2Store().snapshot();
    const { started, snapshot } = start(empty, "+254799999111");
    expect(Object.keys(started).sort()).toEqual(
      ["code", "expiresAt", "pollIntervalMs", "pollSecret", "transactionId"].sort()
    );
    expect(requestScope(snapshot).recoveryApprovalStatus(started)).toMatchObject({
      status: "pending"
    });
    expect(() =>
      requestScope(snapshot).recoveryApprovalStatus({ ...started, pollSecret: "wrong" })
    ).toThrow(expect.objectContaining({ code: "recovery_approval_not_found" }));
    expect(() =>
      requestScope(snapshot).startRecoveryApproval({
        clientKey: "client-a",
        identifier: "0711000222",
        client: "x"
      })
    ).toThrow(expect.objectContaining({ code: "recovery_identifier_required" }));
  });

  it("expires an unanswered request after 10 minutes", () => {
    const owner = trustedAndroidOwner();
    const now = new Date();
    const store = requestScope(owner.snapshot);
    const started = store.startRecoveryApproval({
      clientKey: "client-a",
      identifier: phone,
      client: "Chrome",
      now
    });
    expect(
      store.recoveryApprovalStatus({ ...started, now: new Date(now.getTime() + 10 * 60_000) })
    ).toEqual({ status: "expired" });
  });

  it("does not let an approval request stand in for email or Android recovery transactions", async () => {
    const owner = trustedAndroidOwner();
    const { started, snapshot } = start(owner.snapshot);
    const store = requestScope(snapshot);
    expect(() =>
      store.verifyEmailRecovery({
        transactionId: started.transactionId,
        challengeId: "none",
        code: started.code
      })
    ).toThrow(expect.objectContaining({ code: "recovery_verification_invalid" }));
    expect(() =>
      store.resetRecoveredPassword({
        transactionId: started.transactionId,
        password: "x".repeat(12)
      })
    ).toThrow(expect.objectContaining({ code: "auth_transaction_invalid" }));
  });
});

describe("recovery approval routes", () => {
  it("serves the full flow over HTTP and sets the browser's session cookie", async () => {
    const owner = trustedAndroidOwner();
    const store = createCp2Store();
    store.hydrateSnapshot(owner.snapshot);
    const app = buildApi({ cp2: { store } });
    try {
      const startResponse = await app.inject({
        method: "POST",
        url: "/auth/recovery/device-approval/start",
        headers: {
          "content-type": "application/json",
          "user-agent":
            "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36"
        },
        payload: { identifier: phone }
      });
      expect(startResponse.statusCode).toBe(200);
      const started = startResponse.json();
      const ownerCookie = `grogoni_session=${owner.owner.session.id}`;
      const pending = await app.inject({
        method: "GET",
        url: "/auth/recovery/device-approval/pending",
        headers: { cookie: ownerCookie }
      });
      expect(pending.json()).toMatchObject({
        phone,
        requests: [{ client: "Chrome on Android" }]
      });
      const options = await app.inject({
        method: "POST",
        url: "/auth/recovery/device-approval/options",
        headers: { cookie: ownerCookie, "content-type": "application/json" },
        payload: { code: started.code, method: "device", credentialId: owner.credentialId }
      });
      expect(options.statusCode).toBe(200);
      const { requestId, challenge } = options.json();
      const approve = await app.inject({
        method: "POST",
        url: "/auth/recovery/device-approval/approve",
        headers: { cookie: ownerCookie, "content-type": "application/json" },
        payload: {
          requestId,
          method: "device",
          credentialId: owner.credentialId,
          challengeId: challenge.challengeId,
          nonce: challenge.nonce,
          issuedAt: challenge.issuedAt,
          signature: androidSignature(owner.credentialId, owner.privateKey, challenge)
        }
      });
      expect(approve.json()).toEqual({ approved: true });
      const status = await app.inject({
        method: "POST",
        url: "/auth/recovery/device-approval/status",
        headers: { "content-type": "application/json" },
        payload: { transactionId: started.transactionId, pollSecret: started.pollSecret }
      });
      expect(status.json()).toMatchObject({
        status: "approved",
        account: { id: owner.owner.account.id }
      });
      expect(String(status.headers["set-cookie"])).toContain("grogoni_session=");

      const guest = await app.inject({
        method: "GET",
        url: "/auth/recovery/device-approval/pending"
      });
      expect(guest.statusCode).toBe(401);
      const badMethod = await app.inject({
        method: "POST",
        url: "/auth/recovery/device-approval/options",
        headers: { cookie: ownerCookie, "content-type": "application/json" },
        payload: { code: "123456", method: "sms" }
      });
      expect(badMethod.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("recovery approval helpers", () => {
  it.each([
    [
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36",
      "Chrome on Android"
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
      "Safari on iPhone"
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0",
      "Edge on Windows"
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0; rv:132.0) Gecko/20100101 Firefox/132.0",
      "Firefox on Mac"
    ],
    [
      "Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36",
      "Samsung Internet on Android"
    ],
    [undefined, "A browser"]
  ])("labels %s as %s", (agent, label) => {
    expect(describeApprovalClient(agent)).toBe(label);
  });

  it("accepts spaced or dashed codes and nothing else", () => {
    expect(normalizeApprovalCode("482 915")).toBe("482915");
    expect(normalizeApprovalCode("482-915")).toBe("482915");
    expect(normalizeApprovalCode("48291")).toBeNull();
    expect(normalizeApprovalCode("4829150")).toBeNull();
    expect(normalizeApprovalCode("48a915")).toBeNull();
  });

  it("binds code hashes to their request", () => {
    const hash = hashApprovalValue("request-a", "482915");
    expect(approvalHashMatches(hash, "request-a", "482915")).toBe(true);
    expect(approvalHashMatches(hash, "request-b", "482915")).toBe(false);
    expect(approvalHashMatches("short", "request-a", "482915")).toBe(false);
    expect(approvalHashMatches(undefined, "request-a", "482915")).toBe(false);
  });
});

describe("recovery approval Edge scope", () => {
  it("locks each number on every route that changes its requests", () => {
    expect(
      recoveryApprovalLockKey("/auth/recovery/device-approval/start", { identifier: phone }, null)
    ).toBe(`edge:recovery-approval:${phone}`);
    expect(recoveryApprovalLockKey("/auth/recovery/device-approval/approve", {}, phone)).toBe(
      `edge:recovery-approval:${phone}`
    );
    expect(
      recoveryApprovalLockKey(
        "/auth/recovery/device-approval/start",
        { identifier: "+1' or 1=1" },
        null
      )
    ).toBeUndefined();
    expect(recoveryApprovalLockKey("/auth/passkeys/login/options", {}, phone)).toBeUndefined();
  });

  /** The parameters of the actor-resolution query, which picks whose data a request loads. */
  async function actorParameters(path: string, cookie: string, body: Record<string, unknown>) {
    const calls: unknown[][] = [];
    const client = {
      query: async (_sql: string, params?: unknown[]) => {
        calls.push(params ?? []);
        return { rows: [], rowCount: 0 };
      }
    };
    const payload = Buffer.from(JSON.stringify(body));
    await createEdgeSnapshotScope(
      client as never,
      new Request(`https://grogoni.com/api${path}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: payload
      }),
      path,
      payload
    );
    return calls[0]!;
  }

  it("resolves a status poll's account from the request, never from a guest cookie it holds", async () => {
    // The actor query ends in an unordered `limit 1`. With the guest's session among the
    // candidates, which account loads depends on the query plan, and a guest win loses the approval.
    const guest = "6f1c1a3e-6a8f-4c39-9a2e-222222222222";
    const transactionId = "6f1c1a3e-6a8f-4c39-9a2e-333333333333";
    const status = await actorParameters(
      "/auth/recovery/device-approval/status",
      `grogoni_session=${guest}`,
      { transactionId, pollSecret: "secret" }
    );
    expect(status[0]).toBeNull();
    expect(status).toContain(transactionId);
    // Every other route still resolves the caller from their session.
    const pending = await actorParameters(
      "/auth/recovery/device-approval/options",
      `grogoni_session=${guest}`,
      { code: "123456" }
    );
    expect(pending[0]).toBe(guest);
  });

  const actor = "'account-1'";
  const destination = `'${phone}'`;

  it("loads the browser's own request by id on status", () => {
    const id = "6f1c1a3e-6a8f-4c39-9a2e-111111111111";
    expect(
      recoveryApprovalTransactionScope(
        "/auth/recovery/device-approval/status",
        { transactionId: id },
        actor,
        destination
      )
    ).toContain(`entity_id = '${id}'`);
    expect(
      recoveryApprovalTransactionScope(
        "/auth/recovery/device-approval/status",
        { transactionId: "x' or true --" },
        actor,
        destination
      )
    ).not.toContain("or true");
  });

  it("loads open requests for the entered number on start and the owner's number otherwise", () => {
    expect(
      recoveryApprovalTransactionScope(
        "/auth/recovery/device-approval/start",
        { identifier: phone },
        "''",
        "''"
      )
    ).toContain(`account_id is null and record->>'identifierValue' = '${phone}'`);
    expect(
      recoveryApprovalTransactionScope(
        "/auth/recovery/device-approval/start",
        { identifier: "+1' or '1'='1" },
        "''",
        "''"
      )
    ).not.toContain("'1'='1");
    expect(
      recoveryApprovalTransactionScope(
        "/auth/recovery/device-approval/options",
        { code: "123456" },
        actor,
        destination
      )
    ).toContain(`record->>'identifierValue' = ${destination}`);
  });
});
