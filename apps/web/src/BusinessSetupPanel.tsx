import { useState } from "react";

import type { CountryCode } from "libphonenumber-js";

import { normalizeOwnerPhoneInput } from "./phone-identity";
import { PhoneNumberField } from "./PhoneNumberField";

import { AuthenticationActionMessage } from "./AuthenticationActionMessage";

import {
  type CountryDialCode,
  type SupportedLanguage,
  phoneCountryOptions
} from "./grogoni-application-shared";

import { getCountryDialCode, getCountryDialCodeByCountry } from "./country-dial-codes";

import { getErrorMessage } from "./chat-message-plumbing";

export interface BusinessSetupPanelProps {
  step: "phone" | "details";
  businessName: string;
  language: SupportedLanguage;
  phoneCountryCode: CountryDialCode;
  phoneNumber: string;
  statusMessage: string;
  isPending: boolean;
  onBusinessNameChange: (businessName: string) => void;
  onLanguageChange: (language: SupportedLanguage) => void;
  onPhoneCountryCodeChange: (countryCode: CountryDialCode) => void;
  onPhoneNumberChange: (phoneNumber: string) => void;
  onContinuePhone: (phoneNumber: string, country: CountryCode) => void;
  onEditPhone: () => void;
  onBackToLoginOptions: () => void;
  onCancel: () => void;
  onCreateBusiness: () => void;
}

export function BusinessSetupPanel(props: BusinessSetupPanelProps) {
  const [phoneError, setPhoneError] = useState("");

  function continueWithPhone() {
    const selectedCountry = getCountryDialCode(props.phoneCountryCode);

    try {
      const normalizedPhone = normalizeOwnerPhoneInput(
        props.phoneNumber,
        selectedCountry.countryCode
      );
      setPhoneError("");
      props.onPhoneNumberChange(normalizedPhone);
      props.onContinuePhone(normalizedPhone, selectedCountry.countryCode);
    } catch (error) {
      setPhoneError(getErrorMessage(error));
    }
  }

  if (props.step === "phone") {
    const selectedCountry = getCountryDialCode(props.phoneCountryCode);

    return (
      <main className="setup-grid business-setup-grid">
        <section className="panel auth-card">
          <div className="section-heading">
            <p className="eyebrow">FIRST SHOP REGISTRATION</p>
            <h2>Add your phone number</h2>
            <p>
              Add a phone number for shop identity, account recovery, and last-resort customer
              support. This number will not be shown publicly unless you choose to display it in
              your shop settings.
            </p>
          </div>
          <PhoneNumberField
            autoFocus
            country={selectedCountry.countryCode}
            countries={phoneCountryOptions}
            value={props.phoneNumber}
            error={phoneError}
            helpText="Your phone number is required to register and recover your shop."
            onCountryChange={(country) => {
              props.onPhoneCountryCodeChange(getCountryDialCodeByCountry(country).code);
              setPhoneError("");
            }}
            onValueChange={(value) => {
              props.onPhoneNumberChange(value);
              setPhoneError("");
            }}
          />
          <div className="compact-actions">
            <button
              type="button"
              onClick={continueWithPhone}
              disabled={props.phoneNumber.trim().length === 0 || props.isPending}
              aria-busy={props.isPending}
            >
              {props.isPending ? "Saving…" : "Continue"}
            </button>
            <button className="secondary" type="button" onClick={props.onBackToLoginOptions}>
              Back to login options
            </button>
          </div>
          <p className="setup-status" role="status" aria-live="polite">
            <AuthenticationActionMessage message={props.statusMessage} />
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="setup-grid business-setup-grid">
      <section className="panel auth-card">
        <div className="section-heading">
          <p className="eyebrow">Start selling</p>
          <h2>Set up your business</h2>
          <p>
            Create your shop once using your signed-in account. You can update these details later.
          </p>
        </div>
        <label>
          Business name
          <input
            autoFocus
            value={props.businessName}
            onChange={(event) => props.onBusinessNameChange(event.target.value)}
            placeholder="Your business name"
          />
        </label>
        <label>
          Language
          <select
            value={props.language}
            onChange={(event) => props.onLanguageChange(event.target.value as SupportedLanguage)}
          >
            <option value="en">English</option>
            <option value="sw">Swahili</option>
          </select>
        </label>
        <div className="compact-actions">
          <button
            type="button"
            onClick={props.onCreateBusiness}
            disabled={!props.businessName.trim() || props.isPending}
            aria-busy={props.isPending}
          >
            {props.isPending ? "Creating…" : "Create business"}
          </button>
          <button className="secondary" type="button" onClick={props.onCancel}>
            Not now
          </button>
          <button className="secondary" type="button" onClick={props.onEditPhone}>
            Edit phone number
          </button>
        </div>
        <p className="setup-status" role="status" aria-live="polite">
          <AuthenticationActionMessage message={props.statusMessage} />
        </p>
      </section>
    </main>
  );
}
