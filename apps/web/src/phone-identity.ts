import { normalizePhoneInput, phoneNormalizationErrorMessage } from "@grogoni/shared-types";
import { getCountryCallingCode, type CountryCode } from "libphonenumber-js";

export function normalizeOwnerPhoneInput(phoneNumber: string, country: CountryCode): string {
  const result = normalizePhoneInput({
    rawInput: phoneNumber,
    selectedCountry: country,
    selectedCallingCode: getCountryCallingCode(country)
  });
  if (!result.valid) throw new Error(phoneNormalizationErrorMessage(result.error));
  return result.e164;
}
