import { describe, expect, it, vi } from "vitest";
import { ApiRequestError, isRetryableApiRequestError } from "../apps/web/src/lib/api";
import {
  clearMessagingOutbox,
  countMessagingOutbox,
  queueMessagingOutbox,
  readMessagingOutbox,
  removeMessagingOutboxEntry,
  type MessagingOutboxStorage
} from "../apps/web/src/messaging/outbox";
import {
  readDeviceOnlyMessages,
  saveDeviceOnlyMessages
} from "../apps/web/src/chat-device-only-messages";

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

  it("counts an account's waiting messages without writing, and reads blocked storage as 0", () => {
    const storage = new MemoryStorage();
    storage.setItem("grogoni.messaging-outbox.v1", "legacy");
    queueMessagingOutbox({ accountId: "a1", clientMessageId: "m1", payload: {} }, storage);
    queueMessagingOutbox({ accountId: "a1", clientMessageId: "m2", payload: {} }, storage);
    storage.setItem("grogoni.messaging-outbox.v1", "legacy");
    const writes = vi.spyOn(storage, "setItem");
    const removes = vi.spyOn(storage, "removeItem");
    expect(countMessagingOutbox("a1", undefined, storage)).toBe(2);
    expect(countMessagingOutbox("a2", undefined, storage)).toBe(0);
    expect(writes).not.toHaveBeenCalled();
    expect(removes).not.toHaveBeenCalled();
    expect(
      countMessagingOutbox("a1", undefined, {
        getItem: () => {
          throw new DOMException("blocked", "SecurityError");
        }
      })
    ).toBe(0);
  });

  it("counts per conversation, so a thread shows only its own waiting messages", () => {
    const storage = new MemoryStorage();
    queueMessagingOutbox(
      { accountId: "a1", clientMessageId: "m1", payload: { conversationId: "c1" } },
      storage
    );
    queueMessagingOutbox(
      { accountId: "a1", clientMessageId: "m2", payload: { conversationId: "c2" } },
      storage
    );
    expect(countMessagingOutbox("a1", "c1", storage)).toBe(1);
    expect(countMessagingOutbox("a1", "c3", storage)).toBe(0);
    expect(countMessagingOutbox("a1", undefined, storage)).toBe(2);
  });

  it("clears the thread copies of queued messages with the queue (sign-out, reset)", () => {
    const storage = new MemoryStorage();
    queueMessagingOutbox({ accountId: "a1", clientMessageId: "m1", payload: {} }, storage);
    saveDeviceOnlyMessages(
      "a1",
      [
        {
          id: "m1",
          author: "merchant",
          body: "private text",
          createdAt: new Date().toISOString(),
          deviceOnlyIn: "c1",
          outboxState: "retrying"
        }
      ],
      storage
    );
    expect(readDeviceOnlyMessages("a1", storage)).toHaveLength(1);
    clearMessagingOutbox("a1", storage);
    expect(readDeviceOnlyMessages("a1", storage)).toEqual([]);
    expect([...storage.values.values()].join("")).not.toContain("private text");
  });
});
