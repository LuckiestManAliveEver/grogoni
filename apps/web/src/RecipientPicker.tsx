import { useState } from "react";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { ConversationInboxItem } from "@grogoni/shared-types";
import { deviceContactsAdapter, type ContactsAccessAdapter } from "./contacts-access";
import { conversationTitle } from "./conversation-title";
import type { DevicePhonebookContact } from "./phonebook-device-cache";

export function normalizedRecipient(input: string): string | null {
  const text = input.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text)) return text.toLowerCase();
  const number = parsePhoneNumberFromString(/^254\d{9}$/u.test(text) ? `+${text}` : text, "KE");
  return number?.isValid() ? number.number : null;
}

/** Contacts stay on this device; choosing a recipient never synchronizes the phonebook. */
export function RecipientPicker({
  contacts,
  recent,
  onChoose,
  onOpen,
  onSms,
  onClose,
  adapter = deviceContactsAdapter
}: {
  contacts: readonly DevicePhonebookContact[];
  recent: readonly ConversationInboxItem[];
  onChoose: (recipient: string, name: string) => void;
  onOpen: (id: string) => void;
  onSms: (recipient: string, name: string) => void;
  onClose: () => void;
  adapter?: ContactsAccessAdapter;
}) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<DevicePhonebookContact[]>([]);
  const [notice, setNotice] = useState("");
  const [choosing, setChoosing] = useState(false);
  const destination = normalizedRecipient(search);
  const query = search.trim().toLowerCase();
  const digits = query.replace(/\D/gu, "");
  async function chooseContacts() {
    setChoosing(true);
    try {
      const selection = await adapter.select();
      setPicked(
        selection.map((contact) => ({
          name: contact.name?.[0] ?? "Contact",
          phone: contact.tel?.[0] ?? null,
          email: contact.email?.[0] ?? null,
          nodeId: null,
          phones: (contact.tel ?? []).flatMap((phone) => {
            const e164 = normalizedRecipient(phone);
            return e164 && !e164.includes("@") ? [{ e164, label: "Phone" }] : [];
          })
        }))
      );
      setNotice(
        selection.length
          ? "Choose a number below. Contacts remain on this device."
          : "No contacts selected."
      );
    } catch {
      setNotice(
        "Contacts could not be opened. You can enter a number or email here, or enable contacts access in your browser or device settings."
      );
    } finally {
      setChoosing(false);
    }
  }
  return (
    <section className="recipient-picker" aria-label="New message recipient">
      <h3>New message</h3>
      <label>
        Name, phone number or email
        <input
          autoFocus
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <button type="button" disabled={choosing} onClick={() => void chooseContacts()}>
        Choose from contacts
      </button>
      {notice && <p role="status">{notice}</p>}
      {destination ? (
        <div>
          <p>{destination}</p>
          <small>Grogoni messages use end-to-end encryption. SMS uses your carrier.</small>
          <button type="button" onClick={() => onChoose(destination, "")}>
            Open Grogoni chat
          </button>
          {!destination.includes("@") && (
            <button type="button" onClick={() => onSms(destination, "")}>
              Send as SMS
            </button>
          )}
        </div>
      ) : (
        search.trim() && (
          <p role="status">Choose a contact or enter a valid full phone number or email.</p>
        )
      )}
      <h4>Recent conversations</h4>
      {recent
        .filter(
          (item) => !item.helpTopic && (conversationTitle(item) ?? "").toLowerCase().includes(query)
        )
        .slice(0, 12)
        .map((item) => (
          <button type="button" key={item.id} onClick={() => onOpen(item.id)}>
            {conversationTitle(item) ?? "Conversation"}
          </button>
        ))}
      <h4>Contacts</h4>
      {[...contacts, ...picked]
        .filter(
          (contact) =>
            contact.name.toLowerCase().includes(query) ||
            (digits.length > 0 &&
              (contact.phones ?? (contact.phone ? [{ e164: contact.phone }] : [])).some((phone) =>
                phone.e164.replace(/\D/gu, "").includes(digits)
              ))
        )
        .slice(0, 100)
        .map((contact, index) => (
          <div key={`${contact.name}:${index}`}>
            <strong>{contact.name}</strong>
            {(contact.phones?.length
              ? contact.phones
              : contact.phone
                ? [{ e164: contact.phone, label: "Phone" }]
                : []
            ).map((phone) => (
              <button
                type="button"
                key={phone.e164}
                onClick={() => {
                  const value = normalizedRecipient(phone.e164);
                  if (value) onChoose(value, contact.name);
                }}
              >
                {phone.label}: {phone.e164}
              </button>
            ))}
            {contact.email && (
              <button
                type="button"
                onClick={() => onChoose(contact.email!.toLowerCase(), contact.name)}
              >
                {contact.email}
              </button>
            )}
          </div>
        ))}
      <button type="button" onClick={onClose}>
        Cancel
      </button>
    </section>
  );
}
