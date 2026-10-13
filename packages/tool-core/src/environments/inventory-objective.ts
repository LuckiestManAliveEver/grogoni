export type InventoryTaskObjective =
  | { kind: "OTHER" }
  | { kind: "CLARIFY"; message: string }
  | { kind: "PREPARE"; budgetMinor: number; currency: "KES"; horizonDays: number };

/** Bounded first-party recipe selection, not a second autonomous planner. */
export function parseInventoryTaskObjective(text: string): InventoryTaskObjective {
  if (
    !/\b(inventory|stock|products?)\b/iu.test(text) ||
    !/\b(replenish\w*|reorder\w*|restock\w*|purchase orders?)\b/iu.test(text)
  )
    return { kind: "OTHER" };
  if (text.length > 4000)
    return { kind: "CLARIFY", message: "Please shorten the replenishment request." };
  if (/\b(do not|don't|never|cancel|stop|reject)\b/iu.test(text))
    return {
      kind: "CLARIFY",
      message:
        "I have not started a replenishment task. Please confirm when you want purchase drafts prepared."
    };
  if (/\b(USD|EUR|GBP|UGX|TZS|RWF|ZAR|NGN)\b/iu.test(text))
    return {
      kind: "CLARIFY",
      message: "This replenishment recipe needs one explicit budget in KES."
    };
  if (/\b(submit|send|pay|place)\b/iu.test(text))
    return {
      kind: "CLARIFY",
      message:
        "I can prepare purchase drafts, but supplier submission is not connected. Please request draft preparation only."
    };
  const amounts = [
    ...text.matchAll(/\bKES\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?!\d|[.,]\d|[A-Za-z])/giu)
  ];
  const periods = [
    ...text.matchAll(/\b(?:within|for|next)\s+(one|two|three|four|five|six|seven|\d+)\s+days?\b/giu)
  ];
  if (amounts.length !== 1 || periods.length !== 1)
    return {
      kind: "CLARIFY",
      message: "What is the purchase budget in KES, and how many days should the stock cover?"
    };
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7
  };
  const horizon = periods[0]![1]!.toLowerCase();
  const horizonDays = words[horizon] ?? Number(horizon);
  const [whole, fraction = ""] = amounts[0]![1]!.replaceAll(",", "").split(".");
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (
    minor <= 0n ||
    minor > BigInt(Number.MAX_SAFE_INTEGER) ||
    !Number.isInteger(horizonDays) ||
    horizonDays < 1 ||
    horizonDays > 365
  )
    return {
      kind: "CLARIFY",
      message: "Please provide a positive KES budget and a stock horizon between 1 and 365 days."
    };
  return { kind: "PREPARE", budgetMinor: Number(minor), currency: "KES", horizonDays };
}
