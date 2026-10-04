import { useMemo, useState, type ChangeEvent } from "react";

import type { NetworkConnectionSummary, NetworkInviteSummary } from "@grogoni/shared-types";

import { AuthenticationActionMessage } from "./AuthenticationActionMessage";
import { parseVcardContacts } from "./phonebook-vcard";
import { parseContactImportContent } from "./contacts-import";
import type { NetworkConnectionAction } from "./hooks/useNetworkState";
import {
  contactPickerContactToSyncContact,
  describeInviteOutcome,
  type InviteOutcome
} from "./phonebook-sync";
import {
  buildPhonebookDirectory,
  type DevicePhonebookContact,
  type OnGrogoniEntry
} from "./phonebook-directory";
import type {
  ContactPickerContact,
  ContactPickerNavigator,
  NetworkGraphSummary
} from "./grogoni-application-shared";

/** Rows rendered per section; search narrows a longer phonebook. */
const sectionRowLimit = 200;

/**
 * Phone Contacts: sync the phonebook (device contact picker, or a vCard/CSV export where the
 * picker is unavailable), then connect with contacts already on Grogoni and invite the rest.
 */
export function PhoneContactsCard({
  graph,
  connected,
  deviceContacts,
  invites,
  onBack,
  onSync,
  onDisconnect,
  onConnectionAction,
  onInvite
}: {
  graph: NetworkGraphSummary | null;
  connected: boolean;
  deviceContacts: DevicePhonebookContact[];
  invites: NetworkInviteSummary[];
  onBack: () => void;
  onSync: (contacts: ContactPickerContact[]) => Promise<NetworkGraphSummary | null>;
  onDisconnect: () => void;
  onConnectionAction: (
    action: NetworkConnectionAction
  ) => Promise<{ ok: boolean; message: string }>;
  onInvite: (contacts: DevicePhonebookContact[]) => Promise<InviteOutcome>;
}) {
  const [search, setSearch] = useState("");
  // A Set: a phonebook can hold thousands of invitable contacts, and "Select all" then checks
  // every row against the selection.
  const [selectedInviteKeys, setSelectedInviteKeys] = useState<ReadonlySet<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const directory = useMemo(
    () => buildPhonebookDirectory({ graph, deviceContacts, invites, search }),
    [graph, deviceContacts, invites, search]
  );
  const pickerSupported =
    typeof navigator !== "undefined" &&
    (navigator as ContactPickerNavigator).contacts?.select !== undefined;
  const invitable = directory.invite.filter((entry) => !entry.invited);

  async function syncFromPicker() {
    const contactNavigator = navigator as ContactPickerNavigator;

    if (contactNavigator.contacts?.select === undefined) {
      setMessage(
        "This browser cannot open your contacts. Import a contacts file (vCard or CSV) exported from your phone instead."
      );
      return;
    }

    try {
      const contacts = await contactNavigator.contacts.select(["name", "tel", "email"], {
        multiple: true
      });

      if (contacts.length === 0) {
        setMessage("No contacts selected.");
        return;
      }

      await syncAndReport(contacts);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setMessage("Contact access was denied. You can allow it later from your browser settings.");
    }
  }

  async function syncFromFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;

    const content = await file.text();
    // vCards keep every number and email per person; CSV exports have one column of each.
    const contacts =
      parseVcardContacts(content) ??
      parseContactImportContent(content).map((record) => ({
        name: [record.name],
        tel: record.phone.trim() === "" ? [] : [record.phone],
        email: record.email.trim() === "" ? [] : [record.email]
      }));
    if (contacts.length === 0) {
      setMessage("No contacts with a name were found in that file.");
      return;
    }

    await syncAndReport(contacts);
  }

  async function syncAndReport(contacts: ContactPickerContact[]) {
    setBusyKey("sync");
    const next = await onSync(contacts);
    setBusyKey(null);
    if (next === null) {
      setMessage("Contacts could not be synced. Try again.");
      return;
    }
    const syncedIds = next.syncedContactNodeIds ?? [];
    // Entries with no name, number or email are never sent, so they are not "missing" either.
    const syncable = contacts.filter(
      (contact) => contactPickerContactToSyncContact(contact) !== null
    ).length;
    const synced = new Set(syncedIds);
    const onGrogoni = next.nodes.filter(
      (node) => synced.has(node.id) && node.grogoniUserId != null
    ).length;
    // A large phonebook goes up in batches; say so when only part of it made it.
    setMessage(
      syncedIds.length < syncable
        ? `Synced ${syncedIds.length} of ${syncable} contacts (${onGrogoni} on Grogoni). Sync again to add the rest.`
        : `Synced ${syncable} contact${syncable === 1 ? "" : "s"}: ${onGrogoni} already on Grogoni.`
    );
  }

  async function runAction(key: string, action: NetworkConnectionAction) {
    setBusyKey(key);
    const result = await onConnectionAction(action);
    setBusyKey(null);
    setMessage(result.message);
  }

  async function inviteSelected() {
    const selected = invitable.filter((entry) => selectedInviteKeys.has(entry.key));
    if (selected.length === 0) {
      setMessage("Select contacts to invite first.");
      return;
    }
    setBusyKey("invite");
    try {
      const outcome = await onInvite(selected.map((entry) => entry.contact));
      setSelectedInviteKeys(new Set());
      setMessage(describeInviteOutcome(outcome));
    } catch {
      setMessage("Invites could not be sent. Try again.");
    } finally {
      setBusyKey(null);
    }
  }

  function toggleInvite(key: string) {
    setSelectedInviteKeys((keys) => {
      const next = new Set(keys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const hasContacts =
    directory.requests.length +
      directory.onGrogoni.length +
      directory.invite.length +
      directory.unreachable.length >
    0;

  return (
    <section className="nested-card network-sync-card" aria-label="Phone Contacts">
      <button className="nested-breadcrumb" type="button" onClick={onBack}>
        &lt; My Network
      </button>
      <div className="nested-card-title-row">
        <div>
          <h3>Phone Contacts</h3>
          <p>
            Find the people you know on Grogoni and invite the rest. Grogoni reads only the contacts
            you pick, and keeps only a fingerprint and the last few digits of each number, never the
            full number.
          </p>
        </div>
        <span className={connected ? "network-status" : "network-status disconnected"}>
          {connected ? "Connected" : "Not Connected"}
        </span>
      </div>
      <div className="nested-form-actions">
        {pickerSupported ? (
          <button type="button" disabled={busyKey === "sync"} onClick={() => void syncFromPicker()}>
            {connected ? "Add or update contacts" : "Sync contacts"}
          </button>
        ) : null}
        <label
          className={pickerSupported ? "phonebook-file-button secondary" : "phonebook-file-button"}
        >
          Import contacts file
          <input
            accept=".vcf,.csv,text/vcard,text/csv"
            aria-label="Import contacts file"
            type="file"
            onChange={(event) => void syncFromFile(event)}
          />
        </label>
        {connected ? (
          <button className="secondary" type="button" onClick={onDisconnect}>
            Disconnect
          </button>
        ) : null}
      </div>
      {hasContacts || search.length > 0 ? (
        <div className="phone-contact-manager">
          <p className="phonebook-summary">
            <strong>{directory.onGrogoni.length}</strong> on Grogoni ·{" "}
            <strong>{directory.invite.length}</strong> to invite
            {directory.requests.length > 0 ? (
              <>
                {" "}
                · <strong>{directory.requests.length}</strong> waiting for you
              </>
            ) : null}
          </p>
          <label className="network-search">
            <span>Search</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search contacts"
            />
          </label>
          {directory.requests.length > 0 ? (
            <section className="network-contact-group" aria-label="Connection requests">
              <h4>Want to connect ({directory.requests.length})</h4>
              {directory.requests.slice(0, sectionRowLimit).map((request) => (
                <RequestRow
                  key={request.id}
                  busy={busyKey === request.id}
                  request={request}
                  onRespond={(accept) =>
                    void runAction(request.id, {
                      type: "respond",
                      connectionId: request.id,
                      accept
                    })
                  }
                />
              ))}
            </section>
          ) : null}
          <section className="network-contact-group" aria-label="On Grogoni">
            <h4>On Grogoni ({directory.onGrogoni.length})</h4>
            {directory.onGrogoni.length === 0 ? (
              <p className="shell-note">
                None of your synced contacts are on Grogoni yet. Invite them below.
              </p>
            ) : (
              directory.onGrogoni
                .slice(0, sectionRowLimit)
                .map((entry) => (
                  <OnGrogoniRow
                    key={entry.key}
                    busy={busyKey === entry.key}
                    entry={entry}
                    onAction={(action) => void runAction(entry.key, action)}
                  />
                ))
            )}
          </section>
          <section className="network-contact-group" aria-label="Invite to Grogoni">
            <div className="phonebook-group-header">
              <h4>Invite to Grogoni ({directory.invite.length})</h4>
              {invitable.length > 0 ? (
                <div className="phonebook-row-actions">
                  <button
                    className="secondary"
                    type="button"
                    onClick={() =>
                      setSelectedInviteKeys(
                        selectedInviteKeys.size === invitable.length
                          ? new Set()
                          : new Set(invitable.map((entry) => entry.key))
                      )
                    }
                  >
                    {selectedInviteKeys.size === invitable.length ? "Clear" : "Select all"}
                  </button>
                  <button
                    type="button"
                    disabled={busyKey === "invite" || selectedInviteKeys.size === 0}
                    onClick={() => void inviteSelected()}
                  >
                    Invite{selectedInviteKeys.size > 0 ? ` (${selectedInviteKeys.size})` : ""}
                  </button>
                </div>
              ) : null}
            </div>
            {directory.invite.length === 0 ? (
              <p className="shell-note">
                {deviceContacts.length === 0 && (graph?.nodes.length ?? 0) > 1
                  ? "Sync contacts on this device to invite people who are not on Grogoni."
                  : "Everyone you synced is on Grogoni."}
              </p>
            ) : (
              directory.invite.slice(0, sectionRowLimit).map((entry) => (
                <label key={entry.key}>
                  <input
                    checked={entry.invited || selectedInviteKeys.has(entry.key)}
                    disabled={entry.invited}
                    type="checkbox"
                    onChange={() => toggleInvite(entry.key)}
                  />
                  <span>
                    <strong>{entry.contact.name}</strong>
                    <small>
                      {entry.invited ? "Invited · " : ""}
                      {entry.contact.phone ?? entry.contact.email}
                    </small>
                  </span>
                </label>
              ))
            )}
          </section>
          {directory.unreachable.length > 0 ? (
            <details className="network-contact-group">
              <summary>No phone or email ({directory.unreachable.length})</summary>
              {directory.unreachable.slice(0, sectionRowLimit).map((contact, index) => (
                <p className="shell-note" key={`${contact.name}:${index}`}>
                  {contact.name}
                </p>
              ))}
            </details>
          ) : null}
          {[directory.onGrogoni, directory.invite, directory.requests].some(
            (list) => list.length > sectionRowLimit
          ) ? (
            <p className="shell-note">
              Showing the first {sectionRowLimit} in each list. Search to find someone.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="shell-note">Sync your contacts to see who is already on Grogoni.</p>
      )}
      {message.length > 0 ? (
        <p className="setup-status" role="status">
          <AuthenticationActionMessage message={message} />
        </p>
      ) : null}
    </section>
  );
}

function RequestRow({
  request,
  busy,
  onRespond
}: {
  request: NetworkConnectionSummary;
  busy: boolean;
  onRespond: (accept: boolean) => void;
}) {
  return (
    <div className="phonebook-row">
      <span>
        <strong>{request.counterpartDisplayName}</strong>
        <small>{request.counterpartBusinessName ?? "On Grogoni"}</small>
      </span>
      <div className="phonebook-row-actions">
        <button type="button" disabled={busy} onClick={() => onRespond(true)}>
          Accept
        </button>
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={() => onRespond(false)}
        >
          Decline
        </button>
      </div>
    </div>
  );
}

function OnGrogoniRow({
  entry,
  busy,
  onAction
}: {
  entry: OnGrogoniEntry;
  busy: boolean;
  onAction: (action: NetworkConnectionAction) => void;
}) {
  const detail =
    entry.state === "connected"
      ? "Connected"
      : entry.state === "requested"
        ? "Request sent"
        : (entry.businessName ?? "On Grogoni");

  return (
    <div className="phonebook-row">
      <span>
        <strong>{entry.name}</strong>
        <small>
          {detail}
          {entry.state !== "connect" && entry.businessName !== null
            ? ` · ${entry.businessName}`
            : ""}
        </small>
      </span>
      <div className="phonebook-row-actions">
        {entry.state === "connect" && entry.nodeId !== null ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction({ type: "request", nodeId: entry.nodeId as string })}
          >
            Connect
          </button>
        ) : null}
        {entry.state !== "connect" && entry.connectionId !== null ? (
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() => onAction({ type: "remove", connectionId: entry.connectionId as string })}
          >
            {entry.state === "requested" ? "Cancel" : "Remove"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
