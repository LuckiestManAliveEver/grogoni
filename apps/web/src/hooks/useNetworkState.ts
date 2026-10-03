import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction
} from "react";
import { reportBackgroundLoadError } from "../background-load-error";

import { commerceAddressFromGrogoniId, type NetworkInviteSummary } from "@grogoni/shared-types";

import { copyTextToClipboard } from "../misc-browser-utils";
import type { ChatMessage } from "../app-shell";
import { getErrorMessage } from "../chat-message-plumbing";
import { deleteJson, fetchFreshJson, getJson, postJson } from "../api-helpers";
import {
  contactPickerContactToCustomer,
  createContactsCsv,
  createPhoneNetworkSeed,
  parseContactImportContent
} from "../contacts-import";
import { createPublicStorefrontUrl } from "../grogoniid-and-storefront";
import {
  browserDefaultCountry,
  networkChangedEvent,
  contactPickerContactToSyncContact,
  describeInviteOutcome,
  sendInvitesInBatches,
  syncPhonebookInBatches,
  type InviteOutcome,
  type PhonebookSyncContact
} from "../phonebook-sync";
import {
  mergeDevicePhonebook,
  type DevicePhonebookContact,
  clearDevicePhonebooks,
  readDevicePhonebook,
  writeDevicePhonebook
} from "../phonebook-device-cache";
import { getUserFacingErrorMessage } from "../user-facing-error";
import type {
  ActiveBusiness,
  AgentRouteSummary,
  ContactPickerContact,
  ContactPickerNavigator,
  CustomerFormState,
  CustomerSummary,
  NetworkGraphSummary,
  NetworkInvitesResponse,
  SocialSignupProvider
} from "../grogoni-application-shared";

interface UseNetworkStateDeps {
  business: ActiveBusiness | null;
  getCustomers: () => CustomerSummary[];
  loadCustomers: (businessId: string) => Promise<void>;
  setStatusMessage: (message: string) => void;
  registerReset: (domainKey: string, fn: () => void) => void;
  registerRefresh: (
    domainKey: string,
    views: readonly string[],
    fn: (businessId: string) => Promise<void>
  ) => void;
}

// GET /network is served through getCachedJson (api-request-cache.ts), which can resolve to a
// record read straight out of IndexedDB (local-data-repository.ts) written by an older build of
// this app, before touching the network. That cached record's schemaVersion never tracks changes
// to NetworkGraphSummary's shape, so a graph cached before a field was added would otherwise reach
// setNetworkGraph missing arrays entirely, crashing every read site that does `graph.nodes.some(...)`.
export function normalizeNetworkGraph(
  graph: Partial<NetworkGraphSummary> | null | undefined
): NetworkGraphSummary {
  return {
    ownerUserId: graph?.ownerUserId ?? "",
    generatedAt: graph?.generatedAt ?? new Date(0).toISOString(),
    nodes: Array.isArray(graph?.nodes) ? graph.nodes : [],
    edges: Array.isArray(graph?.edges) ? graph.edges : [],
    sources: Array.isArray(graph?.sources) ? graph.sources : [],
    routes: Array.isArray(graph?.routes) ? graph.routes : [],
    ...(Array.isArray(graph?.identityLinks) ? { identityLinks: graph.identityLinks } : {}),
    ...(Array.isArray(graph?.connections) ? { connections: graph.connections } : {})
  };
}

export type NetworkConnectionAction =
  | { type: "request"; nodeId: string }
  | { type: "respond"; connectionId: string; accept: boolean }
  | { type: "remove"; connectionId: string };

export function useNetworkState(deps: UseNetworkStateDeps) {
  const [networkGraph, setNetworkGraph] = useState<NetworkGraphSummary | null>(null);
  const [networkInvites, setNetworkInvites] = useState<NetworkInviteSummary[]>([]);
  const [devicePhonebook, setDevicePhonebook] = useState<DevicePhonebookContact[]>([]);
  const devicePhonebookUserId = useRef<string | null>(null);

  // The device copy of picked contacts belongs to one Grogoni user; load it the first time a graph
  // tells us who that is.
  function receiveNetworkGraph(graph: NetworkGraphSummary) {
    setNetworkGraph(graph);
    if (graph.ownerUserId !== "" && devicePhonebookUserId.current !== graph.ownerUserId) {
      devicePhonebookUserId.current = graph.ownerUserId;
      setDevicePhonebook(readDevicePhonebook(graph.ownerUserId));
    }
  }

  // fresh: skip the response cache, for a graph the owner just changed or explicitly refreshed
  // (a connection request from someone else only shows up on a fresh read).
  async function loadNetworkGraph(options: { fresh?: boolean } = {}) {
    try {
      const path = "/network";
      receiveNetworkGraph(
        normalizeNetworkGraph(
          options.fresh === true
            ? await fetchFreshJson<Partial<NetworkGraphSummary>>(path)
            : await getJson<Partial<NetworkGraphSummary>>(path, (revalidated) =>
                // A cached copy renders first; the server's answer replaces it when it arrives.
                receiveNetworkGraph(normalizeNetworkGraph(revalidated))
              )
        )
      );
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function loadNetworkInvites(businessId: string) {
    try {
      setNetworkInvites(
        await getJson<NetworkInviteSummary[]>(`/businesses/${businessId}/network/invites`)
      );
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  async function syncPhoneNetwork() {
    const contacts = createPhoneNetworkSeed(deps.getCustomers());

    if (contacts.length === 0) {
      deps.setStatusMessage(
        "Use My Network to grant phone contact access before importing contacts."
      );
      return;
    }

    try {
      // merge, like every other sync from this device: adding customers must never wipe the
      // contacts the owner picked from their phonebook.
      const graph = await postJson<NetworkGraphSummary>("/network/sync/contacts", {
        sourceName: "Phone Contacts",
        mode: "merge",
        defaultCountry: browserDefaultCountry(),
        contacts
      });
      receiveNetworkGraph(normalizeNetworkGraph(graph));
      deps.setStatusMessage(
        `Added ${contacts.length} customer${contacts.length === 1 ? "" : "s"} to My Network.`
      );
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function syncSelectedNetworkPhoneContacts(
    selectedContacts: ContactPickerContact[]
  ): Promise<NetworkGraphSummary | null> {
    const contacts = selectedContacts
      .map(contactPickerContactToSyncContact)
      .filter((contact): contact is PhonebookSyncContact => contact !== null);

    if (contacts.length === 0) {
      deps.setStatusMessage("No contacts with a usable name were selected.");
      return null;
    }

    const result = await syncPhonebookInBatches(
      (body) => postJson<NetworkGraphSummary>("/network/sync/contacts", body),
      contacts
    );

    if (result.graph === null) {
      deps.setStatusMessage(getErrorMessage(result.error));
      return null;
    }

    const graph = normalizeNetworkGraph(result.graph);
    receiveNetworkGraph(graph);
    // Keep whatever was synced, even when a later batch failed.
    const picked = contacts.slice(0, result.nodeIds.length).map((contact, index) => ({
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      nodeId: result.nodeIds[index] ?? null
    }));
    const merged = mergeDevicePhonebook(readDevicePhonebook(graph.ownerUserId), picked);
    writeDevicePhonebook(graph.ownerUserId, merged);
    setDevicePhonebook(merged);
    const syncedIds = new Set(result.nodeIds);
    const onGrogoni = graph.nodes.filter(
      (node) => node.degree === 1 && node.grogoniUserId != null && syncedIds.has(node.id)
    ).length;
    deps.setStatusMessage(
      result.error === null
        ? `Synced ${picked.length} contact${picked.length === 1 ? "" : "s"}. ${onGrogoni} already on Grogoni.`
        : `Synced ${picked.length} of ${contacts.length} contacts, then: ${getErrorMessage(result.error)}`
    );
    return { ...graph, syncedContactNodeIds: result.nodeIds };
  }

  async function inviteNetworkContacts(
    selectedContacts: Array<{ name: string; phone: string | null; email: string | null }>
  ): Promise<InviteOutcome> {
    const contacts = selectedContacts.filter(
      (contact) => contact.phone !== null || contact.email !== null
    );
    const business = deps.business;

    // Invites are sent in a shop's name. Without a shop, hand the owner a link to share.
    if (business === null) {
      const shared = contacts.length > 0 && (await shareGrogoniInviteLink());
      return { invited: 0, alreadyOnGrogoni: 0, invalid: 0, shared };
    }

    // Failures show in the status line and are rethrown for the card to report too.
    let outcome: InviteOutcome;
    try {
      outcome = await sendInvitesInBatches(
        (batch) =>
          postJson<NetworkInvitesResponse>(`/businesses/${business.id}/network/invites`, {
            contacts: batch,
            defaultCountry: browserDefaultCountry()
          }),
        contacts
      );
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
      throw error;
    }
    await loadNetworkInvites(business.id);
    deps.setStatusMessage(describeInviteOutcome(outcome));
    if (outcome.alreadyOnGrogoni > 0) await loadNetworkGraph({ fresh: true });
    return outcome;
  }

  async function runNetworkConnectionAction(
    action: NetworkConnectionAction
  ): Promise<{ ok: boolean; message: string }> {
    let result: { ok: boolean; message: string };
    try {
      if (action.type === "request") {
        const connection = await postJson<{ status: string; counterpartDisplayName: string }>(
          "/network/connections",
          { nodeId: action.nodeId }
        );
        result = {
          ok: true,
          message:
            connection.status === "accepted"
              ? `You are now connected with ${connection.counterpartDisplayName}.`
              : `Connection request sent to ${connection.counterpartDisplayName}.`
        };
      } else if (action.type === "respond") {
        await postJson(`/network/connections/${action.connectionId}/respond`, {
          accept: action.accept
        });
        result = {
          ok: true,
          message: action.accept ? "You are now connected." : "Request declined."
        };
      } else {
        await deleteJson(`/network/connections/${action.connectionId}`);
        result = { ok: true, message: "Connection removed." };
      }
    } catch (error) {
      result = { ok: false, message: getErrorMessage(error) };
    }
    deps.setStatusMessage(result.message);
    // Let the shell's request prompt drop a request answered here.
    if (result.ok) {
      window.dispatchEvent(
        new CustomEvent(networkChangedEvent, { detail: { source: "network-state" } })
      );
    }
    await loadNetworkGraph({ fresh: true });
    return result;
  }

  /** True when the link was handed to the share sheet or copied; false if cancelled or failed. */
  async function shareGrogoniInviteLink(): Promise<boolean> {
    const url = window.location.origin;
    const text = "Join me on Grogoni.";
    try {
      if (navigator.share !== undefined) {
        await navigator.share({ title: "Grogoni", text, url });
      } else {
        await copyTextToClipboard(`${text} ${url}`);
      }
      deps.setStatusMessage("Invite link ready to share.");
      return true;
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        deps.setStatusMessage("Invite sharing is not available on this device");
      }
      return false;
    }
  }

  async function syncSocialNetwork(
    provider: SocialSignupProvider,
    authenticateSocialProfile: (
      provider: SocialSignupProvider,
      purpose?: "identity" | "contacts"
    ) => Promise<void>
  ) {
    await authenticateSocialProfile(provider, provider === "google" ? "contacts" : "identity");
  }

  // targetNodeId stays the first parameter to match the existing GrogoniApplication.tsx call site
  // (requesting a route to one specific node); requestText is additive.
  async function requestNetworkRoute(targetNodeId?: string, requestText?: string) {
    try {
      const route = await postJson<AgentRouteSummary>("/network/routes", {
        // Falls back to a generic search only when no chat message drove this call - the server
        // matches requestText against network node names (services/api/src/cp2/domains/network/
        // store.ts), so a specific owner request ("find a supplier for rice") must reach it
        // instead of being silently replaced. See docs/frontend/frontend.md Phase 4g.
        requestText: requestText?.trim() || "Find suppliers through my network",
        ...(targetNodeId === undefined ? {} : { targetNodeId })
      });
      setNetworkGraph((graph) =>
        graph === null
          ? graph
          : {
              ...graph,
              routes: [...graph.routes.filter((item) => item.id !== route.id), route]
            }
      );
      deps.setStatusMessage("Agent route requested");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function approveNetworkRoute(routeId: string) {
    try {
      const route = await postJson<AgentRouteSummary>(`/network/routes/${routeId}/approve`, {});
      setNetworkGraph((graph) =>
        graph === null
          ? graph
          : {
              ...graph,
              routes: graph.routes.map((item) => (item.id === route.id ? route : item))
            }
      );
      deps.setStatusMessage("Agent route approved");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function rejectNetworkRoute(routeId: string) {
    try {
      const route = await postJson<AgentRouteSummary>(`/network/routes/${routeId}/reject`, {});
      setNetworkGraph((graph) =>
        graph === null
          ? graph
          : {
              ...graph,
              routes: graph.routes.map((item) => (item.id === route.id ? route : item))
            }
      );
      deps.setStatusMessage("Agent route rejected");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function disconnectNetworkSource(sourceId: string) {
    const phoneSource =
      networkGraph?.sources.find((source) => source.id === sourceId)?.sourcePlatform === "phone";
    try {
      setNetworkGraph(await deleteJson<NetworkGraphSummary>(`/network/sources/${sourceId}`));
      // Disconnecting the phonebook forgets the device copy too: its numbers belonged to it.
      if (phoneSource && networkGraph !== null) {
        writeDevicePhonebook(networkGraph.ownerUserId, []);
        setDevicePhonebook([]);
      }
      deps.setStatusMessage("Network source disconnected");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function shareOwnerStorefrontInvite() {
    if (deps.business === null) {
      return;
    }

    const publicStorefrontUrl = createPublicStorefrontUrl(deps.business);
    const shareData = {
      title: `${deps.business.name} on Grogoni`,
      text: `Open ${deps.business.name} with Grogoni Shop ID ${commerceAddressFromGrogoniId(deps.business.grogoniId)}.`,
      url: publicStorefrontUrl
    };

    try {
      if (navigator.share !== undefined) {
        await navigator.share(shareData);
      } else {
        await copyTextToClipboard(`${shareData.text} ${publicStorefrontUrl}`);
      }
      deps.setStatusMessage("Storefront invite ready to share");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        return;
      }
      deps.setStatusMessage("Invite sharing is not available on this device");
    }
  }

  async function importContactRecords(
    records: Array<Pick<CustomerFormState, "name" | "phone" | "email" | "notes">>
  ) {
    if (deps.business === null || records.length === 0) {
      return;
    }

    try {
      for (const record of records) {
        await postJson<CustomerSummary>(`/businesses/${deps.business.id}/customers`, {
          name: record.name,
          phone: record.phone,
          email: record.email,
          notes: record.notes
        });
      }
      await deps.loadCustomers(deps.business.id);
      deps.setStatusMessage(`Imported ${records.length} contact${records.length === 1 ? "" : "s"}`);
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  // setChatMessages is a call-time argument, not a hook-level dep: it's owned by the Chat domain
  // hook (Phase 16), which itself needs getCustomers/loadCustomers from this hook - the same
  // two-way dependency class fixed for Sync (Phase 7) and Runtime history (Phase 16) by passing
  // the setter at call time instead of hook-invocation time.
  async function syncOwnerPhoneContacts(setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>) {
    const contactNavigator = navigator as ContactPickerNavigator;

    if (contactNavigator.contacts?.select === undefined) {
      deps.setStatusMessage("Contact sync is available on supported mobile browsers");
      await shareOwnerStorefrontInvite();
      return;
    }

    try {
      const selectedContacts = await contactNavigator.contacts.select(["name", "tel", "email"], {
        multiple: true
      });

      if (selectedContacts.length === 0) {
        return;
      }

      const labels = selectedContacts
        .map((contact) => contact.name?.[0] ?? contact.tel?.[0] ?? contact.email?.[0])
        .filter((label): label is string => label !== undefined && label.trim().length > 0);
      const records = selectedContacts
        .map(contactPickerContactToCustomer)
        .filter(
          (record): record is Pick<CustomerFormState, "name" | "phone" | "email" | "notes"> =>
            record !== null
        );
      await importContactRecords(records);
      setChatMessages((messages) => [
        ...messages,
        {
          id: `grogoniclaw-contacts-${Date.now()}`,
          author: "grogoniclaw",
          body: `I found ${selectedContacts.length} contact${
            selectedContacts.length === 1 ? "" : "s"
          }: ${labels.slice(0, 5).join(", ") || "selected contacts"}. Use Invite to share your storefront link.`
        }
      ]);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        return;
      }
      deps.setStatusMessage(getUserFacingErrorMessage(caught));
    }
  }

  async function importContactsFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (file === undefined) {
      return;
    }

    const content = await file.text();
    await importContactRecords(parseContactImportContent(content));
  }

  function exportOwnerContacts() {
    const customers = deps.getCustomers();
    const csv = createContactsCsv(customers);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${deps.business?.name ?? "grogoni"}-contacts.csv`;
    link.click();
    URL.revokeObjectURL(url);
    deps.setStatusMessage(
      `Exported ${customers.length} contact${customers.length === 1 ? "" : "s"}`
    );
  }

  // The shell's ConnectionRequestsPrompt answers requests outside this hook; reload so an open
  // Phone Contacts card does not keep offering "Accept" for a request already answered.
  const reloadGraph = useRef(loadNetworkGraph);
  reloadGraph.current = loadNetworkGraph;
  useEffect(() => {
    const reload = (event: Event) => {
      // This hook already reloads after its own actions.
      if ((event as CustomEvent<{ source?: string }>).detail?.source === "network-state") return;
      void reloadGraph.current({ fresh: true });
    };
    window.addEventListener(networkChangedEvent, reload);
    return () => window.removeEventListener(networkChangedEvent, reload);
  }, []);

  deps.registerReset("network", () => {
    setNetworkGraph(null);
    setNetworkInvites([]);
    setDevicePhonebook([]);
    devicePhonebookUserId.current = null;
    clearDevicePhonebooks();
  });
  deps.registerRefresh("network", ["home", "network"], async (businessId) => {
    await Promise.all([loadNetworkGraph(), loadNetworkInvites(businessId)]);
  });

  return {
    networkGraph,
    // Exposed raw: completeOAuthSession (Auth domain, still inline in OwnerApp until Phase 18)
    // writes networkGraph directly after syncing a social provider's network source, mirroring the
    // otpChallengesMap-style escape hatch used elsewhere for a not-yet-extracted caller that needs
    // raw mutation access rather than going through this hook's own action functions.
    setNetworkGraph,
    networkInvites,
    devicePhonebook,
    runNetworkConnectionAction,
    loadNetworkGraph,
    loadNetworkInvites,
    syncPhoneNetwork,
    syncSelectedNetworkPhoneContacts,
    inviteNetworkContacts,
    syncSocialNetwork,
    requestNetworkRoute,
    approveNetworkRoute,
    rejectNetworkRoute,
    disconnectNetworkSource,
    shareOwnerStorefrontInvite,
    importContactRecords,
    syncOwnerPhoneContacts,
    importContactsFile,
    exportOwnerContacts
  };
}
