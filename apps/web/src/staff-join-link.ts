// Staff invitation join links (docs/architecture/staff-invitations.md). The owner sends the link
// to the invited number by SMS or WhatsApp from their own phone; the person opens it, signs in with
// that number, and accepts. The secret in the link is proof they received the message; it never
// grants anything by itself (the server still requires the invited sign-in identity).
//
// The link targets the site root with query parameters, so it works on any host without a
// server-side route: `https://grogoni.com/?staffInvite=<id>&t=<secret>`.

const pendingJoinStorageKey = "grogoni.staffInvite.pending";
/** A captured link is kept this long while the person signs up or logs in. */
const pendingJoinTtlMs = 7 * 24 * 60 * 60 * 1000;

export interface PendingJoin {
  invitationId: string;
  joinToken: string;
  savedAt: number;
}

export function buildJoinLink(origin: string, invitationId: string, joinToken: string): string {
  const url = new URL("/", origin);
  url.searchParams.set("staffInvite", invitationId);
  url.searchParams.set("t", joinToken);
  return url.toString();
}

/** `sms:` URI to the exact number with the body prefilled (the `?&body=` form works on Android and iOS). */
export function smsLink(e164: string, body: string): string {
  return `sms:${e164}?&body=${encodeURIComponent(body)}`;
}

/** Official WhatsApp click-to-chat: digits only, no `+`. */
export function whatsAppLink(e164: string, body: string): string {
  return `https://wa.me/${e164.replace(/\D/gu, "")}?text=${encodeURIComponent(body)}`;
}

export function emailLink(address: string, subject: string, body: string): string {
  // The address is encoded too (keeping "@"), so a crafted address cannot add mailto fields.
  const to = encodeURIComponent(address).replace(/%40/gu, "@");
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Called once at app start. If the page was opened from a join link, remembers it (so it survives
 * signing up or logging in) and removes the secret from the address bar and history.
 */
export function captureJoinLink(
  location: { href: string },
  storage: Pick<Storage, "setItem">,
  history: Pick<History, "replaceState" | "state">,
  now = Date.now()
): PendingJoin | null {
  const url = new URL(location.href);
  const invitationId = url.searchParams.get("staffInvite")?.trim() ?? "";
  const joinToken = url.searchParams.get("t")?.trim() ?? "";
  if (invitationId === "" || joinToken === "") return null;
  const pending: PendingJoin = { invitationId, joinToken, savedAt: now };
  try {
    storage.setItem(pendingJoinStorageKey, JSON.stringify(pending));
  } catch {
    // Private mode without storage: the in-app prompt still shows the invitation after sign-in.
  }
  url.searchParams.delete("staffInvite");
  url.searchParams.delete("t");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return pending;
}

export function readPendingJoin(
  storage: Pick<Storage, "getItem" | "removeItem">,
  now = Date.now()
): PendingJoin | null {
  try {
    const raw = storage.getItem(pendingJoinStorageKey);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<PendingJoin>;
    if (
      typeof parsed.invitationId !== "string" ||
      typeof parsed.joinToken !== "string" ||
      typeof parsed.savedAt !== "number" ||
      now - parsed.savedAt > pendingJoinTtlMs
    ) {
      storage.removeItem(pendingJoinStorageKey);
      return null;
    }
    return parsed as PendingJoin;
  } catch {
    return null;
  }
}

export function clearPendingJoin(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(pendingJoinStorageKey);
  } catch {
    // Nothing to clear.
  }
}
