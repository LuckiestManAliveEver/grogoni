import { normalizePhoneInput } from "@grogoni/shared-types";
import { getCountryCallingCode, isSupportedCountry, type CountryCode } from "libphonenumber-js";

/**
 * The contacts the owner picked, with their raw numbers, kept on this device only so the invite
 * list survives a reload. Selected numbers are transmitted over HTTPS for server matching; persisted server records use keyed hashes rather than these numbers (see
 * docs/architecture/phonebook-identity-resolution.md). Scoped per Grogoni user and cleared on
 * logout. Storage can be missing or throw (private window, blocked site data): every access
 * degrades to "nothing cached".
 */
const storagePrefix = "grogoni.phonebook.v1:";

export interface DevicePhonebookContact {
  name: string;
  phone: string | null;
  email: string | null;
  /** The server phonebook node this contact landed on at its last sync. */
  nodeId: string | null;
}

export function devicePhonebookContactKey(contact: {
  name: string;
  phone: string | null;
  email: string | null;
}): string {
  if (contact.phone !== null) return destinationKey("phone", contact.phone);
  if (contact.email !== null) return destinationKey("email", contact.email);
  return `name:${contact.name.trim().toLowerCase()}`;
}

/**
 * Merges newly picked contacts into the device copy: the picker returns only the selection, so a
 * sync adds to what the owner picked before instead of replacing it. A re-picked contact takes
 * the new name and node.
 */
export function mergeDevicePhonebook(
  existing: DevicePhonebookContact[],
  added: DevicePhonebookContact[]
): DevicePhonebookContact[] {
  const merged = new Map(existing.map((contact) => [devicePhonebookContactKey(contact), contact]));
  for (const contact of added) {
    merged.set(devicePhonebookContactKey(contact), contact);
  }
  return [...merged.values()];
}

/** Normalize the complete identity; never merge different country codes by a digit suffix. */
export function canonicalDeviceContactPhone(value: string, defaultCountry = "KE"): string | null {
  const country: CountryCode = isSupportedCountry(defaultCountry) ? defaultCountry : "KE";
  const normalized = normalizePhoneInput({
    rawInput: value,
    selectedCountry: country,
    selectedCallingCode: getCountryCallingCode(country)
  });
  return normalized.valid ? normalized.e164 : null;
}

export function destinationKey(
  channel: "phone" | "email",
  value: string,
  defaultCountry = "KE"
): string {
  if (channel === "email") return `email:${value.trim().toLowerCase()}`;
  const canonical = canonicalDeviceContactPhone(value, defaultCountry);
  return canonical
    ? `phone:${canonical}`
    : `phone:unparsed:${value.trim().replace(/[\s().-]/gu, "")}`;
}

export function readDevicePhonebook(userId: string): DevicePhonebookContact[] {
  try {
    const raw = localStorage.getItem(storagePrefix + userId);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isDevicePhonebookContact) : [];
  } catch {
    return [];
  }
}

export function writeDevicePhonebook(userId: string, contacts: DevicePhonebookContact[]): void {
  try {
    localStorage.setItem(storagePrefix + userId, JSON.stringify(contacts));
  } catch {
    // Quota or blocked storage: the list still works for this session.
  }
}

export function clearDevicePhonebooks(): void {
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(storagePrefix)) localStorage.removeItem(key);
    }
  } catch {
    // Nothing stored, nothing to clear.
  }
}

function isDevicePhonebookContact(value: unknown): value is DevicePhonebookContact {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const nullableString = (field: unknown) => field === null || typeof field === "string";
  return (
    typeof record.name === "string" &&
    nullableString(record.phone) &&
    nullableString(record.email) &&
    nullableString(record.nodeId)
  );
}
