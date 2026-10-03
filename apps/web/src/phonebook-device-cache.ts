/**
 * The contacts the owner picked, with their raw numbers, kept on this device only so the invite
 * list survives a reload. The server stores hashes, never these numbers (see
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

/** Phone numbers compare by their last nine digits ("+254 722 000 101" = "0722000101"). */
export function destinationKey(channel: "phone" | "email", value: string): string {
  return channel === "phone"
    ? `phone:${value.replace(/\D/g, "").slice(-9)}`
    : `email:${value.trim().toLowerCase()}`;
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
