import { describe, expect, it } from "vitest";
import { normalizePhoneInput } from "../packages/shared-types/src/phone-number";
import { normalizeOwnerPhoneInput } from "../apps/web/src/phone-identity";
import {
  maskPhoneNumber,
  normalizeInternationalOwnerPhoneNumber,
  normalizeOwnerPhoneNumber
} from "../services/api/src/cp2/phone-identity";
import { createCp2Store, normalizeDestination } from "../services/api/src/cp2/store";

describe("owner phone identity normalization", () => {
  it.each([
    "712345678",
    "0712345678",
    "254712345678",
    "+254712345678",
    "00254712345678",
    "+254 712 345 678",
    "254 712 345 678"
  ])("normalizes Kenyan input %s without duplicating the calling code", (input) => {
    expect(normalizeOwnerPhoneInput(input, "KE")).toBe("+254712345678");
    expect(normalizeOwnerPhoneNumber(input, "KE")).toMatchObject({
      country: "KE",
      e164: "+254712345678",
      nationalNumber: "712345678"
    });
  });

  it.each(["254254712345678", "+254254712345678", "+254+254712345678"])(
    "safely collapses an unambiguous duplicate prefix in %s",
    (input) => {
      const normalized = normalizePhoneInput({
        rawInput: input,
        selectedCountry: "KE",
        selectedCallingCode: "254"
      });
      expect(normalized).toMatchObject({
        valid: true,
        e164: "+254712345678",
        adjustedDuplicatePrefix: true
      });
      expect(normalizeOwnerPhoneNumber(input, "KE").e164).toBe("+254712345678");
      expect(normalizeInternationalOwnerPhoneNumber(input).e164).toBe("+254712345678");
    }
  );

  it("rejects empty and invalid values with structured reasons", () => {
    expect(() => normalizeOwnerPhoneInput("", "KE")).toThrow(
      "Enter your phone number to continue."
    );
    expect(() => normalizeOwnerPhoneInput("123", "KE")).toThrow("too short");
    for (const input of ["abc", "+254abc123", "++++254712345678", "+254"]) {
      expect(
        normalizePhoneInput({
          rawInput: input,
          selectedCountry: "KE",
          selectedCallingCode: "254"
        }).valid
      ).toBe(false);
    }
  });

  it("detects a foreign international paste and synchronizes to Uganda", () => {
    expect(
      normalizePhoneInput({
        rawInput: "+256772123456",
        selectedCountry: "KE",
        selectedCallingCode: "254"
      })
    ).toMatchObject({
      valid: true,
      country: "UG",
      callingCode: "256",
      nationalNumber: "772123456",
      e164: "+256772123456"
    });
    expect(normalizeOwnerPhoneNumber("+256772123456", "KE")).toMatchObject({
      country: "UG",
      e164: "+256772123456"
    });
  });

  it("reparses national digits under a changed selector", () => {
    const kenya = normalizePhoneInput({
      rawInput: "712345678",
      selectedCountry: "KE",
      selectedCallingCode: "254"
    });
    const uganda = normalizePhoneInput({
      rawInput: kenya.valid ? kenya.nationalNumber : "",
      selectedCountry: "UG",
      selectedCallingCode: "256"
    });
    expect(kenya).toMatchObject({ valid: true, e164: "+254712345678" });
    expect(uganda).toMatchObject({ valid: true, e164: "+256712345678" });
  });

  it("uses E.164 for legacy account lookup and never keeps duplicated prefixes", () => {
    const store = createCp2Store();
    const signup = store.signupWithPhonePin({ destination: "+254712345678", pin: "3927" });
    const login = store.loginWithAccountPin({
      channel: "phone",
      destination: "+254254712345678",
      pin: "3927"
    });
    expect(login.account.id).toBe(signup.account.id);
    expect(normalizeDestination("phone", "254254712345678")).toBe("+254712345678");
  });

  it("masks phone numbers before they enter audit metadata", () => {
    const phone = "+254712345678";
    const masked = maskPhoneNumber(phone);

    expect(masked).toBe("+254******678");
    expect(masked).not.toContain(phone);
  });
});
