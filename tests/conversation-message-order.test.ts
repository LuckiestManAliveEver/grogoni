import { describe, expect, it } from "vitest";
import type { ConversationMessageSummary } from "@grogoni/shared-types";
import { compareConversationMessages } from "../apps/web/src/messaging/message-order";
const message = (id: string, at: string, serverSequence?: number) =>
  ({
    id,
    clientMessageId: id,
    createdAt: at,
    clientTimestamp: at,
    ...(serverSequence === undefined ? {} : { serverSequence })
  }) as ConversationMessageSummary;
describe("conversation message order", () => {
  it("uses server acceptance order despite skewed client clocks and preserves legacy history", () => {
    const legacy = message("legacy", "2026-11-18T09:00:00Z");
    const first = message("first", "2026-11-18T12:00:00Z", 10);
    const second = message("second", "2026-11-18T08:00:00Z", 11);
    const values = [second, legacy, first];
    expect(values.sort(compareConversationMessages).map((item) => item.id)).toEqual([
      "legacy",
      "first",
      "second"
    ]);
    for (const a of values)
      for (const b of values)
        for (const c of values)
          if (compareConversationMessages(a, b) <= 0 && compareConversationMessages(b, c) <= 0)
            expect(compareConversationMessages(a, c)).toBeLessThanOrEqual(0);
  });
  it("breaks legacy timestamp ties with the stable client id", () => {
    const at = "2026-11-18T09:00:00Z";
    expect(
      [message("b", at), message("a", at)].sort(compareConversationMessages).map((item) => item.id)
    ).toEqual(["a", "b"]);
  });
});
