import { describe, expect, it } from "vitest";
import { ApiRequestError, isRetryableApiRequestError } from "../apps/web/src/lib/api";
import {
  clearMessagingOutbox,
  queueMessagingOutbox,
  readMessagingOutbox,
  removeMessagingOutboxEntry,
  type MessagingOutboxStorage
} from "../apps/web/src/messaging/outbox";

class MemoryStorage implements MessagingOutboxStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("messaging outbox", () => {
  it("isolates queued messages by account and removes unsafe legacy entries", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "grogoni.messaging-outbox.v1",
      JSON.stringify([{ clientMessageId: "legacy-message", payload: { text: "private" } }])
    );

    queueMessagingOutbox(
      {
        accountId: "account-a",
        clientMessageId: "message-a",
        payload: { conversationId: "conversation-a" }
      },
      storage
    );
    queueMessagingOutbox(
      {
        accountId: "account-b",
        clientMessageId: "message-b",
        payload: { conversationId: "conversation-b" }
      },
      storage
    );

    expect(storage.getItem("grogoni.messaging-outbox.v1")).toBeNull();
    expect(readMessagingOutbox("account-a", storage)).toEqual([
      expect.objectContaining({ accountId: "account-a", clientMessageId: "message-a" })
    ]);
    expect(readMessagingOutbox("account-b", storage)).toEqual([
      expect.objectContaining({ accountId: "account-b", clientMessageId: "message-b" })
    ]);

    removeMessagingOutboxEntry("account-a", "message-a", storage);
    expect(readMessagingOutbox("account-a", storage)).toEqual([]);
    expect(readMessagingOutbox("account-b", storage)).toHaveLength(1);

    clearMessagingOutbox("account-b", storage);
    expect(readMessagingOutbox("account-b", storage)).toEqual([]);
  });

  it("classifies only network, throttling, and server failures as retryable", () => {
    expect(isRetryableApiRequestError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryableApiRequestError(new ApiRequestError(429, "Slow down"))).toBe(true);
    expect(isRetryableApiRequestError(new ApiRequestError(503, "Unavailable"))).toBe(true);
    expect(isRetryableApiRequestError(new ApiRequestError(409, "Conflict"))).toBe(false);
    expect(isRetryableApiRequestError(new ApiRequestError(400, "Invalid"))).toBe(false);
    expect(isRetryableApiRequestError(new Error("Unknown"))).toBe(false);
  });
});
