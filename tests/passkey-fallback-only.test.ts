import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Passkey login is fallback-only. There is no device-hint fast path that skips straight to a
 * passkey ceremony before an identifier is entered, and no "Continue with a passkey" option on
 * the ordinary methods screen - PIN is the primary sign-in method there, with password as a
 * secondary option. The only place a login-time passkey ceremony still runs is the phone
 * "Trouble logging in?" recovery path, used specifically when the owner can't use their PIN or
 * password (see docs/authentication/phone-first-authentication.md).
 */
describe("passkey is fallback-only, not a main-flow login method", () => {
  const source = readFileSync("apps/web/src/PhoneFirstAuthentication.tsx", "utf8");
  const signupSource = readFileSync("apps/web/src/PhoneSignup.tsx", "utf8");

  it("has no welcome-back-passkey fast path or device hint storage", () => {
    expect(source).not.toContain("welcome-back-passkey");
    expect(source).not.toContain("passkeyDeviceHint");
    expect(source).not.toContain("unlockWithPasskeyFastPath");
    expect(source).not.toContain("fallThroughToEntry");
    expect(source).not.toContain("Unlock with passkey");
  });

  it("starts every login attempt at ordinary identifier entry", () => {
    expect(source).toContain('useState<Stage>("entry")');
  });

  it("does not offer passkey as a selectable method on the normal methods screen", () => {
    const methodsBlock = source.slice(
      source.indexOf('stage === "methods" ? ('),
      source.indexOf('stage === "recovery-reset" ? (')
    );
    expect(methodsBlock).not.toContain("Continue with a passkey");
    expect(methodsBlock).not.toContain("usePasskey");
    expect(methodsBlock).toContain("auth-primary-button");
    expect(methodsBlock).toContain("Use account PIN");
  });

  it("uses device proof without a passkey ceremony for recovery", () => {
    const recoveryBlock = source.slice(
      source.indexOf("async function startRecovery()"),
      source.indexOf("async function verifyAndResetPassword()")
    );
    expect(recoveryBlock).toContain("await recoverDeviceAccount()");
    expect(recoveryBlock).not.toContain("/auth/passkeys/");

    expect(source).toContain("Trouble logging in?");
  });

  it("requires a password at signup and offers device recovery afterward", () => {
    expect(signupSource).not.toContain("addPassword");
    expect(signupSource).not.toContain("Passkeys are the preferred way to return to Grogoni");
    expect(signupSource).not.toContain("passwordless account needs a passkey");
    expect(signupSource).toContain("password.length < 10");
    expect(signupSource).toContain("Secure this device");
    expect(signupSource).toContain("Do this later");
  });
});
