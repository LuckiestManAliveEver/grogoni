import { isSupportedCountry } from "libphonenumber-js";
import { canonicalDeviceContactPhone } from "./phonebook-device-cache";

/** Phonebook entries from the Android host. Matching is display-only; nothing is uploaded. */
export interface DeviceContact {
  name: string;
  phone: string;
  /** E.164 recorded by Android when the contact was saved, in the country in force then. */
  normalized?: string | null;
}

export interface DevicePhonebook {
  contacts: DeviceContact[];
  /** ISO country of the phone's network or SIM for local numbers like 0712 345 678. Null when unknown. */
  country: string | null;
}

/**
 * Full E.164 identity, so +254 712 345 678 and 0712345678 (on a Kenyan SIM) match while
 * +256 712 345 678 does not. Without a known country a local number cannot be read, so only
 * international numbers normalize. Short codes match on their exact digits; a sender ID with
 * letters matches only its exact text, so "KCB40404" never takes the name saved for 40404.
 */
export function contactKey(value: string, country: string | null): string {
  const text = value.trim();
  const e164 =
    country || text.startsWith("+")
      ? canonicalDeviceContactPhone(text, country ?? undefined)
      : null;
  if (e164) return e164;
  return /^[\d\s()+.-]+$/.test(text)
    ? `raw:${text.startsWith("+") ? "+" : ""}${text.replace(/\D/g, "")}`
    : `text:${text.toLowerCase()}`;
}

export function parseDevicePhonebook(value: unknown): DevicePhonebook {
  const source = value as { contacts?: unknown; country?: unknown } | null;
  const code = typeof source?.country === "string" ? source.country.toUpperCase() : "";
  // An unsupported code would otherwise fall back to the app default and read numbers as Kenyan.
  const country = isSupportedCountry(code) ? code : null;
  const list = Array.isArray(source?.contacts) ? source.contacts : [];
  const contacts = list.filter(
    (entry): entry is DeviceContact =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as DeviceContact).name === "string" &&
      typeof (entry as DeviceContact).phone === "string" &&
      /\d/.test((entry as DeviceContact).phone)
  );
  return { contacts, country };
}

export function buildContactIndex(phonebook: DevicePhonebook): Map<string, string> {
  const index = new Map<string, string>();
  for (const contact of phonebook.contacts) {
    // Prefer Android's saved form: a local number read with today's SIM may be the wrong country.
    const saved = contact.normalized?.startsWith("+") ? contact.normalized : contact.phone;
    const key = contactKey(saved, phonebook.country);
    if (!index.has(key)) index.set(key, contact.name);
  }
  return index;
}

/** "Amina Otieno (+254712345678)" when the number is in the phonebook, otherwise the number. */
export function contactLabel(
  address: string,
  index: Map<string, string>,
  country: string | null
): string {
  const name = index.get(contactKey(address, country));
  return name ? `${name} (${address})` : address;
}

/** The recipient being typed: MMS groups separate numbers with commas or semicolons. */
function currentRecipient(input: string): string {
  return input.split(/[,;]/).pop()!.trim();
}

export interface ContactSuggestion {
  name: string;
  /** Exact number to send to. Never a local form: Android would read it in the visited country. */
  destination: string;
}

/** Android's saved E.164 first, then the number read in the SIM's country, then the text as saved. */
export function contactDestination(contact: DeviceContact, country: string | null): string {
  if (contact.normalized?.startsWith("+")) return contact.normalized;
  return (country && canonicalDeviceContactPhone(contact.phone, country)) || contact.phone;
}

/** Phonebook matches for what is being typed, by name or by digits in either saved form. */
export function suggestContacts(
  contacts: DeviceContact[],
  input: string,
  country: string | null,
  limit = 6
): ContactSuggestion[] {
  const typed = currentRecipient(input);
  const query = typed.toLowerCase();
  if (query.length < 2) return [];
  const digits = /^[\d\s()+.-]+$/.test(query) ? query.replace(/\D/g, "") : "";
  const trunkless = digits.replace(/^0/, "");
  const found = new Map<string, ContactSuggestion>();
  for (const contact of contacts) {
    if (found.size === limit) break;
    const saved = `${contact.phone}|${contact.normalized ?? ""}`.replace(/[^\d|]/g, "");
    const matches =
      contact.name.toLowerCase().includes(query) ||
      (digits.length >= 2 &&
        (saved.includes(digits) || (trunkless.length >= 3 && saved.includes(trunkless))));
    if (!matches) continue;
    const destination = contactDestination(contact, country);
    // A local form with no known country cannot be sent safely: Android would read it wherever
    // the phone happens to be. Short codes are the same everywhere.
    const sendable = destination.startsWith("+") || destination.replace(/\D/g, "").length <= 6;
    if (sendable && destination !== typed && !found.has(destination))
      found.set(destination, { name: contact.name, destination });
  }
  return [...found.values()];
}

/**
 * Where a reply goes: the same identity the label shows. A sender stored in local form is sent
 * as E.164, because Android would otherwise read it in the visited country while roaming.
 */
export function replyDestination(address: string, country: string | null): string {
  const key = contactKey(address, country);
  return key.startsWith("+") ? key : address;
}

/** Replaces only the recipient being typed, keeping earlier group members. */
export function applySuggestion(input: string, destination: string): string {
  const cut = Math.max(input.lastIndexOf(","), input.lastIndexOf(";"));
  return cut < 0 ? destination : `${input.slice(0, cut + 1)} ${destination}`;
}
