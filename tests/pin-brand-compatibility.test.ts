import { scryptSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";

afterEach(() => vi.unstubAllEnvs());

function legacyPinStore() {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PIN_HASH_SECRET", "");
  const store = createCp2Store();
  const auth = store.signupWithPhonePin({ destination: "+254712345678", pin: "4321" });
  const snapshot = store.snapshot();
  const salt = Buffer.alloc(16, 7);
  const hash = scryptSync(`${auth.account.id}:4321:soko-market-local-pin-hash-secret`, salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
  const legacyHash = [
    "scrypt",
    "v2",
    "16384",
    "8",
    "1",
    salt.toString("base64url"),
    hash.toString("base64url")
  ].join("$");
  snapshot.accountPinHashes = [{ accountId: auth.account.id, pinHash: legacyHash }];
  store.hydrateSnapshot(snapshot);
  return { store, accountId: auth.account.id, legacyHash };
}

describe("PIN compatibility after the brand rename", () => {
  it("verifies an old development PIN and upgrades its hash after successful login", () => {
    const { store, accountId, legacyHash } = legacyPinStore();
    const auth = store.loginWithAccountPin({
      channel: "phone",
      destination: "+254712345678",
      pin: "4321"
    });
    expect(auth.account.id).toBe(accountId);
    expect(store.snapshot().accountPinHashes?.[0]?.pinHash).not.toBe(legacyHash);
    expect(
      store.loginWithAccountPin({
        channel: "phone",
        destination: "+254712345678",
        pin: "4321"
      }).account.id
    ).toBe(accountId);
  });

  it("rejects the wrong PIN without changing the stored hash", () => {
    const { store, legacyHash } = legacyPinStore();
    expect(() =>
      store.loginWithAccountPin({
        channel: "phone",
        destination: "+254712345678",
        pin: "1234"
      })
    ).toThrow("The account credentials are invalid.");
    expect(store.snapshot().accountPinHashes?.[0]?.pinHash).toBe(legacyHash);
  });

  it.each(["test", "production"])(
    "does not fall back when a secret is configured in %s mode",
    (mode) => {
      const { store, legacyHash } = legacyPinStore();
      vi.stubEnv("NODE_ENV", mode);
      vi.stubEnv("PIN_HASH_SECRET", "configured-secret-value-with-at-least-32-characters");
      expect(() =>
        store.loginWithAccountPin({
          channel: "phone",
          destination: "+254712345678",
          pin: "4321"
        })
      ).toThrow("The account credentials are invalid.");
      expect(store.snapshot().accountPinHashes?.[0]?.pinHash).toBe(legacyHash);
    }
  );
});
