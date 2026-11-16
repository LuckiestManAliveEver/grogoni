import type { LinkedDriver } from "./connector.js";
import { LinkedRemoteWorker } from "./remote-worker.js";

/**
 * Test support only: a real remote-worker process for tests/whatsapp-linked-multi-worker.test.ts.
 * Production uses remote-worker-main.ts with the Baileys driver; this one uses a mocked
 * LinkedDriver that prints each call as a JSON line and, once a socket opens, delivers one
 * inbound message. Exit code 2 means a permanent refusal (revoked, expired, invalid), as in main.
 */
const emit = (event: object): void => {
  process.stdout.write(JSON.stringify(event) + "\n");
};

const driver: LinkedDriver = {
  async open(input) {
    emit({ event: "open", auth: input.auth });
    setTimeout(() => {
      input.state("open");
      input.inbound({
        id: "remote-message-1",
        chat: "254711111111@s.whatsapp.net",
        sender: "254711111111@s.whatsapp.net",
        text: "hello from the worker process",
        timestamp: new Date(0).toISOString(),
        fromMe: false,
        mentioned: false
      });
    }, 20);
    return {
      pairingCode: async () => "CODE1234",
      groups: async () => [],
      send: async (_chat, text, id) => {
        emit({ event: "send", text, id });
        return `wa-${id}`;
      },
      close: () => emit({ event: "close" }),
      logout: async () => emit({ event: "logout" })
    };
  }
};

const worker = new LinkedRemoteWorker({
  hubUrl: process.env.WHATSAPP_LINKED_HUB_URL ?? "",
  credential: process.env.WHATSAPP_LINKED_WORKER_CREDENTIAL ?? "",
  driver,
  reconnect: { minMs: 200, maxMs: 1_000 },
  log: (event) => emit(event)
});
process.once("SIGTERM", () => worker.stop("signal"));
worker.start();
const reason = await worker.finished;
emit({ event: "finished", reason });
process.exit(reason === "signal" || reason === "stopped" ? 0 : 2);
