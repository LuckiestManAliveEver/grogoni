/**
 * The version id a regenerate request carries is its retry key: the server answers a repeated id
 * with the version it already wrote (docs/architecture/conversation-reply-versions.md). A request
 * whose answer never arrived (a dropped connection, a 5xx) therefore keeps its id, so tapping
 * Regenerate again cannot write the same answer twice; any settled outcome releases it.
 *
 * Dependency-free so it can be unit-tested without the hooks' Vite globals.
 */
/** What the chat surface needs to offer reply versions (hooks/useReplyVersions.ts). */
export interface ReplyVersionControls {
  /** False when this viewer cannot ask at all: no open conversation, or not their own shop's agent. */
  available: boolean;
  /** The reply a new version is being written for, or null. */
  regeneratingMessageId: string | null;
  /** Asks for another version of an agent reply; offered only when `message.regenerable`. */
  onRegenerate: (messageId: string) => void;
  /** Stops waiting for the version being written. */
  onCancel: () => void;
  onSelect: (messageId: string, index: number) => void;
}

export interface ReplyVersionRequests {
  /** The id to send for this reply: the unsettled one when there is one, otherwise a new id. */
  idFor: (messageId: string) => string;
  /** The server answered (a version, or a refusal that will not change): forget the id. */
  settle: (messageId: string) => void;
  /** Sign-out: forgets every id and never writes to storage again, even for a late answer. */
  dispose: () => void;
}

/** Where unsettled ids are kept. Session storage in the browser; a plain map in tests. */
export interface ReplyVersionKeyStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/** The single key an earlier build used for every account; only ever removed now. */
const legacyStorageKey = "grogoni:reply-version-requests";
const storageKeyPrefix = `${legacyStorageKey}:`;
/** One storage entry per account: ids asked for by one account are never offered to another. */
export const replyVersionStorageKey = (accountId: string) => `${storageKeyPrefix}${accountId}`;

export function createReplyVersionRequests(
  newId: () => string = () => crypto.randomUUID(),
  store: ReplyVersionKeyStore | null = null,
  storageKey: string = replyVersionStorageKey("unscoped")
): ReplyVersionRequests {
  const read = (): Record<string, string> => {
    try {
      const parsed: unknown = JSON.parse(store?.getItem(storageKey) ?? "{}");
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  };
  // Storage can be blocked or full: the map in memory still covers this page's lifetime.
  const unsettled = new Map<string, string>(
    Object.entries(read()).filter(([, id]) => typeof id === "string")
  );
  let disposed = false;
  const save = () => {
    if (disposed) return;
    try {
      store?.setItem(storageKey, JSON.stringify(Object.fromEntries(unsettled)));
    } catch {
      // Kept in memory only.
    }
  };
  return {
    idFor(messageId) {
      const existing = unsettled.get(messageId);
      if (existing !== undefined) return existing;
      const id = newId();
      unsettled.set(messageId, id);
      save();
      return id;
    },
    settle(messageId) {
      if (unsettled.delete(messageId)) save();
    },
    dispose() {
      disposed = true;
      unsettled.clear();
    }
  };
}

const shared = new Map<string, ReplyVersionRequests>();

function sessionKeyStore(): ReplyVersionKeyStore | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * One account's retry keys for this page. They outlive the chat surface (which unmounts when
 * another panel replaces it) and, through session storage, a reload: a version that may still be
 * written is asked for again with the id it was first asked with. Keys are held per account, so
 * switching accounts in the same tab never sends one account's id for another's reply.
 */
export function sharedReplyVersionRequests(accountId: string): ReplyVersionRequests {
  let requests = shared.get(accountId);
  if (requests === undefined) {
    requests = createReplyVersionRequests(
      undefined,
      sessionKeyStore(),
      replyVersionStorageKey(accountId)
    );
    shared.set(accountId, requests);
  }
  return requests;
}

/**
 * Sign-out and account reset: drops every account's retry keys from memory and from session
 * storage. A version still being written then simply arrives on the next thread load.
 */
export function forgetReplyVersionRequests(
  store:
    | (ReplyVersionKeyStore & { length?: number; key?: (index: number) => string | null })
    | null = sessionKeyStore()
): void {
  const keys = [legacyStorageKey, ...[...shared.keys()].map(replyVersionStorageKey)];
  // A request still in flight holds its account's set: disposing it stops a late answer from
  // writing that account's ids back after sign-out.
  for (const requests of shared.values()) requests.dispose();
  shared.clear();
  try {
    for (let index = 0; index < (store?.length ?? 0); index += 1) {
      const key = store?.key?.(index);
      if (typeof key === "string" && key.startsWith(storageKeyPrefix)) keys.push(key);
    }
  } catch {
    // Enumeration can fail even when removal of known account keys still works.
  }
  for (const key of new Set(keys)) {
    try {
      store?.removeItem(key);
    } catch {
      // One blocked entry must not prevent removing the remaining account keys.
    }
  }
}

/** The parts of a thread message that decide what the viewer is offered. */
export interface ReplyVersionThreadMessage {
  id: string;
  author: string;
  body: string;
  deletedAt?: string | null;
  replyToMessageId?: string | null;
  attachments?: unknown[];
  regenerable?: boolean;
}

/** The viewer's own message that `reply` answers, or null: only the asker manages its versions. */
export function ownQuestionOf(
  reply: ReplyVersionThreadMessage,
  thread: ReplyVersionThreadMessage[]
): ReplyVersionThreadMessage | null {
  const question = thread.find((message) => message.id === reply.replyToMessageId);
  return question !== undefined && question.author === "merchant" ? question : null;
}

/**
 * Whether Regenerate is offered. Mirrors the server's checks (requireRegenerableReply) so the
 * control is not shown to someone it will refuse; the server still decides.
 */
export function canOfferRegenerate(
  reply: ReplyVersionThreadMessage,
  thread: ReplyVersionThreadMessage[],
  controls: Pick<ReplyVersionControls, "available">
): boolean {
  if (!controls.available || reply.regenerable !== true) return false;
  const question = ownQuestionOf(reply, thread);
  if (question === null || question.deletedAt || (question.attachments?.length ?? 0) > 0)
    return false;
  const text = question.body.replace(/^[\s\u200B-\u200D\u2060\uFEFF]+/u, "").trim();
  return text.length > 0 && !text.startsWith("/");
}

/** What the person is told when the server refuses to regenerate, by error code. */
export function regenerationRefusalMessage(code: string | null): string | null {
  switch (code) {
    case "regeneration_would_act":
      return "Another version of this reply would change business records. Send it as a new message instead.";
    case "reply_version_limit":
      return "This reply already has the most versions it can keep.";
    case "reply_not_regenerable":
      return "This reply cannot be regenerated.";
    case "reply_regeneration_forbidden":
      return "Only the person who asked can regenerate this reply.";
    default:
      return null;
  }
}
