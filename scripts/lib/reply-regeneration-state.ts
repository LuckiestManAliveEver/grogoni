import { createHash } from "node:crypto";

// Explicit turn bookkeeping only. A broad /runtime|evaluation|.../ exclusion could hide
// changes to business tasks, approvals, permissions or model configuration.
const turnBookkeeping = new Set([
  "auditEvents",
  "syncChanges",
  "runtimeSessions",
  "runtimeTurns",
  "runtimeExecutionEvents",
  "runtimeExperiences",
  "agentEvaluationEvents"
]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Hash record contents so equal-sized collections cannot conceal an update in the safety eval. */
export function regenerationBusinessState(
  snapshot: Record<string, unknown>,
  replyId: string
): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(snapshot)
        .filter(([key]) => !turnBookkeeping.has(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => {
          const normalized =
            key === "conversationMessages" && Array.isArray(value)
              ? value.map((message: Record<string, unknown>) => {
                  if (message.id !== replyId) return message;
                  const unchanged = { ...message };
                  delete unchanged.replyVersions;
                  delete unchanged.agentTurnEffect;
                  const content = { ...(message.content as Record<string, unknown>) };
                  delete content.text;
                  return { ...unchanged, content };
                })
              : value;
          const serialized = Array.isArray(normalized)
            ? `[${normalized.map(canonical).sort().join(",")}]`
            : canonical(normalized);
          return [key, createHash("sha256").update(serialized).digest("hex")];
        })
    )
  );
}
