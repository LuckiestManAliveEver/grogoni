// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { openIndexedDbSyncRepository } from "../apps/web/src/sync/indexeddb-repository";

describe("durable messaging outbox", () => {
  it("never overwrites an updated record when another tab migrates stale browser storage", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const repository = await openIndexedDbSyncRepository();
    try {
      await repository.migrateMessagingOutbox("migration-key", "old");
      await repository.writeMessagingOutbox("migration-key", "new-redacted-value");
      expect(await repository.migrateMessagingOutbox("migration-key", "old-private-payload")).toBe(
        "new-redacted-value"
      );
      expect(await repository.loadMessagingOutbox()).toEqual([
        { key: "migration-key", value: "new-redacted-value" }
      ]);
    } finally {
      repository.close();
      vi.unstubAllGlobals();
    }
  });
  it("keeps two tabs' independent journal writes when broadcasts have not arrived", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("BroadcastChannel", undefined);
    localStorage.clear();
    try {
      vi.resetModules();
      const a = await import("../apps/web/src/messaging/outbox");
      await a.hydrateMessagingOutbox();
      vi.resetModules();
      const b = await import("../apps/web/src/messaging/outbox");
      await b.hydrateMessagingOutbox();
      a.queueMessagingOutbox({
        accountId: "two-tabs",
        clientMessageId: "tab-a",
        retryKind: "transport",
        payload: { conversationId: "chat", content: { type: "encrypted", ciphertext: "opaque-a" } }
      });
      b.queueMessagingOutbox({
        accountId: "two-tabs",
        clientMessageId: "tab-b",
        retryKind: "transport",
        payload: { conversationId: "chat", content: { type: "encrypted", ciphertext: "opaque-b" } }
      });
      await Promise.all([a.flushMessagingOutbox(), b.flushMessagingOutbox()]);
      vi.resetModules();
      const reloaded = await import("../apps/web/src/messaging/outbox");
      await reloaded.hydrateMessagingOutbox();
      expect(
        reloaded
          .readMessagingOutbox("two-tabs")
          .map((entry) => entry.clientMessageId)
          .sort()
      ).toEqual(["tab-a", "tab-b"]);
      reloaded.removeMessagingOutboxEntry("two-tabs", "tab-a");
      await reloaded.flushMessagingOutbox();
      const repository = await openIndexedDbSyncRepository();
      expect(JSON.stringify(await repository.loadMessagingOutbox())).not.toContain("opaque-a");
      repository.close();
    } finally {
      vi.unstubAllGlobals();
      localStorage.clear();
      vi.resetModules();
    }
  });
  it("migrates old entries, commits ciphertext before send and removes it after acceptance", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("BroadcastChannel", undefined);
    localStorage.clear();
    const legacy = {
      accountId: "idb-owner",
      clientMessageId: "idb-message",
      payload: { conversationId: "thread", content: { type: "encrypted", ciphertext: "opaque" } }
    };
    localStorage.setItem("grogoni.messaging-outbox.v2:idb-owner", JSON.stringify([legacy]));
    const {
      hydrateMessagingOutbox,
      flushMessagingOutbox,
      queueMessagingOutbox,
      readMessagingOutbox,
      removeMessagingOutboxEntry
    } = await import("../apps/web/src/messaging/outbox");
    try {
      await hydrateMessagingOutbox();
      queueMessagingOutbox(legacy);
      await flushMessagingOutbox();
      const repository = await openIndexedDbSyncRepository();
      const stored = JSON.stringify(await repository.loadMessagingOutbox());
      expect(stored).toContain("opaque");
      expect(localStorage.getItem("grogoni.messaging-outbox.v2:idb-owner")).toBeNull();
      expect(readMessagingOutbox("idb-owner").map((entry) => entry.clientMessageId)).toEqual([
        "idb-message"
      ]);
      removeMessagingOutboxEntry("idb-owner", "idb-message");
      await flushMessagingOutbox();
      expect(JSON.stringify(await repository.loadMessagingOutbox())).not.toContain("opaque");
      repository.close();
    } finally {
      vi.unstubAllGlobals();
      localStorage.clear();
    }
  });
});
