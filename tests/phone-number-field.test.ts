import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("shared phone-number field", () => {
  const source = readFileSync("apps/web/src/PhoneNumberField.tsx", "utf8");

  it("uses accessible telephone semantics and normalizes at paste and blur boundaries", () => {
    expect(source).toContain('type="tel"');
    expect(source).toContain('inputMode="tel"');
    expect(source).toContain('autoComplete="tel-national"');
    expect(source).toContain("onPaste=");
    expect(source).toContain("onBlur=");
    expect(source).toContain('role="alert"');
    expect(source).toContain("normalizePhoneInput");
  });

  it("is reused by every authentication and owner identity surface", () => {
    const phoneFirst = readFileSync("apps/web/src/PhoneFirstAuthentication.tsx", "utf8");
    const phoneSignup = readFileSync("apps/web/src/PhoneSignup.tsx", "utf8");
    const application = readFileSync("apps/web/src/GrogoniApplication.tsx", "utf8");
    const businessSetupPanel = readFileSync("apps/web/src/BusinessSetupPanel.tsx", "utf8");
    const identitySecurityPanel = readFileSync("apps/web/src/IdentitySecurityPanel.tsx", "utf8");
    expect(phoneFirst).toContain("<PhoneNumberField");
    expect(phoneSignup).toContain("<PhoneNumberField");
    const ownerUsageCount =
      (application.match(/<PhoneNumberField/gu) ?? []).length +
      (businessSetupPanel.match(/<PhoneNumberField/gu) ?? []).length +
      (identitySecurityPanel.match(/<PhoneNumberField/gu) ?? []).length;
    expect(ownerUsageCount).toBe(2);
    expect(application).not.toContain("function SetupPanel");
    expect(application).not.toContain("function LoginPanel");
    expect(application).not.toContain("return `${countryCode}${phone}`");
  });
});
