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
      { durationMs: 100, intervalMs: 1 }
    );
    expect(await response.text()).not.toContain("event: changed");
    expect(auth).toHaveBeenCalledTimes(2);
  });
  it("with a combined probe, uses one transaction per probe and closes when the session ends", async () => {
    let transactions = 0;
    const probe = vi
      .fn()
      .mockResolvedValueOnce({
        accountId: "account-a",
        rows: [{ sequence: "4", collection: "conversation_messages", conversation_id: "thread-a" }]
      })
      .mockResolvedValueOnce({ accountId: "account-a", rows: [] })
      .mockResolvedValue({ accountId: null, rows: [] });
    const transaction: Transaction = async (work) => {
      transactions += 1;
      return work({ query: async () => ({ rows: [{ cursor: "3" }] }) });
    };
    const authorize = vi.fn(async () => "account-a");
    const response = await messageEventStream(
      new Request("https://example.invalid/v1/realtime/messages"),
      transaction,
      authorize,
      { durationMs: 1_000, intervalMs: 1, probe }
    );
    const text = await response.text();
    expect(text).toContain(
      'id: 4\nevent: changed\ndata: {"accountId":"account-a","conversationIds":["thread-a"]}'
    );
    // The session check happens only at open; each probe after that is a single transaction.
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(probe.mock.calls.map(([, cursor]) => cursor)).toEqual(["3", "4", "4"]);
    expect(transactions).toBe(1 + 3);
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
