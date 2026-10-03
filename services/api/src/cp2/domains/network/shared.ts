import { createHash } from "node:crypto";
import {
  normalizeInternationalPhoneInput,
  normalizePhoneInput,
  type AccountSummary,
  type UserSummary
} from "@grogoni/shared-types";
import { getCountryCallingCode, isSupportedCountry, type CountryCode } from "libphonenumber-js";
import { normalizeDestination } from "../../phone-identity.js";
import { Cp2Error } from "../../cp2-error.js";
export { sanitizeNetworkNode } from "../../network-node-view.js";
export { providerDisplayName } from "../../public-identifiers.js";

/** Numbers and emails kept per contact; a phonebook entry rarely has more. */
export const maxDestinationsPerContact = 10;
/** Second-degree connections accepted per contact in one request. */
export const maxConnectionsPerContact = 50;

export interface NetworkImportConnectionInput {
  name: string;
  phone?: string | null | undefined;
  email?: string | null | undefined;
  /** Every number and email on the contact, in addition to `phone`/`email`. */
  phones?: string[] | undefined;
  emails?: string[] | undefined;
  providerSubject?: string | null | undefined;
  handle?: string | null | undefined;
}

export interface PhoneContactNetworkInput extends NetworkImportConnectionInput {
  connections?: NetworkImportConnectionInput[] | undefined;
}

export interface SocialProfileNetworkInput extends NetworkImportConnectionInput {
  relationship?: "followed" | "follower" | "interaction" | "message" | undefined;
  connections?: NetworkImportConnectionInput[] | undefined;
}

export interface NormalizedNetworkConnection extends NetworkImportConnectionInput {
  relationship?: SocialProfileNetworkInput["relationship"];
  connections?: NetworkImportConnectionInput[] | undefined;
  /** Normalized, deduplicated, invalid values dropped. `phone`/`email` are the first of each. */
  phones: string[];
  emails: string[];
}

/**
 * Normalizes one imported contact. Phonebooks are messy: numbers are usually stored in national
 * format ("0712 345 678"), so they are read in the owner's own country, and a number or email that
 * still does not parse is dropped from that contact rather than failing the whole sync.
 */
export function normalizeNetworkConnectionInput(
  value: NetworkImportConnectionInput & {
    relationship?: SocialProfileNetworkInput["relationship"];
    connections?: NetworkImportConnectionInput[] | undefined;
  },
  name: string,
  country: CountryCode | null = null
): NormalizedNetworkConnection {
  const displayName = value.name?.trim();

  if (displayName === undefined || displayName.length < 1) {
    throw new Cp2Error(400, "network_contact_name_required", `${name}.name is required.`);
  }

  const phones = uniqueDefined(
    [value.phone, ...(value.phones ?? [])].map((raw) =>
      typeof raw === "string" ? normalizeContactPhone(raw, country) : null
    )
  ).slice(0, maxDestinationsPerContact);
  const emails = uniqueDefined(
    [value.email, ...(value.emails ?? [])].map((raw) =>
      typeof raw === "string" ? normalizeContactEmail(raw) : null
    )
  ).slice(0, maxDestinationsPerContact);

  return {
    name: displayName,
    phone: phones[0] ?? null,
    email: emails[0] ?? null,
    phones,
    emails,
    providerSubject:
      value.providerSubject === undefined || value.providerSubject === null
        ? null
        : value.providerSubject.trim(),
    handle: value.handle === undefined || value.handle === null ? null : value.handle.trim(),
    relationship: value.relationship,
    connections: value.connections
  };
}

export function normalizeSocialRelationship(
  relationship: SocialProfileNetworkInput["relationship"] | undefined
): NonNullable<SocialProfileNetworkInput["relationship"]> {
  if (
    relationship === "followed" ||
    relationship === "follower" ||
    relationship === "interaction" ||
    relationship === "message"
  ) {
    return relationship;
  }

  return "followed";
}

export function createContactHash(
  hashType: "phone" | "email" | "social",
  rawValue: string
): string {
  const normalized =
    hashType === "phone"
      ? normalizeDestination("phone", rawValue)
      : hashType === "email"
        ? normalizeDestination("email", rawValue)
        : rawValue.trim().toLowerCase();
  return createHash("sha256").update(`${hashType}:${normalized}`).digest("hex");
}

/**
 * createContactHash for a value that is already canonical (E.164 phone, lowercased email), as
 * produced by normalizeContactPhone/normalizeContactEmail or stored on an account. Skips parsing
 * the number again, which costs far more than the hash itself when a whole phonebook, or every
 * account in the discovery index, is hashed.
 */
export function hashCanonicalContact(hashType: "phone" | "email", canonicalValue: string): string {
  return createHash("sha256").update(`${hashType}:${canonicalValue}`).digest("hex");
}

const canonicalPhonePattern = /^\+[1-9]\d{6,14}$/u;

/** hashCanonicalContact when the value is visibly canonical, createContactHash otherwise. */
export function hashStoredDestination(hashType: "phone" | "email", value: string): string {
  if (hashType === "phone" && canonicalPhonePattern.test(value)) {
    return hashCanonicalContact("phone", value);
  }
  if (hashType === "email" && value === value.trim().toLowerCase()) {
    return hashCanonicalContact("email", value);
  }
  return createContactHash(hashType, value);
}

export function createContactDisplayHint(rawValue: string): string | null {
  const normalized = rawValue.trim();

  if (normalized.length <= 4) {
    return null;
  }

  return normalized.slice(-4).padStart(Math.min(normalized.length, 6), "*");
}

/**
 * E.164 for a phonebook number, or null. National numbers are read in `country` (the owner's);
 * numbers with an international prefix parse on their own.
 */
export function normalizeContactPhone(raw: string, country: CountryCode | null): string | null {
  const trimmed = cleanPhonebookNumber(raw);
  if (trimmed.length === 0) return null;

  if (country !== null) {
    const local = normalizePhoneInput({
      rawInput: trimmed,
      selectedCountry: country,
      selectedCallingCode: getCountryCallingCode(country)
    });
    if (local.valid) return local.e164;
  }

  const international = normalizeInternationalPhoneInput(trimmed);
  return international.valid ? international.e164 : null;
}

export function normalizeContactEmail(raw: string): string | null {
  try {
    return normalizeDestination("email", raw);
  } catch {
    return null;
  }
}

/**
 * Phonebook entries carry more than the number: invisible direction marks copied from chat apps,
 * a "tel:" prefix from vCards, extensions, labels such as "(mobile)", full-width digits from some
 * keyboards. Reduce the value to what a phone parser accepts.
 */
export function cleanPhonebookNumber(raw: string): string {
  return (
    raw
      .normalize("NFKC")
      // Any script's decimal digits (Arabic-Indic, Devanagari, ...) to ASCII, and every dash or
      // minus sign to a hyphen: phone keyboards and copy-paste produce all of them.
      .replace(/\p{Nd}/gu, (digit) => String(asciiDigit(digit)))
      .replace(/[\p{Pd}\u2212]/gu, "-")
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu, "")
      .replace(/^\s*tel:/iu, "")
      // One field holding two numbers ("0711 000 002 / 0722 000 003"): keep the first.
      .split(/[;,|]|\s\/\s|\sand\s|\sor\s/iu)[0]!
      .replace(/\s*(?:ext\.?|extension|x|#)\s*\d+\s*$/iu, "")
      .replace(/\([^)]*\p{L}[^)]*\)/gu, " ")
      .replace(/^[^+\d(]*/u, "")
      .replace(/[^\d)]+$/u, "")
      .replace(/[./]/gu, " ")
      .trim()
  );
}

/**
 * The country to read the owner's national-format phonebook numbers in: their stored phone
 * country, else the country of their own number, else `fallback` (the device's region, sent by the
 * client). Null when none is known; then only numbers with an international prefix parse.
 */
export function ownerPhoneCountry(
  actor: { user: UserSummary; account: AccountSummary },
  fallback: string | null = null
): CountryCode | null {
  const declared = actor.user.phoneCountryCode?.trim().toUpperCase();
  if (declared !== undefined && isSupportedCountry(declared)) return declared;

  for (const candidate of [
    actor.user.phoneNumberE164,
    actor.account.primaryAuthChannel === "phone" ? actor.account.primaryAuthDestination : null
  ]) {
    if (candidate === null || candidate === undefined) continue;
    const parsed = normalizeInternationalPhoneInput(candidate);
    if (parsed.valid) return parsed.country;
  }

  const region = fallback?.trim().toUpperCase();
  return region !== undefined && isSupportedCountry(region) ? region : null;
}

function uniqueDefined(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

/**
 * The value of a Unicode decimal digit. Every script encodes its digits as a run of ten from 0 to
 * 9, and some runs sit back to back, so: distance from the start of the contiguous run, mod 10.
 */
function asciiDigit(digit: string): number {
  const code = digit.codePointAt(0)!;
  let start = code;
  while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
  return (code - start) % 10;
}
