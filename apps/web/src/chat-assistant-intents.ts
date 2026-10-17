/** Only explicit shopping requests bypass the assistant. */
export function parseMarketplaceBuyIntent(message: string): string | null {
  const text = message.trim().replace(/\s+/gu, " ");
  if (
    !/^(?:(?:i\s+(?:want|need|would like)\s+to|can\s+i|where\s+can\s+i|please)\s+)?(?:buy|purchase|order)\b/iu.test(
      text
    ) &&
    !/\b(?:looking for|do you have|have you got|find me)\b/iu.test(text) &&
    !/^(?:natafuta|ninatafuta|nitafutie|nunua)\s+/iu.test(text)
  )
    return null;
  // Tracking an order is not an instruction to search for a product named "order".
  if (/\b(?:track|tracking|delivery|remind|reminder)\b/iu.test(text)) return null;
  return (
    text
      .replace(/^i\s+(?:want|need|would like)\s+to\s+(?:buy|purchase|order|get)\s+/iu, "")
      .replace(/^i\s*(?:am|'m)?\s*looking\s+for\s+/iu, "")
      .replace(/^can\s+i\s+(?:buy|purchase|order|get)\s+/iu, "")
      .replace(/^where\s+can\s+i\s+(?:buy|purchase|get)\s+/iu, "")
      .replace(
        /^(?:can you\s+|please\s+)?(?:do you have|have you got|find me|natafuta|ninatafuta|nitafutie|nunua)\s+/iu,
        ""
      )
      .replace(/[?]+$/u, "")
      .trim() || null
  );
}

export type ReminderIntent =
  | { kind: "schedule"; runAt: string; message: string }
  | { kind: "clarify" }
  | { kind: "cancel" }
  | null;

/** Relative times are unambiguous across time zones. Other requests ask for clarification. */
export function parseReminderIntent(message: string, now = Date.now()): ReminderIntent {
  if (/^cancel (?:my |the )?(?:last |latest )?reminder[.!]?$/iu.test(message.trim()))
    return { kind: "cancel" };
  if (!/^(?:remind me|set (?:a )?reminder|nikumbushe)\b/iu.test(message.trim())) return null;
  const match = message
    .trim()
    .match(
      /^(?:remind me|set (?:a )?reminder)\s+in\s+(\d+(?:\.\d+)?|one|two|three|five|ten|an?|half)\s+(seconds?|minutes?|hours?|days?)\s+(?:to\s+)?(.+?)[.!]?$/iu
    );
  if (!match) return { kind: "clarify" };
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    five: 5,
    ten: 10,
    a: 1,
    an: 1,
    half: 0.5
  };
  const amount = words[match[1]!.toLowerCase()] ?? Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const delay =
    amount *
    (unit.startsWith("second")
      ? 1000
      : unit.startsWith("minute")
        ? 60_000
        : unit.startsWith("hour")
          ? 3_600_000
          : 86_400_000);
  if (!Number.isFinite(delay) || delay < 1000 || delay > 365 * 86_400_000 || !match[3]!.trim())
    return { kind: "clarify" };
  return {
    kind: "schedule",
    runAt: new Date(now + delay).toISOString(),
    message: match[3]!.trim()
  };
}

export function isDeliveryTrackingIntent(message: string): boolean {
  return /\btrack(?:ing)?\b.*\b(?:delivery|order|checkout)\b/iu.test(message);
}
