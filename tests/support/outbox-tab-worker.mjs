/**
 * One browser tab for tests/messaging-outbox-cross-tab.test.ts, run in its own thread so two
 * tabs really run at the same time. Plain JavaScript: a worker thread does not get vitest's
 * TypeScript transform. The tabs share one storage in a SharedArrayBuffer, where each
 * getItem/setItem/removeItem is atomic on its own (as localStorage is) but nothing makes a read
 * and the write after it atomic. `locks` gives the tab a Web Locks stand-in shared by both
 * threads; without it the tab has no navigator.locks (the outbox's fallback).
 */
import { clearInterval, setImmediate, setInterval } from "node:timers";
import { TextDecoder, TextEncoder } from "node:util";
import { parentPort, workerData } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";

const { buffer, tab, count, locks, outboxUrl } = workerData;
// [storage mutex, Web Lock, stored length, start signal]
const words = new Int32Array(buffer, 0, 4);
const bytes = new Uint8Array(buffer, 16);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function withStorage(work, write) {
  while (Atomics.compareExchange(words, 0, 0, 1) !== 0) Atomics.wait(words, 0, 1);
  try {
    const length = Atomics.load(words, 2);
    const values = length === 0 ? {} : JSON.parse(decoder.decode(bytes.slice(0, length)));
    const result = work(values);
    if (write) {
      const encoded = encoder.encode(JSON.stringify(values));
      bytes.set(encoded);
      Atomics.store(words, 2, encoded.length);
    }
    return result;
  } finally {
    Atomics.store(words, 0, 0);
    Atomics.notify(words, 0);
  }
}

const storage = {
  getItem: (key) => withStorage((values) => values[key] ?? null, false),
  setItem: (key, value) =>
    withStorage((values) => {
      values[key] = value;
    }, true),
  removeItem: (key) =>
    withStorage((values) => {
      delete values[key];
    }, true)
};

const lockManager = {
  async request(_name, callback) {
    while (Atomics.compareExchange(words, 1, 0, 1) !== 0)
      await Atomics.waitAsync(words, 1, 1).value;
    try {
      return await callback();
    } finally {
      Atomics.store(words, 1, 0);
      Atomics.notify(words, 1);
    }
  }
};

Object.defineProperty(globalThis, "navigator", {
  value: locks ? { locks: lockManager } : {},
  configurable: true
});

// tsx's API, not --import: loader flags do not reach the imports of a worker's modules.
const outbox = await tsImport(outboxUrl, import.meta.url);
// Both tabs start together.
parentPort?.postMessage("ready");
while (Atomics.load(words, 3) === 0) Atomics.wait(words, 3, 0);

// A pending Atomics.waitAsync does not keep a thread's event loop alive; this does.
const keepAlive = setInterval(() => {}, 1_000);
const yieldToOtherTab = () => new Promise((resolve) => setImmediate(resolve));
for (let index = 0; index < count; index += 1) {
  const clientMessageId = `${tab}-${index}`;
  outbox.queueMessagingOutbox(
    {
      accountId: "account-shared",
      clientMessageId,
      payload: { conversationId: "conversation-shared", text: `message ${index} from ${tab}` }
    },
    storage
  );
  // Every third message is sent at once and leaves the outbox again.
  if (index % 3 === 0)
    outbox.removeMessagingOutboxEntry("account-shared", clientMessageId, storage);
  // Records an attempt on the previous message, which the other tab never touches.
  if (index % 3 === 2)
    outbox.recordMessagingOutboxAttempt("account-shared", `${tab}-${index - 1}`, 0, storage);
  await yieldToOtherTab();
}
await outbox.settleMessagingOutbox?.();
clearInterval(keepAlive);
parentPort?.postMessage({
  done: true,
  // What this tab itself reads at the end (its own view must match the stored list).
  ownView: outbox
    .readMessagingOutbox("account-shared", storage)
    .map((entry) => entry.clientMessageId)
});
