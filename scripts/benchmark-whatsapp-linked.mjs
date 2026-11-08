// Offline Node baseline only: no WhatsApp sockets, accounts or inference requests.
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
const require = createRequire(new URL("../services/api/package.json", import.meta.url));
globalThis.gc?.();
const before = process.memoryUsage();
const start = performance.now();
const { initAuthCreds, BufferJSON } = await import(require.resolve("baileys"));
const imported = performance.now();
const auth = JSON.stringify({ creds: initAuthCreds(), keys: {} }, BufferJSON.replacer);
globalThis.gc?.();
const after = process.memoryUsage();
console.log(
  JSON.stringify(
    {
      kind: "offline-import-only",
      node: process.version,
      arch: process.arch,
      platform: process.platform,
      importMs: Math.round(imported - start),
      rssBeforeBytes: before.rss,
      rssAfterBytes: after.rss,
      rssDeltaBytes: after.rss - before.rss,
      heapDeltaBytes: after.heapUsed - before.heapUsed,
      freshAuthJsonBytes: Buffer.byteLength(auth),
      encryptedEnvelopeOverheadBytes: 29,
      liveSockets: 0,
      caveat: "Does not measure linked-session memory, reconnect latency, Android or battery usage."
    },
    null,
    2
  )
);
