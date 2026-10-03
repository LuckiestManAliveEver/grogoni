import type { CountryCode } from "libphonenumber-js";

import {
  type CountryDialCode,
  type SocialSignupProvider,
  countryDialCodes
} from "./grogoni-application-shared";

export function getCountryDialCode(countryCode: CountryDialCode) {
  return (
    countryDialCodes.find((item) => item.code === countryCode) ?? {
      code: "+254" as const,
      country: "Kenya",
      countryCode: "KE" as const,
      flag: "KE",
      suffixLength: 9
    }
  );
}

export function getCountryDialCodeByCountry(country: CountryCode) {
  return (
    countryDialCodes.find((item) => item.countryCode === country) ?? getCountryDialCode("+254")
  );
}

export function inferCountryCode(value: string): CountryDialCode | null {
  const normalized = value.trim().replace(/[\s-]/g, "");

  return countryDialCodes.find((item) => normalized.startsWith(item.code))?.code ?? null;
}

export function isCountryDialCode(value: unknown): value is CountryDialCode {
  return countryDialCodes.some((item) => item.code === value);
}

export function isSocialSignupProvider(value: unknown): value is SocialSignupProvider {
  return (
    value === "google" ||
    value === "facebook" ||
    value === "tiktok" ||
    value === "x" ||
    value === "apple" ||
    value === "github" ||
    value === "microsoft" ||
    value === "linkedin"
  );
}
