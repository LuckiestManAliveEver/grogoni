import { useState } from "react";

import { getErrorMessage } from "./chat-message-plumbing";
import {
  contactPickerContactToNetworkContact,
  getContactDisplayName
} from "./NetworkSyncNestedCard";
import type {
  ContactPickerContact,
  ContactPickerNavigator,
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
  onPhoneContactsSync
}: {
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
  const [dismissed, setDismissed] = useState(false);
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

  async function importPhoneContacts() {
    const contactNavigator = navigator as ContactPickerNavigator;
    if (contactNavigator.contacts?.select === undefined) {
      setMessage("The contact picker is not available on this device or browser.");
      return;
    }
    setWorking(true);
    try {
      const contacts = await contactNavigator.contacts.select(["name", "tel", "email"], {
        multiple: true
      });
      const usable = contacts.filter(
        (contact) =>
          getContactDisplayName(contact).length > 0 &&
          contactPickerContactToNetworkContact(contact) !== null
      );
      if (usable.length === 0) {
        setMessage("No contacts were selected.");
        return;
      }
      await onPhoneContactsSync(usable);
      setMessage(`${usable.length} phonebook contact${usable.length === 1 ? "" : "s"} added.`);
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
        <button
          type="button"
          className="secondary"
          disabled={working}
          onClick={() => void importPhoneContacts()}
        >
          Choose phonebook contacts
        </button>
      </div>

      <small>
        Contact access is optional and only starts after you choose a source and approve its
        permission.
      </small>
      {message ? <p className="setup-status">{message}</p> : null}
      <button className="identity-network-dismiss" type="button" onClick={() => setDismissed(true)}>
        Not now
      </button>
    </section>
  );
}
