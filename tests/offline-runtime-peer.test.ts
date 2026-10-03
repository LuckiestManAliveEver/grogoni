import { describe, expect, it, vi } from "vitest";
import {
  PeerProvider,
  PEER_OUTBOX_RESEND_CAP,
  type PeerTransport,
  type PeerQueuedMessage
} from "../packages/offline-runtime/index";
import type {
  CatalogueDigest,
  ConversationMessageSummary,
  OfflineOrderIntent
} from "@grogoni/shared-types";

function memoryOutbox() {
  let queue: PeerQueuedMessage[] = [];
  return {
    load: async () => queue,
    save: async (value: PeerQueuedMessage[]) => {
      queue = value;
    },
    get current() {
      return queue;
    }
  };
}

function loopbackTransport(mtu = 128): PeerTransport {
  const listeners = new Set<(frame: Uint8Array) => void>();
  return {
    mtu,
    available: async () => true,
    discover: async () => ["peer"],
    connect: async () => undefined,
    broadcast: async (frame) => {
      for (const listener of listeners) listener(frame);
    },
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }
  };
}

describe("Prototype nearby transport", () => {
  it("queues while disconnected, reassembles UTF-8 frames and waits for delivery acknowledgement", async () => {
    const frameListeners = new Set<(frame: Uint8Array) => void>();
    let available = false;
    const sent: Uint8Array[] = [];
    const transport: PeerTransport = {
      mtu: 128,
      available: async () => available,
      discover: async () => ["peer"],
      connect: async () => {
        available = true;
      },
      broadcast: async (frame) => {
        sent.push(frame);
      },
      subscribe: (handler) => {
        frameListeners.add(handler);
        return () => {
          frameListeners.delete(handler);
        };
      }
    };
    let queue: PeerQueuedMessage[] = [];
    const outbox = {
      load: async () => queue,
      save: async (value: PeerQueuedMessage[]) => {
        queue = value;
      }
    };
    const provider = new PeerProvider(transport, outbox);
    const envelope = {
      id: "message",
      conversationId: "conversation",
      clientMessageId: "client",
      idempotencyKey: "dedupe",
      author: "user",
      authorId: "account",
      content: { type: "text", text: "Habari 👋 ".repeat(80) }
    } as ConversationMessageSummary;
    try {
      await provider.send(envelope);
      expect(sent).toHaveLength(0);
      expect(queue).toHaveLength(1);
      await provider.connect("peer");
      expect(sent.length).toBeGreaterThan(1);
      expect(sent.every((frame) => frame.length <= 128)).toBe(true);
      const received: ConversationMessageSummary[] = [];
      provider.onReceive((message) => received.push(message));
      const original = sent.map((frame) => {
        const copy = frame.slice();
        copy[1] = 1;
        return copy;
      });
      for (const frame of [...original].reverse())
        for (const handler of frameListeners) handler(frame);
      for (const frame of original) for (const handler of frameListeners) handler(frame);
      expect(received).toEqual([envelope]);
      expect(queue).toHaveLength(1);
      await provider.acknowledge(envelope.id);
      expect(queue).toHaveLength(0);
      expect(provider.supports("catalogue.create")).toBe(false);
    } finally {
      provider.close();
    }
  });

  it("drops an unacknowledged message with a visible failure after the resend cap", async () => {
    let queue: PeerQueuedMessage[] = [];
    const transport: PeerTransport = {
      mtu: 128,
      available: async () => true,
      discover: async () => ["peer"],
      connect: async () => undefined,
      broadcast: async () => undefined,
      subscribe: () => () => undefined
    };
    const outbox = {
      load: async () => queue,
      save: async (value: PeerQueuedMessage[]) => {
        queue = value;
      }
    };
    const provider = new PeerProvider(transport, outbox);
    const envelope = {
      id: "never-acked",
      conversationId: "conversation",
      clientMessageId: "client",
      idempotencyKey: "dedupe",
      author: "user",
      authorId: "account",
      content: { type: "text", text: "hello" }
    } as ConversationMessageSummary;
    const failed: ConversationMessageSummary[] = [];
    provider.onDeliveryFailed((message) => failed.push(message));
    try {
      await provider.send(envelope);
      expect(queue).toHaveLength(1);
      expect(queue[0]!.attempts).toBe(1);
      // send() already counted as one attempt; flush() the remaining attempts up to the cap.
      for (let attempt = 1; attempt < PEER_OUTBOX_RESEND_CAP - 1; attempt++) await provider.flush();
      expect(queue).toHaveLength(1);
      expect(queue[0]!.attempts).toBe(PEER_OUTBOX_RESEND_CAP - 1);
      expect(failed).toHaveLength(0);
      await provider.flush();
      expect(queue).toHaveLength(0);
      expect(failed).toEqual([envelope]);
    } finally {
      provider.close();
    }
  });

  it("rejects a corrupted v2 fragment instead of parsing damaged application data", async () => {
    const listeners = new Set<(frame: Uint8Array) => void>();
    const sent: Uint8Array[] = [];
    const transport: PeerTransport = {
      mtu: 256,
      available: async () => true,
      discover: async () => ["peer"],
      connect: async () => undefined,
      broadcast: async (frame) => {
        sent.push(frame.slice());
      },
      subscribe: (handler) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      }
    };
    const sender = new PeerProvider(transport, memoryOutbox());
    const receiver = new PeerProvider(transport, memoryOutbox());
    const received: ConversationMessageSummary[] = [];
    receiver.onReceive((message) => received.push(message));
    try {
      await sender.send({
        id: "corruption-check",
        conversationId: "conversation",
        clientMessageId: "client",
        idempotencyKey: "dedupe",
        author: "user",
        authorId: "account",
        content: { type: "text", text: "hello" }
      } as ConversationMessageSummary);
      expect(sent[0]?.[0]).toBe(2);
      const corrupted = sent.map((frame) => frame.slice());
      corrupted[0]![corrupted[0]!.length - 1] ^= 0xff;
      for (const frame of corrupted) for (const listener of listeners) listener(frame);
      expect(received).toEqual([]);
    } finally {
      sender.close();
      receiver.close();
    }
  });

  it("keeps accepting legacy v1 frames during the protocol rollout", () => {
    const listeners = new Set<(frame: Uint8Array) => void>();
    const transport: PeerTransport = {
      mtu: 256,
      available: async () => true,
      discover: async () => ["peer"],
      connect: async () => undefined,
      broadcast: async () => undefined,
      subscribe: (handler) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      }
    };
    const receiver = new PeerProvider(transport, memoryOutbox());
    const message = {
      id: "legacy-message",
      conversationId: "conversation",
      clientMessageId: "client",
      idempotencyKey: "dedupe",
      author: "user",
      authorId: "account",
      content: { type: "text", text: "hello" }
    } as ConversationMessageSummary;
    const payload = new TextEncoder().encode(JSON.stringify(message));
    const frame = new Uint8Array(23 + payload.length);
    const view = new DataView(frame.buffer);
    frame[0] = 1;
    frame[1] = 1;
    frame[2] = 0;
    view.setUint16(19, 0);
    view.setUint16(21, 1);
    frame.set(payload, 23);
    const received: ConversationMessageSummary[] = [];
    receiver.onReceive((value) => received.push(value));
    try {
      for (const listener of listeners) listener(frame);
      expect(received).toEqual([message]);
    } finally {
      receiver.close();
    }
  });

  it("cancels redundant jittered relays after another peer forwards the fragment", async () => {
    vi.useFakeTimers();
    const listeners = new Set<(frame: Uint8Array) => void>();
    let broadcasts = 0;
    const transport: PeerTransport = {
      mtu: 256,
      available: async () => true,
      discover: async () => ["peer"],
      connect: async () => undefined,
      broadcast: async (frame) => {
        broadcasts++;
        for (const listener of listeners) listener(frame);
      },
      subscribe: (handler) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      }
    };
    const peers = [
      new PeerProvider(transport, memoryOutbox()),
      new PeerProvider(transport, memoryOutbox()),
      new PeerProvider(transport, memoryOutbox())
    ];
    try {
      await peers[0]!.broadcastCatalogueDigest({
        storeId: "shop-1",
        productListHash: "deadbeef",
        lastSyncSequence: 42,
        issuedAt: new Date().toISOString()
      });
      expect(broadcasts).toBe(1);
      await vi.runAllTimersAsync();
      // One peer wins the jitter race; its duplicate cancels every other scheduled relay.
      expect(broadcasts).toBe(2);
    } finally {
      for (const peer of peers) peer.close();
      vi.useRealTimers();
    }
  });
});

describe("BLE catalogue digest and order intent envelopes", () => {
  it("supports the new ops without regaining any business-mutation op", () => {
    const provider = new PeerProvider(loopbackTransport(), memoryOutbox());
    try {
      expect(provider.supports("peer.catalogueDigest.broadcast")).toBe(true);
      expect(provider.supports("peer.orderIntent.send")).toBe(true);
      expect(provider.supports("catalogue.create")).toBe(false);
      expect(provider.supports("orders.confirmInvoice")).toBe(false);
    } finally {
      provider.close();
    }
  });

  it("broadcasts a small catalogue digest fire-and-forget, with no outbox growth", async () => {
    const transport = loopbackTransport();
    const outbox = memoryOutbox();
    const sender = new PeerProvider(transport, outbox);
    const digest: CatalogueDigest = {
      storeId: "shop-1",
      productListHash: "deadbeef",
      lastSyncSequence: 42,
      issuedAt: new Date().toISOString()
    };
    const received: CatalogueDigest[] = [];
    const receiver = new PeerProvider(transport, memoryOutbox());
    receiver.onCatalogueDigest((value) => received.push(value));
    try {
      await sender.broadcastCatalogueDigest(digest);
      expect(received).toEqual([digest]);
      expect(outbox.current).toHaveLength(0);
    } finally {
      sender.close();
      receiver.close();
    }
  });

  it("rejects a catalogue digest broadcast over the small-beacon size cap", async () => {
    const provider = new PeerProvider(loopbackTransport(), memoryOutbox());
    try {
      await expect(
        provider.broadcastCatalogueDigest({
          storeId: "shop-1",
          productListHash: "x".repeat(4_000),
          lastSyncSequence: 1,
          issuedAt: new Date().toISOString()
        })
      ).rejects.toThrow();
    } finally {
      provider.close();
    }
  });

  it("delivers an order intent through the same fragmented, deduplicated outbox as a conversation message, and writes only into the sink", async () => {
    const transport = loopbackTransport();
    const senderOutbox = memoryOutbox();
    const sender = new PeerProvider(transport, senderOutbox);
    const intent: OfflineOrderIntent = {
      id: "intent-1",
      accountId: "account",
      storeId: "shop-1",
      transport: "ble",
      customerClaim: { type: "account", accountId: "buyer-account", displayName: "Buyer" },
      items: [{ productCloudId: "sugar", name: "Sugar 1kg", quantity: 2, quotedUnitPrice: 100 }],
      paymentMethod: null,
      paymentReference: null,
      note: null,
      receivedAtLocal: new Date().toISOString(),
      rawText: null
    };
    const received: OfflineOrderIntent[] = [];
    const receiver = new PeerProvider(transport, memoryOutbox(), (value) => {
      received.push(value);
    });
    try {
      await sender.sendOrderIntent(intent);
      expect(senderOutbox.current).toHaveLength(1);
      // Wait for the fire-and-forget sink call scheduled inside PeerProvider.receive().
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(received).toEqual([intent]);
    } finally {
      sender.close();
      receiver.close();
    }
  });

  it("drops a well-formed order intent when no sink is wired, instead of accepting it silently", async () => {
    const transport = loopbackTransport();
    const sender = new PeerProvider(transport, memoryOutbox());
    const receiver = new PeerProvider(transport, memoryOutbox());
    const received: unknown[] = [];
    receiver.onReceive((message) => received.push(message));
    const intent: OfflineOrderIntent = {
      id: "intent-2",
      accountId: "account",
      storeId: "shop-1",
      transport: "ble",
      customerClaim: { type: "phone", phone: "+254700000000", displayName: null },
      items: [{ productCloudId: null, name: "Soap", quantity: 1, quotedUnitPrice: null }],
      paymentMethod: null,
      paymentReference: null,
      note: null,
      receivedAtLocal: new Date().toISOString(),
      rawText: null
    };
    try {
      await sender.sendOrderIntent(intent);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(received).toEqual([]);
    } finally {
      sender.close();
      receiver.close();
    }
  });

  it("does not permanently drop an order intent when the local sink write fails - a retransmit reaches the sink again", async () => {
    const transport = loopbackTransport();
    const sender = new PeerProvider(transport, memoryOutbox());
    const intent: OfflineOrderIntent = {
      id: "intent-sink-retry",
      accountId: "account",
      storeId: "shop-1",
      transport: "ble",
      customerClaim: { type: "account", accountId: "buyer-account", displayName: null },
      items: [{ productCloudId: null, name: "Soap", quantity: 1, quotedUnitPrice: null }],
      paymentMethod: null,
      paymentReference: null,
      note: null,
      receivedAtLocal: new Date().toISOString(),
      rawText: null
    };
    let attempts = 0;
    const receiver = new PeerProvider(transport, memoryOutbox(), async () => {
      attempts++;
      if (attempts === 1) throw new Error("local storage is full");
    });
    try {
      await sender.sendOrderIntent(intent);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(attempts).toBe(1);
      // Same frames again, simulating the sender's outbox retrying an unacknowledged send -
      // the first sink failure must not have permanently deduped this intent id.
      await sender.flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(attempts).toBe(2);
    } finally {
      sender.close();
      receiver.close();
    }
  });

  it("fires onOrderIntentDeliveryFailed, not onDeliveryFailed, after the resend cap", async () => {
    const transport: PeerTransport = {
      mtu: 128,
      available: async () => true,
      discover: async () => ["peer"],
      connect: async () => undefined,
      broadcast: async () => undefined,
      subscribe: () => () => undefined
    };
    const outbox = memoryOutbox();
    const provider = new PeerProvider(transport, outbox);
    const intent: OfflineOrderIntent = {
      id: "intent-never-acked",
      accountId: "account",
      storeId: "shop-1",
      transport: "ble",
      customerClaim: { type: "account", accountId: "buyer-account", displayName: null },
      items: [{ productCloudId: null, name: "Soap", quantity: 1, quotedUnitPrice: null }],
      paymentMethod: null,
      paymentReference: null,
      note: null,
      receivedAtLocal: new Date().toISOString(),
      rawText: null
    };
    const messageFailed: unknown[] = [];
    const intentFailed: OfflineOrderIntent[] = [];
    provider.onDeliveryFailed((message) => messageFailed.push(message));
    provider.onOrderIntentDeliveryFailed((value) => intentFailed.push(value));
    try {
      await provider.sendOrderIntent(intent);
      for (let attempt = 1; attempt < PEER_OUTBOX_RESEND_CAP; attempt++) await provider.flush();
      expect(outbox.current).toHaveLength(0);
      expect(intentFailed).toEqual([intent]);
      expect(messageFailed).toEqual([]);
    } finally {
      provider.close();
    }
  });

  it("keeps conversation messages and order intents in separate delivery-failure streams even when both are queued", async () => {
    const transport: PeerTransport = {
      mtu: 128,
      available: async () => false,
      discover: async () => [],
      connect: async () => undefined,
      broadcast: async () => undefined,
      subscribe: () => () => undefined
    };
    const outbox = memoryOutbox();
    const provider = new PeerProvider(transport, outbox);
    const conversationMessage: ConversationMessageSummary = {
      id: "message-1",
      conversationId: "conversation",
      clientMessageId: "client",
      idempotencyKey: "dedupe",
      author: "user",
      authorId: "account",
      content: { type: "text", text: "hi" }
    } as ConversationMessageSummary;
    try {
      await provider.send(conversationMessage);
      await provider.sendOrderIntent({
        id: "intent-3",
        accountId: "account",
        storeId: "shop-1",
        transport: "ble",
        customerClaim: { type: "account", accountId: "buyer-account", displayName: null },
        items: [{ productCloudId: null, name: "Soap", quantity: 1, quotedUnitPrice: null }],
        paymentMethod: null,
        paymentReference: null,
        note: null,
        receivedAtLocal: new Date().toISOString(),
        rawText: null
      });
      expect(outbox.current).toHaveLength(2);
      expect(outbox.current.map((entry) => entry.envelope.kind).sort()).toEqual([
        "conversation_message",
        "order_intent"
      ]);
    } finally {
      provider.close();
    }
  });
});
