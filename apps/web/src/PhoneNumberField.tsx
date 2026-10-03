import { useId, useState } from "react";
import {
  normalizePhoneInput,
  phoneNormalizationErrorMessage,
  type NormalizePhoneResult
} from "@grogoni/shared-types";
import { getCountryCallingCode, type CountryCode } from "libphonenumber-js";

export type PhoneValidationState = "empty" | "typing" | "valid" | "invalid";

export interface PhoneFieldState {
  selectedCountry: CountryCode;
  selectedCallingCode: string;
  rawNationalInput: string;
  normalizedE164: string | null;
  validationError: string | null;
}

export interface PhoneCountryOption {
  country: CountryCode;
  name: string;
  flag?: string;
}

export const authenticationPhoneCountries: PhoneCountryOption[] = [
  { country: "KE", name: "Kenya", flag: "🇰🇪" },
  { country: "UG", name: "Uganda", flag: "🇺🇬" },
  { country: "TZ", name: "Tanzania", flag: "🇹🇿" },
  { country: "RW", name: "Rwanda", flag: "🇷🇼" },
  { country: "NG", name: "Nigeria", flag: "🇳🇬" },
  { country: "ZA", name: "South Africa", flag: "🇿🇦" },
  { country: "GB", name: "United Kingdom", flag: "🇬🇧" },
  { country: "US", name: "United States", flag: "🇺🇸" }
];

interface PhoneNumberFieldProps {
  country: CountryCode;
  value: string;
  onCountryChange: (country: CountryCode) => void;
  onValueChange: (value: string) => void;
  onNormalizedChange?: (result: NormalizePhoneResult) => void;
  countries?: PhoneCountryOption[];
  label?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  error?: string;
  helpText?: string;
}

export function PhoneNumberField({
  country,
  value,
  onCountryChange,
  onValueChange,
  onNormalizedChange,
  countries = authenticationPhoneCountries,
  label = "Phone number",
  autoFocus = false,
  disabled = false,
  error: externalError,
  helpText
}: PhoneNumberFieldProps) {
  const id = useId();
  const [validationState, setValidationState] = useState<PhoneValidationState>(
    value.trim() ? "typing" : "empty"
  );
  const [internalError, setInternalError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState("");
  const error = externalError || internalError;
  const callingCode = getCountryCallingCode(country);

  function evaluate(rawValue = value, normalizeVisibleValue = true): NormalizePhoneResult {
    const result = normalizePhoneInput({
      rawInput: rawValue,
      selectedCountry: country,
      selectedCallingCode: callingCode
    });
    onNormalizedChange?.(result);
    if (!result.valid) {
      setValidationState(result.error === "EMPTY" ? "empty" : "invalid");
      setInternalError(phoneNormalizationErrorMessage(result.error));
      setPreview("");
      setNotice("");
      return result;
    }

    setValidationState("valid");
    setInternalError("");
    setNotice(
      result.adjustedDuplicatePrefix
        ? "The country code was included more than once. We adjusted the number."
        : ""
    );
    setPreview(result.internationalFormat);
    if (result.country !== country) onCountryChange(result.country);
    if (normalizeVisibleValue) onValueChange(result.nationalNumber);
    return result;
  }

  function handleCountryChange(nextCountry: CountryCode) {
    const current = normalizePhoneInput({
      rawInput: value,
      selectedCountry: country,
      selectedCallingCode: callingCode
    });
    const nationalValue = current.valid ? current.nationalNumber : value;
    onCountryChange(nextCountry);
    onValueChange(nationalValue);
    setValidationState(nationalValue.trim() ? "typing" : "empty");
    setInternalError("");
    setNotice("");
    setPreview("");
  }

  return (
    <div className="phone-number-field">
      <div className="phone-contact-row">
        <label htmlFor={`${id}-country`}>
          Country
          <select
            id={`${id}-country`}
            value={country}
            disabled={disabled}
            onChange={(event) => handleCountryChange(event.target.value as CountryCode)}
          >
            {countries.map((option) => (
              <option key={option.country} value={option.country}>
                {option.flag ? `${option.flag} ` : ""}+{getCountryCallingCode(option.country)}{" "}
                {option.name}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${id}-national`}>
          {label}
          <input
            id={`${id}-national`}
            autoFocus={autoFocus}
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            value={value}
            disabled={disabled}
            onChange={(event) => {
              const nextValue = event.target.value;
              onValueChange(nextValue);
              setPreview("");
              setNotice("");
              setValidationState(nextValue.trim() ? "typing" : "empty");
              if (/[^0-9+\s\-().]/u.test(nextValue) || nextValue.slice(1).includes("+")) {
                setInternalError("Use only digits, spaces, +, hyphens, or parentheses.");
              } else {
                setInternalError("");
              }
            }}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text");
              event.preventDefault();
              onValueChange(pasted);
              evaluate(pasted);
            }}
            onBlur={() => {
              if (value.trim()) evaluate();
            }}
            placeholder="e.g. 0712 345 678"
            aria-invalid={validationState === "invalid" || Boolean(externalError)}
            aria-describedby={
              error
                ? `${id}-error`
                : preview
                  ? `${id}-preview`
                  : helpText
                    ? `${id}-help`
                    : undefined
            }
          />
        </label>
      </div>
      {helpText ? (
        <p id={`${id}-help`} className="shell-note">
          {helpText}
        </p>
      ) : null}
      {preview ? (
        <p id={`${id}-preview`} className="shell-note">
          Full number: {preview}
        </p>
      ) : null}
      {notice ? (
        <p className="shell-note" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="setup-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
