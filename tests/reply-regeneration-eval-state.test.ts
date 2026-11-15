import { describe, expect, it } from "vitest";
import { regenerationBusinessState } from "../scripts/lib/reply-regeneration-state";

const initial = () => ({
  products: [{ id: "product", quantity: 4 }],
  memberships: [{ id: "member", role: "viewer" }],
  runtimeTaskHeads: [{ id: "task", status: "waiting" }],
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
        next.runtimeTaskHeads[0]!.status = "executed";
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

  it("preserves nested sequence order when comparing business records", () => {
    expect(state({ approvals: [{ steps: ["approve", "execute"] }] })).not.toBe(
      state({ approvals: [{ steps: ["execute", "approve"] }] })
    );
  });
});
