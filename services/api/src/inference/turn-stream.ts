import { AsyncLocalStorage } from "node:async_hooks";

import type { AgentTurnStreamEvent } from "@grogoni/shared-types";
import { createRuntimeReplyTextStream } from "@grogoni/tool-core";

/**
 * Per-turn reply streaming without touching the turn pipeline. A client that wants to watch a turn
 * sends `x-grogoni-turn-id` on the turn request (POST /v1/messages or /businesses/:id/runtime/turns);
 * app.ts runs the whole request inside `turnContext`, so any model adapter deep in the pipeline
 * can find the turn id with `currentTurnId()` and publish reply text to the hub. The client reads
 * it from GET /v1/ai/turn-stream/:turnId (server-sent events). The final, validated reply still
 * arrives in the turn response - the stream is a preview and is never persisted.
 *
 * Streams are keyed by (account, turn id), so one account can never read another's turn.
 * In-process by design, like the owner-node broker: the API runs as one authoritative writer.
 */
export const turnContext = new AsyncLocalStorage<{ turnId: string }>();

export function currentTurnId(): string | undefined {
  return turnContext.getStore()?.turnId;
}

export function isValidTurnId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/u.test(value);
}

type Listener = (event: AgentTurnStreamEvent) => void;

interface Channel {
  listeners: Set<Listener>;
  buffer: AgentTurnStreamEvent[];
  bufferedChars: number;
  done: boolean;
  expiresAt: number;
}

const bufferCharLimit = 64_000;
const channelTtlMs = 5 * 60_000;

export class TurnStreamHub {
  private readonly channels = new Map<string, Channel>();

  constructor(private readonly now: () => number = Date.now) {}

  publish(accountId: string, turnId: string, event: AgentTurnStreamEvent): void {
    const channel = this.channel(accountId, turnId);
    if (channel.done) return;
    if (event.type === "done") channel.done = true;
    if (event.type === "reset") {
      channel.buffer = [];
      channel.bufferedChars = 0;
    }
    // Buffer for a subscriber that connects slightly after the turn started.
    const size = event.type === "text" ? event.text.length : 0;
    if (channel.bufferedChars + size <= bufferCharLimit) {
      channel.buffer.push(event);
      channel.bufferedChars += size;
    }
    for (const listener of channel.listeners) listener(event);
    this.sweep();
  }

  subscribe(accountId: string, turnId: string, listener: Listener): () => void {
    const channel = this.channel(accountId, turnId);
    for (const event of channel.buffer) listener(event);
    channel.listeners.add(listener);
    return () => {
      channel.listeners.delete(listener);
    };
  }

  /** A publisher that turns raw model text into reply-text events for one turn. */
  replyPublisher(accountId: string | undefined, turnId: string | undefined) {
    if (accountId === undefined || turnId === undefined) return null;
    let extractor = createRuntimeReplyTextStream();
    return {
      raw: (chunk: string) => {
        const text = extractor.push(chunk);
        if (text !== "") this.publish(accountId, turnId, { type: "text", text });
      },
      reset: () => {
        extractor = createRuntimeReplyTextStream();
        this.publish(accountId, turnId, { type: "reset" });
      },
      event: (event: AgentTurnStreamEvent) => this.publish(accountId, turnId, event)
    };
  }

  finish(accountId: string, turnId: string): void {
    this.publish(accountId, turnId, { type: "done" });
  }

  private channel(accountId: string, turnId: string): Channel {
    const key = `${accountId}:${turnId}`;
    let channel = this.channels.get(key);
    if (channel === undefined) {
      channel = {
        listeners: new Set(),
        buffer: [],
        bufferedChars: 0,
        done: false,
        expiresAt: this.now() + channelTtlMs
      };
      this.channels.set(key, channel);
    }
    return channel;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, channel] of this.channels) {
      if (channel.expiresAt < now && channel.listeners.size === 0) this.channels.delete(key);
    }
  }
}

export const turnStreamHub = new TurnStreamHub();
