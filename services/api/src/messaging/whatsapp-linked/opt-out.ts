/**
 * Recognises a WhatsApp opt-out ("STOP") or opt-in ("START") command. One rule, shared by the
 * connector (assistant replies) and the canonical store (recipient opt-out), so the two can never
 * disagree about what a customer asked for.
 *
 * The whole message must be the command. Case, surrounding whitespace, punctuation, symbols and
 * emoji are ignored ("Stop.", "STOP!", " stop ", "stop 🙏", "opt-out"), and a few well-known
 * synonyms count. A sentence that merely contains the word never matches ("don't stop sending",
 * "please stop by tomorrow"): a false opt-out silently cuts a customer off, so the list is short
 * and exact on purpose.
 *
 * Deliberately not opt-out words here: CANCEL, END and QUIT. They are SMS carrier keywords, but in
 * a shop's WhatsApp chat "Cancel" almost always means "cancel my order".
 */
export type LinkedOptOutCommand = "stop" | "start";

const stopCommands = new Set([
  "stop",
  "stop all",
  "stopall",
  "stop messages",
  "stop messaging",
  "unsubscribe",
  "unsub",
  "opt out",
  "optout"
]);
const startCommands = new Set(["start", "unstop", "subscribe", "resubscribe", "opt in", "optin"]);

/** Anything a person types around a command word: spaces, punctuation, symbols, emoji parts. */
const edge = /^[\s\p{P}\p{S}\p{M}\p{Cf}]+|[\s\p{P}\p{S}\p{M}\p{Cf}]+$/gu;

export function linkedOptOutCommand(text: string): LinkedOptOutCommand | null {
  // Commands are short; never normalise a long message just to reject it.
  if (text.length > 64) return null;
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(edge, "")
    .replace(/[\s_-]+/gu, " ");
  if (stopCommands.has(normalized)) return "stop";
  if (startCommands.has(normalized)) return "start";
  return null;
}
