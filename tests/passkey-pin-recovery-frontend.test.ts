import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  devicePinMutationEndpoint,
  devicePinRecoveryStage
} from "../apps/web/src/PhoneFirstAuthentication";

describe("phone device PIN recovery frontend", () => {
  it("routes no-PIN and existing-PIN accounts to distinct credential mutations", () => {
    expect(devicePinRecoveryStage(false)).toBe("create-pin");
    expect(devicePinMutationEndpoint("create-pin")).toBe("/auth/pin/setup");

    expect(devicePinRecoveryStage(true)).toBe("recover-pin");
    expect(devicePinMutationEndpoint("recover-pin")).toBe("/auth/pin/recover/device");
  });

  it("checks server credential status after device verification and before choosing the screen", () => {
    const source = readFileSync("apps/web/src/PhoneFirstAuthentication.tsx", "utf8");
    const flow = source.slice(
      source.indexOf("async function startRecovery()"),
      source.indexOf("async function verifyAndResetPassword()")
    );
    const verifyIndex = flow.indexOf("await recoverDeviceAccount()");
    const statusIndex = flow.indexOf('"/auth/credentials/status"');
    const stageIndex = flow.indexOf("devicePinRecoveryStage(credentials.hasPin)");

    expect(verifyIndex).toBeGreaterThan(-1);
    expect(statusIndex).toBeGreaterThan(verifyIndex);
    expect(stageIndex).toBeGreaterThan(statusIndex);
    expect(flow).toContain("skipAuthRefresh: true");
    expect(flow).toContain("Identity verified. Create a 4-digit PIN.");
    expect(flow).toContain("Identity verified. Choose a new PIN.");
  });

  it("does not automatically retry a mutation after recovery authorization is lost", () => {
    const source = readFileSync("apps/web/src/PhoneFirstAuthentication.tsx", "utf8");
    const mutation = source.slice(
      source.indexOf("async function finishPinRecovery()"),
      source.indexOf("function goBack()")
    );

    expect(mutation).toContain('error.code === "device_credential_recovery_required"');
    expect(mutation).toContain('setStage("methods")');
    expect(mutation).toContain("Verify this device again before changing your PIN.");
    expect(mutation.match(/apiFetch<AuthSessionView>/gu)).toHaveLength(1);
  });
});
