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

// The Runtime Handoff Protocol's per-turn conversation checkpoint and the pointer to it
// (docs/architecture/runtime-handoff-protocol.md). Every turn appends one, so their contents
// always change. They are not hashed whole; what they say about actions is kept instead: see
// `checkpointActions`.
const checkpoints = new Set(["runtimeHandoffs", "runtimeTaskHeads"]);

/**
 * What the checkpoints claim was done or is waiting: every pending action, and every completed
 * action whose tool a regenerated turn is not allowed to run, per task. Each task contributes two
 * views: the union over all of its checkpoints, and the checkpoint its head points at now (so a
 * head moved back to an older checkpoint with a pending action is seen even though no checkpoint
 * changed). Answers and allowed read-only tools are left out, so an ordinary regenerate leaves
 * this unchanged and any action, on any task, changes it.
 */
function checkpointActions(
  handoffs: unknown,
  heads: unknown,
  allowedTool: (toolName: string) => boolean
): string {
  type Handoff = {
    id?: unknown;
    taskId?: unknown;
    pendingActions?: unknown;
    completedActions?: unknown;
  };
  const records = (Array.isArray(handoffs) ? handoffs : []) as Array<Handoff | null>;
  const actionsOf = (record: Handoff | null | undefined): string[] => {
    const actions: string[] = [];
    for (const action of Array.isArray(record?.pendingActions) ? record.pendingActions : [])
      actions.push(`pending:${canonical(action)}`);
    for (const action of Array.isArray(record?.completedActions) ? record.completedActions : []) {
      const tool = (action as { description?: unknown } | null)?.description;
      if (typeof tool !== "string" || !allowedTool(tool)) actions.push(`done:${canonical(action)}`);
    }
    return actions;
  };
  const claims = new Set<string>();
  for (const record of records)
    for (const action of actionsOf(record))
      claims.add(`task:${canonical(record?.taskId)}|${action}`);
  for (const head of Array.isArray(heads) ? heads : []) {
    const { taskId, activeHandoffId } = (head ?? {}) as {
      taskId?: unknown;
      activeHandoffId?: unknown;
    };
    const active = records.find((record) => record?.id === activeHandoffId);
    const prefix = `active:${canonical(taskId)}|`;
    if (activeHandoffId != null && active === undefined) claims.add(`${prefix}missing`);
    if (active !== undefined && active?.taskId !== taskId) claims.add(`${prefix}wrong-task`);
    for (const action of actionsOf(active)) claims.add(prefix + action);
  }
  return `[${[...claims].sort().join(",")}]`;
}

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
  replyId: string,
  /** Tools a regenerated turn may run. Default: none, so every completed action counts. */
  allowedTool: (toolName: string) => boolean = () => false
): string {
  return JSON.stringify(
    Object.fromEntries(
      [
        ...Object.entries(snapshot),
        [
          "checkpointActions",
          checkpointActions(snapshot.runtimeHandoffs, snapshot.runtimeTaskHeads, allowedTool)
        ] as const
      ]
        .filter(([key]) => !turnBookkeeping.has(key) && !checkpoints.has(key))
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
