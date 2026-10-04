import { useEffect, useState } from "react";
import type { CanonicalContactSummary, ContactSource } from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { useApiMutationRevision } from "./hooks/useApiMutationRevision";
import { deleteJson, getJson, postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";

const contactSources: ContactSource[] = [
  "MANUAL",
  "PHONEBOOK",
  "EMAIL",
  "SOCIAL",
  "GROGONI_ACCOUNT"
];

interface NewContactDraft {
  displayName: string;
  phone: string;
  email: string;
  source: ContactSource;
}

const emptyDraft: NewContactDraft = {
  displayName: "",
  phone: "",
  email: "",
  source: "MANUAL"
};

function draftToContactPayload(draft: NewContactDraft) {
  return {
    displayName: draft.displayName.trim(),
    phones: draft.phone.trim() ? [draft.phone.trim()] : [],
    emails: draft.email.trim() ? [draft.email.trim()] : [],
    source: draft.source
  };
}

// Self-contained management card for the canonical, multi-source contact model added by the
// "contact-synced supplier, purchase, sale, and route history" backend change. Mirrors
// SupplierManagementCard's shape: fetches its own data from businessId alone, does not depend on
// useNetworkState/NetworkNodeSummary (that is a separate, narrower, phone-contact-only concept -
// see docs/frontend/frontend.md's "Network capability (Phase 4g)" section). Placed alongside the
// existing Network surface as a clearly separate section, not merged with it.
export default function CanonicalContactsCard(props: { businessId: string; contactId?: string }) {
  const contactsPath = `/businesses/${props.businessId}/contacts`;
  const mutationRevision = useApiMutationRevision(contactsPath);
  const { isPending, runAction } = useAsyncActions();
  const [contacts, setContacts] = useState<CanonicalContactSummary[] | null>(null);
  const [message, setMessage] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<NewContactDraft>(emptyDraft);
  const [openContactId, setOpenContactId] = useState<string | null>(props.contactId ?? null);
  const [linkAccountDrafts, setLinkAccountDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void getJson<CanonicalContactSummary[]>(contactsPath)
      .then((loaded) => {
        if (!cancelled) setContacts(loaded);
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [contactsPath, mutationRevision]);

  async function submitContact(endpoint: "import" | "sync") {
    if (addDraft.displayName.trim().length === 0) {
      setMessage("Enter a contact name.");
      return;
    }
    const result = await postJson<{
      contacts: CanonicalContactSummary[];
      created: number;
      updated: number;
    }>(`${contactsPath}/${endpoint}`, {
      contacts: [draftToContactPayload(addDraft)],
      source: addDraft.source
    });
    setContacts((current) => {
      const rest = (current ?? []).filter(
        (contact) => !result.contacts.some((updated) => updated.id === contact.id)
      );
      return [...result.contacts, ...rest];
    });
    setAddDraft(emptyDraft);
    setIsAdding(false);
    setMessage(
      endpoint === "sync"
        ? `Synced ${result.created} new, ${result.updated} updated`
        : `Imported ${result.created} new, ${result.updated} updated`
    );
  }

  async function linkAccount(contact: CanonicalContactSummary) {
    const accountId = (linkAccountDrafts[contact.id] ?? "").trim();
    if (accountId.length === 0) {
      setMessage("Enter a Grogoni account id to link.");
      return;
    }
    const updated = await postJson<CanonicalContactSummary>(`${contactsPath}/${contact.id}/link`, {
      accountId
    });
    setContacts((current) =>
      (current ?? []).map((item) => (item.id === updated.id ? updated : item))
    );
    setLinkAccountDrafts((current) => ({ ...current, [contact.id]: "" }));
    setMessage(`${updated.displayName} linked to account`);
  }

  async function unlinkAccount(contact: CanonicalContactSummary) {
    const updated = await deleteJson<CanonicalContactSummary>(`${contactsPath}/${contact.id}/link`);
    setContacts((current) =>
      (current ?? []).map((item) => (item.id === updated.id ? updated : item))
    );
    setMessage(`${updated.displayName} unlinked`);
  }

  if (contacts === null) {
    return (
      <section className="record-form canonical-contacts-card" aria-label="Contacts">
        {message.length > 0 ? <p className="shell-note">{message}</p> : <p>Loading contacts…</p>}
      </section>
    );
  }

  return (
    <section className="record-form canonical-contacts-card" aria-label="Manage contacts">
      <div className="section-heading">
        <p className="eyebrow">Contacts</p>
        <h3>Contact directory</h3>
        <p className="shell-note">
          Contacts merged from phonebook, email, social, manual entry, and Grogoni accounts.
        </p>
      </div>
      {message.length > 0 ? <p className="shell-note">{message}</p> : null}
      <div className="row-actions">
        <button type="button" onClick={() => setIsAdding((open) => !open)}>
          {isAdding ? "Cancel" : "Add contact"}
        </button>
      </div>
      {isAdding ? (
        <div className="canonical-contact-item">
          <label>
            Name
            <input
              value={addDraft.displayName}
              onChange={(event) =>
                setAddDraft((current) => ({ ...current, displayName: event.target.value }))
              }
            />
          </label>
          <label>
            Phone
            <input
              value={addDraft.phone}
              onChange={(event) =>
                setAddDraft((current) => ({ ...current, phone: event.target.value }))
              }
            />
          </label>
          <label>
            Email
            <input
              value={addDraft.email}
              onChange={(event) =>
                setAddDraft((current) => ({ ...current, email: event.target.value }))
              }
            />
          </label>
          <label>
            Source
            <select
              value={addDraft.source}
              onChange={(event) =>
                setAddDraft((current) => ({
                  ...current,
                  source: event.target.value as ContactSource
                }))
              }
            >
              {contactSources.map((source) => (
                <option key={source} value={source}>
                  {source}
                </option>
              ))}
            </select>
          </label>
          <div className="row-actions">
            <button
              type="button"
              disabled={isPending("canonical-contacts-import")}
              onClick={() =>
                void runAction("canonical-contacts-import", async () => {
                  try {
                    await submitContact("import");
                  } catch (error) {
                    setMessage(getUserFacingErrorMessage(error));
                  }
                })
              }
            >
              Import contact
            </button>
            <button
              className="secondary"
              type="button"
              disabled={isPending("canonical-contacts-sync")}
              onClick={() =>
                void runAction("canonical-contacts-sync", async () => {
                  try {
                    await submitContact("sync");
                  } catch (error) {
                    setMessage(getUserFacingErrorMessage(error));
                  }
                })
              }
            >
              Sync contact
            </button>
          </div>
        </div>
      ) : null}
      {contacts.length === 0 ? <p className="shell-note">No contacts yet.</p> : null}
      {contacts.map((contact) => {
        const isOpen = openContactId === contact.id;
        return (
          <div className="canonical-contact-item" key={contact.id}>
            <p>
              <strong>{contact.displayName}</strong>
              <br />
              {contact.phones[0] ?? contact.emails[0] ?? "No contact info"} · {contact.source}
            </p>
            <div className="row-actions">
              <button
                className="secondary"
                type="button"
                onClick={() => setOpenContactId(isOpen ? null : contact.id)}
              >
                {isOpen ? "Hide sources" : "View sources"}
              </button>
            </div>
            {isOpen ? (
              <div className="canonical-contact-sources">
                <p>
                  Source: {contact.source}
                  {contact.sourceExternalId !== null ? ` (${contact.sourceExternalId})` : ""}
                </p>
                <p>Phones: {contact.phones.join(", ") || "None"}</p>
                <p>Emails: {contact.emails.join(", ") || "None"}</p>
                {contact.externalIdentities.length > 0 ? (
                  <p>
                    External identities:{" "}
                    {contact.externalIdentities
                      .map((identity) => `${identity.provider}:${identity.externalId}`)
                      .join(", ")}
                  </p>
                ) : null}
                <p>Linked Grogoni account: {contact.linkedAccountId ?? "None"}</p>
                {contact.linkedAccountId === null ? (
                  <div className="row-actions">
                    <input
                      placeholder="Account id"
                      value={linkAccountDrafts[contact.id] ?? ""}
                      onChange={(event) =>
                        setLinkAccountDrafts((current) => ({
                          ...current,
                          [contact.id]: event.target.value
                        }))
                      }
                    />
                    <button
                      type="button"
                      disabled={isPending(`canonical-contact-link-${contact.id}`)}
                      onClick={() =>
                        void runAction(`canonical-contact-link-${contact.id}`, async () => {
                          try {
                            await linkAccount(contact);
                          } catch (error) {
                            setMessage(getUserFacingErrorMessage(error));
                          }
                        })
                      }
                    >
                      Link account
                    </button>
                  </div>
                ) : (
                  <div className="row-actions">
                    <button
                      className="secondary"
                      type="button"
                      disabled={isPending(`canonical-contact-unlink-${contact.id}`)}
                      onClick={() =>
                        void runAction(`canonical-contact-unlink-${contact.id}`, async () => {
                          try {
                            await unlinkAccount(contact);
                          } catch (error) {
                            setMessage(getUserFacingErrorMessage(error));
                          }
                        })
                      }
                    >
                      Unlink account
                    </button>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
