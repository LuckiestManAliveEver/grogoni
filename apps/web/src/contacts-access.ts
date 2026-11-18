import { deviceMessagingAdapter, isNativeDeviceHost } from "./device-messaging";
import { contactDestination, parseDevicePhonebook } from "./device-contacts";
import type { ContactPickerContact, ContactPickerNavigator } from "./grogoni-application-shared";
import { parseVcardContacts } from "./phonebook-vcard";
import { parseContactImportContent } from "./contacts-import";

/** Native hosts can supply this contract without changing contact matching, consent, or storage. */
export interface ContactsAccessAdapter {
  readonly source: "browser" | "native";
  isSupported(): boolean;
  /** Must only be called from an explicit user action. Returns only the authorized selection. */
  select(): Promise<ContactPickerContact[]>;
}

export const browserContactsAdapter: ContactsAccessAdapter = {
  source: "browser",
  isSupported: () =>
    typeof navigator !== "undefined" &&
    typeof (navigator as ContactPickerNavigator).contacts?.select === "function",
  async select() {
    const picker = (navigator as ContactPickerNavigator).contacts;
    if (!picker?.select) throw new Error("Import a vCard or CSV contacts file on this browser.");
    return picker.select(["name", "tel", "email"], { multiple: true });
  }
};

export async function readContactsFile(file: File): Promise<ContactPickerContact[]> {
  const content = await file.text();
  return (
    parseVcardContacts(content) ??
    parseContactImportContent(content).map((record) => ({
      name: [record.name],
      tel: record.phone.trim() ? [record.phone] : [],
      email: record.email.trim() ? [record.email] : []
    }))
  );
}

/** Native reads are available only after a deliberate contact-picker gesture and permission. */
export const deviceContactsAdapter: ContactsAccessAdapter = {
  source: "native",
  isSupported: () => isNativeDeviceHost() || browserContactsAdapter.isSupported(),
  async select() {
    if (!isNativeDeviceHost()) return browserContactsAdapter.select();
    await deviceMessagingAdapter.call("requestPermissionGroup", { id: "contacts" });
    const phonebook = parseDevicePhonebook(await deviceMessagingAdapter.call("listContacts"));
    // The bridge returns one row per phone and no stable contact ID. Keep those rows
    // separate so two people with the same display name are never merged.
    return phonebook.contacts.map((contact) => ({
      name: [contact.name],
      tel: [contactDestination(contact, phonebook.country)]
    }));
  }
};
