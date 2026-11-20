import { describe, expect, it, vi } from "vitest";
import { messageEventStream } from "../supabase/functions/api/message-events";
import type { Transaction } from "../supabase/functions/api/session-routes";

describe("account message event stream", () => {
  it("sends identifiers only and scopes every journal read to the authenticated account", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(values?.[0]).toBe("account-a");
      return {
        rows: sql.includes("max(sequence)")
          ? [{ cursor: "2" }]
          : values?.[1] === "2"
            ? [
                {
                  sequence: "3",
                  collection: "conversation_messages",
                  conversation_id: "thread-a",
                  entity_id: "message-a",
                  text: "MUST NOT STREAM"
                }
              ]
            : []
      };
    });
    const transaction: Transaction = async (work) => work({ query });
    const response = await messageEventStream(
      new Request("https://example.invalid/v1/realtime/messages"),
      transaction,
      async () => "account-a",
      { durationMs: 20, intervalMs: 1 }
    );
    const text = await response.text();
    expect(text).toContain('"conversationIds":["thread-a"]');
    expect(text).toContain("id: 3");
    expect(text).not.toContain("MUST NOT STREAM");
  });
  it("resumes a reconnect from its cursor and reports what changed while it was away", async () => {
    // Clients no longer catch up on every reconnect's ready event; this hint is what they rely on.
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(sql).not.toContain("max(sequence)");
      return {
        rows:
          values?.[1] === "5"
            ? [{ sequence: "7", collection: "conversations", entity_id: "thread-missed" }]
            : []
      };
    });
    const transaction: Transaction = async (work) => work({ query });
    const response = await messageEventStream(
      new Request("https://example.invalid/v1/realtime/messages?since=5"),
      transaction,
      async () => "account-a",
      { durationMs: 20, intervalMs: 1 }
    );
    const text = await response.text();
    expect(text).toMatch(/^id: 5\nevent: ready\n/u);
    expect(text).toContain("id: 7\nevent: changed");
    expect(text).toContain('"conversationIds":["thread-missed"]');
  });
  it("revalidates authentication and closes on expiry", async () => {
    const auth = vi.fn().mockResolvedValueOnce("a").mockRejectedValue(new Error("expired"));
    const transaction: Transaction = async (work) =>
      work({ query: async () => ({ rows: [{ cursor: "0" }] }) });
    const response = await messageEventStream(
      new Request("https://example.invalid/v1/realtime/messages"),
      transaction,
      auth,
      { durationMs: 100, intervalMs: 1, reauthorizeEveryMs: 0 }
    );
    expect(await response.text()).not.toContain("event: changed");
    expect(auth).toHaveBeenCalledTimes(2);
  });
  it("reads the journal every probe but rechecks the session only every reauthorizeEveryMs", async () => {
    vi.useFakeTimers();
    try {
      const auth = vi.fn(async () => "account-a");
      const journalReads = vi.fn();
      const transaction: Transaction = async (work) =>
        work({
          query: async (sql: string) => {
            if (!sql.includes("max(sequence)")) journalReads();
            return { rows: sql.includes("max(sequence)") ? [{ cursor: "0" }] : [] };
          }
        });
      const response = await messageEventStream(
        new Request("https://example.invalid/v1/realtime/messages"),
        transaction,
        auth,
        { durationMs: 10_000, intervalMs: 500, reauthorizeEveryMs: 5_000 }
      );
      const text = response.text();
      await vi.advanceTimersByTimeAsync(10_500);
      await text;
      // 20 probes in 10 s, each reading the journal; the session checked at open and at 5 s and 10 s.
      expect(journalReads.mock.calls.length).toBeGreaterThanOrEqual(19);
      expect(auth.mock.calls.length).toBeLessThanOrEqual(3);
      expect(auth.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("still closes within the recheck window once the session expires", async () => {
    vi.useFakeTimers();
    try {
      const auth = vi
        .fn()
        .mockResolvedValueOnce("account-a")
        .mockRejectedValue(new Error("expired"));
      const transaction: Transaction = async (work) =>
        work({ query: async () => ({ rows: [{ cursor: "0" }] }) });
      const response = await messageEventStream(
        new Request("https://example.invalid/v1/realtime/messages"),
        transaction,
        auth,
        { durationMs: 25_000, intervalMs: 500, reauthorizeEveryMs: 5_000 }
      );
      let closedAt: number | null = null;
      const started = Date.now();
      const text = response.text().then((body) => {
        closedAt = Date.now() - started;
        return body;
      });
      await vi.advanceTimersByTimeAsync(6_000);
      await text;
      expect(closedAt).not.toBeNull();
      expect(closedAt!).toBeLessThanOrEqual(5_600);
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects a malformed reconnect cursor", async () => {
    const transaction: Transaction = async () => {
      throw new Error("journal must not be read");
    };
    const response = await messageEventStream(
      new Request("https://example.invalid/v1/realtime/messages?since=abc"),
      transaction,
      async () => "a"
    );
    expect(response.status).toBe(400);
  });
});
