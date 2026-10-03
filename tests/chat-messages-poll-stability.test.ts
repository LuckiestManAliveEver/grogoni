import { describe, expect, it } from "vitest";

import { chatMessagesEqual } from "../apps/web/src/chat-messages-equal";
import type { ChatMessage } from "../apps/web/src/app-shell";

/**
 * The 4-second foreground poll (GrogoniApplication.tsx) remaps the whole conversation thread into a
 * brand-new array on every tick, whether or not anything changed. Without a content-equality
 * guard, that new array reference alone was enough to churn chatMessages every 4 seconds while a
 * user might be mid-draft in a generated card (e.g. "Add product") sitting in the same render
 * tree - the reported "keep having to reselect the text box" symptom. chatMessagesEqual is the
 * guard that lets setChatMessages skip the update (and keep the same array reference) when the
 * newly-fetched thread is identical to what's already there.
 */
describe("chatMessagesEqual - poll stability guard", () => {
  const base: ChatMessage = {
    id: "message-1",
    author: "grogoniclaw",
    body: "Here is your product card"
  };

  it("treats an identical re-fetched array as equal, even with a new array/object reference", () => {
    const a: ChatMessage[] = [{ ...base }];
    const b: ChatMessage[] = [{ ...base }];
    expect(a).not.toBe(b);
    expect(chatMessagesEqual(a, b)).toBe(true);
  });

  it("treats the same reference as equal without doing any comparison work", () => {
    const a: ChatMessage[] = [{ ...base }];
    expect(chatMessagesEqual(a, a)).toBe(true);
  });

  it("detects a genuinely new message", () => {
    const a: ChatMessage[] = [{ ...base }];
    const b: ChatMessage[] = [{ ...base }, { id: "message-2", author: "merchant", body: "Thanks" }];
    expect(chatMessagesEqual(a, b)).toBe(false);
  });

  it("detects an edit, a reaction, or a status change to an existing message", () => {
    const a: ChatMessage[] = [{ ...base }];
    expect(chatMessagesEqual(a, [{ ...base, body: "Edited body" }])).toBe(false);
    expect(chatMessagesEqual(a, [{ ...base, reactions: [{ emoji: "👍", actorId: "u1" }] }])).toBe(
      false
    );
    expect(chatMessagesEqual(a, [{ ...base, status: "sent" }])).toBe(false);
  });

  it("detects a changed generated-card content payload even when the message id is unchanged", () => {
    const withCard: ChatMessage = {
      ...base,
      content: { type: "product-management", businessId: "biz-1" }
    };
    const withDifferentCard: ChatMessage = {
      ...base,
      content: { type: "product-management", businessId: "biz-1", productId: "prod-1" }
    };
    expect(chatMessagesEqual([withCard], [withDifferentCard])).toBe(false);
  });
});
