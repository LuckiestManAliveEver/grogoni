import { useState, type ChangeEvent } from "react";
import {
  browserContactsAdapter,
  readContactsFile,
  type ContactsAccessAdapter
} from "./contacts-access";

import { getErrorMessage } from "./chat-message-plumbing";
import {
  contactPickerContactToNetworkContact,
  getContactDisplayName
} from "./NetworkSyncNestedCard";
import type {
  ContactPickerContact,
  NetworkGraphSummary,
  OAuthProviderSummary,
  SessionResponse,
  SocialSignupProvider
} from "./grogoni-application-shared";

export function IdentityNetworkOnboardingCard({
  session,
  graph,
  oauthProviders,
  oauthProvidersLoaded,
  onGoogleContacts,
  onPhoneContactsSync,
  contactsAdapter = browserContactsAdapter
}: {
  contactsAdapter?: ContactsAccessAdapter;
  session: SessionResponse;
  graph: NetworkGraphSummary | null;
  oauthProviders: OAuthProviderSummary[];
  oauthProvidersLoaded: boolean;
  onGoogleContacts: (
    provider: SocialSignupProvider,
    purpose?: "identity" | "contacts"
  ) => Promise<void>;
  onPhoneContactsSync: (
    selectedContacts: ContactPickerContact[]
  ) => Promise<NetworkGraphSummary | null>;
}) {
  const verifiedEmail =
    session.user.emailVerificationStatus === "verified"
      ? session.user.emailAddress?.trim() || null
      : session.account.primaryAuthChannel === "email"
        ? session.account.primaryAuthDestination
        : null;
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const dismissalKey = `grogoni.contact-onboarding.dismissed.v1:${session.account.id}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(dismissalKey) === "true";
    } catch {
      return false;
    }
  });
  function dismiss() {
    try {
      localStorage.setItem(dismissalKey, "true");
    } catch {
      /* Optional cache. */
    }
    setDismissed(true);
  }
  const hasSeedNetwork =
    graph?.nodes?.some((node) => node.degree === 1 && node.sourceId !== null) ?? false;
  const isGmail = verifiedEmail !== null && /@(gmail|googlemail)\.com$/i.test(verifiedEmail);
  const googleConfigured =
    oauthProvidersLoaded &&
    oauthProviders.some(
      (provider) =>
        provider.id === "google" &&
        provider.configured &&
        provider.enabled !== false &&
        provider.implemented !== false
    );

  if (dismissed || hasSeedNetwork) return null;

  async function syncContacts(contacts: ContactPickerContact[]) {
    const usable = contacts.filter(
      (contact) =>
        getContactDisplayName(contact).length > 0 &&
        contactPickerContactToNetworkContact(contact) !== null
    );
    if (!usable.length) {
      setMessage("No contacts were selected.");
      return;
    }
    const result = await onPhoneContactsSync(usable);
    if (!result) {
      setMessage("Contacts could not be synced. Try again.");
      return;
    }
    const count = result.syncedContactNodeIds?.length ?? 0;
    setMessage(
      count < usable.length
        ? `Added ${count} of ${usable.length} contacts. Try again to add the rest.`
        : `${count} phonebook contact${count === 1 ? "" : "s"} added.`
    );
  }
  async function importPhoneContacts() {
    setWorking(true);
    try {
      await syncContacts(await contactsAdapter.select());
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setWorking(false);
    }
  }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setWorking(true);
    try {
      await syncContacts(await readContactsFile(file));
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="identity-network-onboarding" aria-labelledby="identity-network-title">
      <div>
        <p className="eyebrow">Start your network</p>
        <h2 id="identity-network-title">Add your first contacts</h2>
        <p>Choose which contacts Grogoni may add as the first point of your private network.</p>
      </div>

      <div className="identity-network-actions">
        {isGmail ? (
          <button
            type="button"
            disabled={working || !googleConfigured}
            title={googleConfigured ? undefined : "Google Contacts is not configured yet."}
            onClick={() => void onGoogleContacts("google", "contacts")}
          >
            Import Google Contacts
          </button>
        ) : null}
        {contactsAdapter.isSupported() ? (
          <button
            type="button"
            className="secondary"
            disabled={working}
            onClick={() => void importPhoneContacts()}
          >
            Choose phonebook contacts
          </button>
        ) : null}
        <label className="phonebook-file-button secondary">
          Import contacts file
          <input
            type="file"
            accept=".vcf,.csv,text/vcard,text/csv"
            aria-label="Import contacts file"
            disabled={working}
            onChange={(event) => void importFile(event)}
          />
        </label>
      </div>

      <small>
        Contact access is optional and only starts after you choose a source and approve its
        permission.
      </small>
      {message ? <p className="setup-status">{message}</p> : null}
      <button className="identity-network-dismiss" type="button" onClick={dismiss}>
        Not now
      </button>
    </section>
  );
}
