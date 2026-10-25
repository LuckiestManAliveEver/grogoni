import { Suspense, lazy, useEffect, useState } from "react";

import { AuthenticationActionMessage } from "./AuthenticationActionMessage";

import type { NetworkInviteSummary } from "@grogoni/shared-types";

import type { NetworkConnectionAction } from "./hooks/useNetworkState";
import { LazyModuleErrorBoundary } from "./LazyModuleErrorBoundary";
import { loadLazyModuleWithRecovery, workspaceModuleKeys } from "./lazy-module-recovery";
import type { DevicePhonebookContact } from "./phonebook-directory";
import type { InviteOutcome } from "./phonebook-sync";
import {
  type ContactPickerContact,
  type NetworkGraphSummary,
  type NetworkSyncProviderId,
  type NetworkSyncSourceSummary,
  type OAuthProviderSummary,
  type SocialSignupProvider,
  networkSyncProviders
} from "./grogoni-application-shared";

// Only rendered once the owner opens Phone Contacts: kept out of the owner route's chunk.
const PhoneContactsCard = lazy(() =>
  loadLazyModuleWithRecovery(
    workspaceModuleKeys.phoneContacts,
    () => import("./PhoneContactsCard")
  ).then((module) => ({ default: module.PhoneContactsCard }))
);

export function NetworkSyncNestedCard({
  graph,
  devicePhonebook,
  networkInvites,
  oauthProviders,
  oauthProvidersLoaded,
  onBack,
  onDisconnectSource,
  onOAuthProvider,
  onPhoneContactsSync,
  onInviteContacts,
  onConnectionAction,
  onRefresh,
  onMessageContact
}: {
  onMessageContact?: (nodeId: string, name: string) => void;
  graph: NetworkGraphSummary | null;
  devicePhonebook: DevicePhonebookContact[];
  networkInvites: NetworkInviteSummary[];
  oauthProviders: OAuthProviderSummary[];
  oauthProvidersLoaded: boolean;
  onBack: () => void;
  onDisconnectSource: (sourceId: string) => void;
  onOAuthProvider: (
    provider: SocialSignupProvider,
    purpose?: "identity" | "contacts"
  ) => Promise<void>;
  onPhoneContactsSync: (
    selectedContacts: ContactPickerContact[]
  ) => Promise<NetworkGraphSummary | null>;
  onInviteContacts: (contacts: DevicePhonebookContact[]) => Promise<InviteOutcome>;
  onConnectionAction: (
    action: NetworkConnectionAction
  ) => Promise<{ ok: boolean; message: string }>;
  onRefresh: () => void;
}) {
  const [view, setView] = useState<"providers" | "phone">("providers");
  const [localGraph, setLocalGraph] = useState<NetworkGraphSummary | null>(graph);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setLocalGraph(graph);
  }, [graph]);

  const activeGraph = localGraph ?? graph;
  const phoneSource = getActiveNetworkSource(activeGraph, "phone");
  const visibleNetworkSyncProviders = networkSyncProviders.filter(
    (provider) =>
      provider.id === "phone" ||
      oauthProviders.some(
        (oauthProvider) =>
          oauthProvider.id === provider.oauthProvider &&
          oauthProvider.configured &&
          oauthProvider.enabled !== false &&
          oauthProvider.implemented !== false
      )
  );

  function disconnectPhoneSource() {
    if (phoneSource === null) {
      setMessage("Phone contacts are not connected yet.");
      return;
    }

    onDisconnectSource(phoneSource.id);
    setLocalGraph((current) =>
      current === null
        ? current
        : {
            ...current,
            sources: current.sources.map((source) =>
              source.id === phoneSource.id
                ? { ...source, status: "disconnected", importedCount: 0 }
                : source
            )
          }
    );
  }

  if (view === "phone") {
    return (
      <LazyModuleErrorBoundary moduleKey={workspaceModuleKeys.phoneContacts} label="Phone Contacts">
        <Suspense fallback={<div className="inline-loading-card">Opening Phone Contacts…</div>}>
          <PhoneContactsCard
            connected={phoneSource !== null}
            deviceContacts={devicePhonebook}
            graph={activeGraph}
            invites={networkInvites}
            onBack={() => setView("providers")}
            onConnectionAction={onConnectionAction}
            onDisconnect={disconnectPhoneSource}
            onInvite={onInviteContacts}
            onSync={onPhoneContactsSync}
            {...(onMessageContact ? { onMessageContact } : {})}
          />
        </Suspense>
      </LazyModuleErrorBoundary>
    );
  }

  async function connectProvider(providerId: NetworkSyncProviderId) {
    const provider = networkSyncProviders.find((item) => item.id === providerId);

    if (provider?.id === "phone") {
      setView("phone");
      return;
    }

    if (provider?.oauthProvider === null || provider === undefined) {
      setMessage("This login provider is not configured yet.");
      return;
    }

    const oauthConfig = oauthProviders.find((item) => item.id === provider.oauthProvider);

    if (!oauthProvidersLoaded) {
      setMessage("Social providers are still loading. Try again in a moment.");
      return;
    }

    if (oauthConfig?.implemented === false || oauthConfig?.configured !== true) {
      setMessage("This login provider is not configured yet.");
      return;
    }

    await onOAuthProvider(
      provider.oauthProvider,
      provider.oauthProvider === "google" ? "contacts" : "identity"
    );
  }

  return (
    <section className="nested-card network-sync-card" aria-label="My Network providers">
      <button className="nested-breadcrumb" type="button" onClick={onBack}>
        &lt; Workspace
      </button>
      <div className="nested-card-title-row">
        <div>
          <h3>My Network</h3>
          <p>Connect relationship sources for your shop agent.</p>
        </div>
        <button className="small-outline-button" type="button" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      <div className="network-provider-list">
        {visibleNetworkSyncProviders.map((provider) => {
          const source = getActiveNetworkSource(activeGraph, provider.id);
          const oauthConfig =
            provider.oauthProvider === null
              ? null
              : oauthProviders.find((item) => item.id === provider.oauthProvider);
          const configured =
            provider.id === "phone" ||
            (oauthProvidersLoaded && oauthConfig?.implemented !== false && oauthConfig?.configured);
          const statusText =
            source === null ? (configured ? "Connect" : "Not configured") : "Connected";

          return (
            <article className="network-provider-row" key={provider.id}>
              <button type="button" onClick={() => void connectProvider(provider.id)}>
                <span className="network-provider-icon">{provider.icon}</span>
                <span>
                  <strong>{provider.label}</strong>
                  <small>{provider.detail}</small>
                  <small>
                    {source === null
                      ? "Last sync: never"
                      : `Last sync: ${new Date(source.updatedAt ?? source.createdAt ?? Date.now()).toLocaleString()}`}
                  </small>
                </span>
              </button>
              <div>
                <span
                  className={source === null ? "network-status disconnected" : "network-status"}
                >
                  {statusText}
                </span>
                <strong>{source?.importedCount ?? 0}</strong>
                <small>contacts</small>
              </div>
              <button
                className="secondary"
                type="button"
                onClick={() =>
                  source === null
                    ? void connectProvider(provider.id)
                    : onDisconnectSource(source.id)
                }
              >
                {source === null ? "Sync" : "Disconnect"}
              </button>
            </article>
          );
        })}
      </div>
      {message.length > 0 ? (
        <p className="setup-status">
          <AuthenticationActionMessage message={message} />
        </p>
      ) : null}
    </section>
  );
}

export function getActiveNetworkSource(
  graph: NetworkGraphSummary | null,
  providerId: NetworkSyncProviderId
): NetworkSyncSourceSummary | null {
  if (graph === null) {
    return null;
  }

  const platform = providerId === "phone" ? "phone" : providerId;
  return (
    graph.sources?.find(
      (source) => source.sourcePlatform === platform && source.status === "active"
    ) ?? null
  );
}

export function contactPickerContactToNetworkContact(contact: ContactPickerContact): {
  name: string;
  phone: string | null;
  email: string | null;
} | null {
  const name = contact.name?.[0]?.trim() ?? contact.tel?.[0]?.trim() ?? contact.email?.[0]?.trim();

  if (name === undefined || name.length === 0) {
    return null;
  }

  return {
    name,
    phone: contact.tel?.[0]?.trim() || null,
    email: contact.email?.[0]?.trim() || null
  };
}

export function getContactDisplayName(contact: ContactPickerContact): string {
  return (
    contact.name?.[0]?.trim() ??
    contact.tel?.[0]?.trim() ??
    contact.email?.[0]?.trim() ??
    "Unnamed contact"
  );
}
