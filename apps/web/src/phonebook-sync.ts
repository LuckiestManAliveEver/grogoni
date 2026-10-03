import type {
  ContactPickerContact,
  NetworkGraphSummary,
  NetworkInvitesResponse
} from "./grogoni-application-shared";

/**
 * The device's region ("en-KE" -> "KE"), sent with syncs and invites so the server can read
 * national-format numbers for owners whose own country it does not know (email or device login).
 * Kenya when the browser has no region, matching the app's default dial code.
 */
export function browserDefaultCountry(
  language: string | undefined = globalThis.navigator?.language
): string {
  const region = (language ?? "").split("-")[1]?.toUpperCase();
  return region !== undefined && /^[A-Z]{2}$/u.test(region) ? region : "KE";
}

/** Dispatched on window when the network changed outside useNetworkState (e.g. a request answered). */
export const networkChangedEvent = "grogoni:network-changed";

/** Server limits: contacts per sync request, and contacts per invite request. */
export const phonebookSyncBatchSize = 5000;
export const inviteBatchSize = 100;

export interface PhonebookSyncContact {
  name: string;
  /** First number/email, kept on the device for invites. */
  phone: string | null;
  email: string | null;
  /** Every number and email on the contact, so discovery finds someone by any of them. */
  phones: string[];
  emails: string[];
}

export function contactPickerContactToSyncContact(
  contact: ContactPickerContact
): PhonebookSyncContact | null {
  const phones = cleanList(contact.tel);
  const emails = cleanList(contact.email);
  const name = contact.name?.[0]?.trim() || phones[0] || emails[0];

  if (name === undefined || name.length === 0) return null;

  return { name, phone: phones[0] ?? null, email: emails[0] ?? null, phones, emails };
}

/**
 * Syncs in server-sized batches, in merge mode so each batch adds to the last. Stops at the first
 * failed batch and reports how far it got: `nodeIds` covers exactly the contacts that were synced,
 * so the caller can keep that part.
 */
export async function syncPhonebookInBatches(
  post: (body: Record<string, unknown>) => Promise<NetworkGraphSummary>,
  contacts: PhonebookSyncContact[],
  defaultCountry: string = browserDefaultCountry()
): Promise<{ graph: NetworkGraphSummary | null; nodeIds: Array<string | null>; error: unknown }> {
  let graph: NetworkGraphSummary | null = null;
  const nodeIds: Array<string | null> = [];

  for (let start = 0; start < contacts.length; start += phonebookSyncBatchSize) {
    const batch = contacts.slice(start, start + phonebookSyncBatchSize);
    try {
      graph = await post({
        sourceName: "Phone Contacts",
        mode: "merge",
        defaultCountry,
        contacts: batch
      });
    } catch (error) {
      return { graph, nodeIds, error };
    }
    const ids = graph.syncedContactNodeIds ?? [];
    nodeIds.push(...batch.map((_, index) => ids[index] ?? null));
  }

  return { graph, nodeIds, error: null };
}

export interface InviteOutcome {
  invited: number;
  alreadyOnGrogoni: number;
  /** Contacts whose number and email could not be read; nothing was sent to them. */
  invalid: number;
  /** No shop to send invites from: the device share sheet was offered instead. */
  shared: boolean;
}

export async function sendInvitesInBatches(
  post: (
    contacts: Array<{ name: string; phone: string | null; email: string | null }>
  ) => Promise<NetworkInvitesResponse>,
  contacts: Array<{ name: string; phone: string | null; email: string | null }>
): Promise<InviteOutcome> {
  const outcome: InviteOutcome = { invited: 0, alreadyOnGrogoni: 0, invalid: 0, shared: false };

  for (let start = 0; start < contacts.length; start += inviteBatchSize) {
    const response = await post(
      contacts
        .slice(start, start + inviteBatchSize)
        .map(({ name, phone, email }) => ({ name, phone, email }))
    );
    outcome.invited += response.invites.length;
    outcome.alreadyOnGrogoni += response.alreadyOnGrogoniCount ?? 0;
    outcome.invalid += response.invalidCount ?? 0;
  }

  return outcome;
}

export function describeInviteOutcome(outcome: InviteOutcome): string {
  if (outcome.shared) return "Share the invite link with the people you picked.";

  const onGrogoni =
    outcome.alreadyOnGrogoni === 0
      ? ""
      : outcome.alreadyOnGrogoni === 1
        ? " 1 is already on Grogoni: connect with them instead."
        : ` ${outcome.alreadyOnGrogoni} are already on Grogoni: connect with them instead.`;

  const invalid =
    outcome.invalid === 0 ? "" : ` ${outcome.invalid} had no number or email Grogoni could read.`;

  if (outcome.invited === 0) {
    return outcome.alreadyOnGrogoni > 0
      ? `Nobody to invite.${onGrogoni}${invalid}`
      : `No invites were sent.${invalid}`;
  }

  return `${outcome.invited} invite${outcome.invited === 1 ? "" : "s"} sent.${onGrogoni}${invalid}`;
}

function cleanList(values: string[] | undefined): string[] {
  return [
    ...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))
  ];
}
