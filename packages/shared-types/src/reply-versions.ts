/**
 * Reply versions: regenerating an agent reply keeps every earlier answer as a version of the same
 * message (docs/architecture/conversation-reply-versions.md).
 *
 * The versions live inside the one agent message, and `content.text` always mirrors the selected
 * version. A client that knows nothing about versions therefore still sees one ordinary reply, the
 * sync feed still carries one entity, and the conversation stays a single line: no version ever
 * hides, reorders or rewrites another message.
 *
 * The sibling-version model (previous / next, "2 / 3") follows the DeepSeek Chat Demo's
 * `src/services/chat/branches.ts` (MIT, see THIRD_PARTY_NOTICES.md). No source is copied: that
 * project keeps a parent-linked tree of whole conversations on one device, which would let a switch
 * hide messages that record business actions.
 *
 * Everything here is pure and shared by the API (the authority) and the web client (which only
 * decides what to offer).
 */

/** A reply keeps at most this many versions; the oldest is never dropped to make room. */
export const maxReplyVersions = 5;

/**
 * What the agent turn behind a reply did.
 * - "none": it answered in words; no tool ran.
 * - "read": a read-only tool ran (a list, a search, a report).
 * - "action": a tool that changes business records ran, or one is waiting for approval.
 */
export type AgentTurnEffect = "none" | "read" | "action";

export interface ConversationReplyVersion {
  /** "original" for the first answer; otherwise the id the client chose for its regenerate request. */
  id: string;
  text: string;
  createdAt: string;
  /**
   * Which revision of the question this version answered: the question's `editedAt` when the
   * version was written, or null when it had never been edited. Never the question's text, so
   * wording a person edited away is not kept on the reply. Absent on an original answer whose
   * question had already been edited when its versions were first recorded: which revision it
   * answered is then not known, and is not guessed.
   */
  questionRevision?: string | null;
}

export interface ConversationReplyVersions {
  /** Index into `versions` of the answer shown in `content.text`. */
  selected: number;
  /** Oldest first. Versions are appended, never edited, reordered or removed. */
  versions: ConversationReplyVersion[];
}

export const originalReplyVersionId = "original";

/** Why a reply cannot be regenerated; null from `replyRegenerationBlock` means it can. */
export type ReplyRegenerationBlock =
  | "not_agent_reply"
  | "deleted"
  | "not_text"
  | "has_attachments"
  | "business_task"
  | "turn_effect_unknown"
  | "turn_acted"
  | "version_limit";

/** The fields of a conversation message that decide whether its reply may be regenerated. */
export interface ReplyVersionSubject {
  author: string;
  deletedAt?: string | null;
  replyToMessageId?: string | null;
  createdAt: string;
  content: { type: string; text?: string; attachments?: unknown[]; businessTask?: unknown };
  agentTurnEffect?: AgentTurnEffect;
  replyVersions?: ConversationReplyVersions;
}

/**
 * Fails closed. Only a plain-text agent answer whose turn is known to have changed nothing can get
 * another version: a confirmation, a card, a delivered file, a business task, a reply written
 * before `agentTurnEffect` was recorded, or one whose turn acted on business records all stay as
 * they are.
 */
export function replyRegenerationBlock(
  message: ReplyVersionSubject
): ReplyRegenerationBlock | null {
  if (message.author !== "agent" || !message.replyToMessageId) return "not_agent_reply";
  if (message.deletedAt) return "deleted";
  if (message.content.type !== "text" || typeof message.content.text !== "string")
    return "not_text";
  if ((message.content.attachments?.length ?? 0) > 0) return "has_attachments";
  if (message.content.businessTask !== undefined) return "business_task";
  if (message.agentTurnEffect === undefined) return "turn_effect_unknown";
  if (message.agentTurnEffect === "action") return "turn_acted";
  if (replyVersionsOf(message).versions.length >= maxReplyVersions) return "version_limit";
  return null;
}

/** A reply's versions; one never regenerated is a single "original" version. */
export function replyVersionsOf(message: ReplyVersionSubject): ConversationReplyVersions {
  const stored = message.replyVersions;
  if (stored !== undefined && stored.versions.length > 0) {
    const selected = Number.isInteger(stored.selected)
      ? Math.min(Math.max(stored.selected, 0), stored.versions.length - 1)
      : stored.versions.length - 1;
    return { selected, versions: stored.versions };
  }
  return {
    selected: 0,
    versions: [
      {
        id: originalReplyVersionId,
        text: typeof message.content.text === "string" ? message.content.text : "",
        createdAt: message.createdAt
      }
    ]
  };
}

/** Appends a version and selects it. The earlier versions are carried over untouched. */
export function appendReplyVersion(
  current: ConversationReplyVersions,
  version: ConversationReplyVersion
): ConversationReplyVersions {
  const versions = [...current.versions, version];
  return { selected: versions.length - 1, versions };
}

/** The versions with `index` selected, or null when there is no such version. */
export function selectReplyVersion(
  current: ConversationReplyVersions,
  index: number
): ConversationReplyVersions | null {
  if (!Number.isInteger(index) || index < 0 || index >= current.versions.length) return null;
  return { selected: index, versions: current.versions };
}

/** The more consequential of two effects: a reply keeps the strongest effect any version had. */
export function strongerAgentTurnEffect(a: AgentTurnEffect, b: AgentTurnEffect): AgentTurnEffect {
  const rank: Record<AgentTurnEffect, number> = { none: 0, read: 1, action: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/** Version ids are client-chosen retry keys: 8 to 64 URL-safe characters, never "original". */
export function isReplyVersionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{8,64}$/u.test(value) &&
    value !== originalReplyVersionId
  );
}
