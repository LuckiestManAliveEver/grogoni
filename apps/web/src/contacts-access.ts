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
