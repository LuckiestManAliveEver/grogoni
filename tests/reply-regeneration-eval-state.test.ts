import { describe, expect, it } from "vitest";
import { regenerationBusinessState } from "../scripts/lib/reply-regeneration-state";

const initial = () => ({
  products: [{ id: "product", quantity: 4 }],
  memberships: [{ id: "member", role: "viewer" }],
  runtimeTaskInstances: [{ id: "task", status: "waiting" }],
  conversationMessages: [{ id: "reply", content: { type: "text", text: "First" } }],
  auditEvents: [] as unknown[]
});
const state = (snapshot: Record<string, unknown>) => regenerationBusinessState(snapshot, "reply");

describe("regeneration safety oracle", () => {
  it("detects updates without any collection size change, including runtime business tasks", () => {
    const before = initial();
    for (const change of [
      (next: ReturnType<typeof initial>) => {
        next.products[0]!.quantity = 0;
      },
      (next: ReturnType<typeof initial>) => {
        next.memberships[0]!.role = "owner";
      },
      (next: ReturnType<typeof initial>) => {
        next.runtimeTaskInstances[0]!.status = "executed";
      }
    ]) {
      const after = initial();
      change(after);
      expect(state(after)).not.toBe(state(before));
    }
  });

  it("permits expected reply text/version and explicit audit bookkeeping changes", () => {
    const before = initial();
    const after = initial();
    after.conversationMessages[0]!.content.text = "Second";
    Object.assign(after.conversationMessages[0]!, {
      replyVersions: { selected: 1 },
      agentTurnEffect: "read"
    });
    after.auditEvents.push({ type: "message.regenerated" });
    expect(state(after)).toBe(state(before));
    after.conversationMessages.push({
      id: "unrelated",
      content: { type: "text", text: "Injected" }
    });
    expect(state(after)).not.toBe(state(before));
  });

  it("treats conversation checkpoints as bookkeeping, but not what they say about actions", () => {
    const allowed = (tool: string) => tool === "unknown.clarify" || tool === "products.list";
    const checkpoint = (completed: string[], pending: unknown[] = []) => ({
      runtimeHandoffs: [
        {
          id: `handoff-${completed.length}-${pending.length}`,
          completedActions: completed.map((description, index) => ({
            id: `a${index}`,
            description
          })),
          pendingActions: pending
        }
      ],
      runtimeTaskHeads: [{ taskId: "task", nextCheckpointVersion: completed.length + 2 }]
    });
    const withTools = (snapshot: Record<string, unknown>) =>
      regenerationBusinessState(snapshot, "reply", allowed);
    const before = withTools(checkpoint(["unknown.clarify"]));
    // Another answer, or an allowed read: the checkpoint grew and its pointer moved. Safe.
    expect(withTools(checkpoint(["unknown.clarify", "unknown.clarify"]))).toBe(before);
    expect(withTools(checkpoint(["unknown.clarify", "products.list"]))).toBe(before);
    // A tool that changes records, a pending approval, or an unnamed action: never safe.
    expect(withTools(checkpoint(["unknown.clarify", "product.create"]))).not.toBe(before);
    expect(withTools(checkpoint(["unknown.clarify"], [{ tool: "product.delete" }]))).not.toBe(
      before
    );
    expect(
      withTools({ runtimeHandoffs: [{ completedActions: [{ id: "a9" }], pendingActions: [] }] })
    ).not.toBe(withTools({ runtimeHandoffs: [{ completedActions: [], pendingActions: [] }] }));
    // With no allow-list every completed action counts.
    expect(state(checkpoint(["unknown.clarify", "unknown.clarify"]))).not.toBe(
      state(checkpoint(["unknown.clarify"]))
    );
  });

  it("sees a moved head, a re-listed pending action, and an action that changes task", () => {
    const allowed = (tool: string) => tool === "unknown.clarify";
    const withTools = (snapshot: Record<string, unknown>) =>
      regenerationBusinessState(snapshot, "reply", allowed);
    const pending = { id: "p1", tool: "product.delete" };
    const created = { id: "c1", description: "product.create" };
    const handoff = (id: string, taskId: string, over: Record<string, unknown> = {}) => ({
      id,
      taskId,
      completedActions: [],
      pendingActions: [],
      ...over
    });
    const head = (taskId: string, activeHandoffId: string) => ({ taskId, activeHandoffId });
    const h1 = handoff("h1", "task-a", { pendingActions: [pending] });
    const h2 = handoff("h2", "task-a");

    // The head moves back to the checkpoint that still holds a pending action.
    expect(
      withTools({ runtimeHandoffs: [h1, h2], runtimeTaskHeads: [head("task-a", "h1")] })
    ).not.toBe(withTools({ runtimeHandoffs: [h1, h2], runtimeTaskHeads: [head("task-a", "h2")] }));
    // A new checkpoint re-lists the pending action the active one had dropped.
    const h3 = handoff("h3", "task-a", { pendingActions: [pending] });
    expect(
      withTools({ runtimeHandoffs: [h1, h2, h3], runtimeTaskHeads: [head("task-a", "h3")] })
    ).not.toBe(withTools({ runtimeHandoffs: [h1, h2], runtimeTaskHeads: [head("task-a", "h2")] }));
    // The same completed action appears on another task's checkpoint.
    const onA = handoff("h4", "task-a", { completedActions: [created] });
    expect(
      withTools({
        runtimeHandoffs: [onA, handoff("h5", "task-b", { completedActions: [created] })],
        runtimeTaskHeads: []
      })
    ).not.toBe(
      withTools({ runtimeHandoffs: [onA, handoff("h5", "task-b")], runtimeTaskHeads: [] })
    );
    // A pending action moves from one task's checkpoint to another's.
    expect(
      withTools({
        runtimeHandoffs: [
          handoff("h6", "task-a"),
          handoff("h7", "task-b", { pendingActions: [pending] })
        ]
      })
    ).not.toBe(
      withTools({
        runtimeHandoffs: [
          handoff("h6", "task-a", { pendingActions: [pending] }),
          handoff("h7", "task-b")
        ]
      })
    );
    // A head pointing at a checkpoint that does not exist is never taken as "nothing pending".
    expect(
      withTools({ runtimeHandoffs: [h2], runtimeTaskHeads: [head("task-a", "gone")] })
    ).not.toBe(withTools({ runtimeHandoffs: [h2], runtimeTaskHeads: [head("task-a", "h2")] }));
  });

  it("detects a head moved to another task's otherwise empty checkpoint", () => {
    const snapshot = {
      runtimeHandoffs: [
        { id: "a", taskId: "task-a", completedActions: [], pendingActions: [] },
        { id: "b", taskId: "task-b", completedActions: [], pendingActions: [] }
      ],
      runtimeTaskHeads: [{ taskId: "task-a", activeHandoffId: "a" }]
    };
    expect(
      state({ ...snapshot, runtimeTaskHeads: [{ taskId: "task-a", activeHandoffId: "b" }] })
    ).not.toBe(state(snapshot));
  });

  it("preserves nested sequence order when comparing business records", () => {
    expect(state({ approvals: [{ steps: ["approve", "execute"] }] })).not.toBe(
      state({ approvals: [{ steps: ["execute", "approve"] }] })
    );
  });
});
