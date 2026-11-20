// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  outboxStoredPayload,
  queueMessagingOutbox,
  readMessagingOutbox
} from "../apps/web/src/messaging/outbox";

/** docs/audits/instant-messaging-remaining-2026-11-19.md: "No tokens or cookies in outbox
 * entries". The outbox writes request bodies to device storage; the session is the HttpOnly
 * cookie, so a queued message must never carry a credential. */
describe("messaging outbox credentials", () => {
  const realPayload = {
    conversationId: "conversation-1",
    clientMessageId: "client-message-0001",
    content: { type: "text", text: "My PIN is not in a field, it is just text: 3927" },
    replyToMessageId: null,
    clientTimestamp: "2026-11-20T10:00:00.000Z",
    agent: { businessId: "business-1", runtimeSessionId: "runtime-1", message: "hello" }
  };

  it("stores the payload the app actually sends unchanged", () => {
    expect(outboxStoredPayload(realPayload)).toEqual(realPayload);
  });

  it("drops credential fields at any depth before anything reaches storage", () => {
    const writes: string[] = [];
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes.push(value);
        values.set(key, value);
      },
      removeItem: (key: string) => void values.delete(key)
    };
    queueMessagingOutbox(
      {
        accountId: "account-1",
        clientMessageId: "client-message-0002",
        payload: {
          ...realPayload,
          sessionToken: "tok-session-SECRET",
          Authorization: "Bearer tok-bearer-SECRET",
          agent: { ...realPayload.agent, accessToken: "tok-access-SECRET" },
          attachments: [{ id: "a1", cookie: "grogoni_session=tok-cookie-SECRET", pin: "1234" }]
        }
      },
      storage
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const written of writes) {
      expect(written).not.toMatch(/tok-[a-z]+-SECRET/u);
      expect(written).not.toContain('"pin"');
    }
    const [stored] = readMessagingOutbox("account-1", storage);
    expect(stored?.payload).toEqual({ ...realPayload, attachments: [{ id: "a1" }] });
  });
});
