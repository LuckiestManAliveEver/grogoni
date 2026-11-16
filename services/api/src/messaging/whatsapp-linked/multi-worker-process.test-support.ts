import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { Pool } from "pg";
import { createCp2Store } from "../../cp2/store.js";
import type { LinkedDriver } from "./connector.js";
import { registerLinkedWhatsAppRoutes } from "./routes.js";

/**
 * Test support only: one real API worker process for tests/whatsapp-linked-multi-worker.test.ts.
 * It runs the production registerLinkedWhatsAppRoutes (lease, forwarding, shared volume) over a
 * store hydrated from the parent's snapshot, with a mocked LinkedDriver that prints every socket
 * call as one JSON line on stdout. argv[2] is a JSON config file written by the parent.
 */
interface Config {
  name: string;
  port: number;
  snapshotPath: string;
  databaseUrl: string;
  schema: string;
  environment: Record<string, string>;
}
const config = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Config;
const emit = (event: Record<string, unknown>) =>
  process.stdout.write(JSON.stringify({ worker: config.name, ...event }) + "\n");

const driver: LinkedDriver = {
  async open(input) {
    emit({ event: "open", businessId: input.businessId, auth: input.auth });
    if (input.auth) setTimeout(() => input.state("open"), 20);
    return {
      pairingCode: async () => {
        // WhatsApp approves the code: credentials are saved, then the socket opens.
        setTimeout(() => {
          input.save(`auth-from-${config.name}`);
          input.state("open");
        }, 50);
        return "CODE1234";
      },
      groups: async () => [],
      send: async (_chat, _text, id) => {
        emit({ event: "send", id });
        return id;
      },
      close: () => emit({ event: "close" }),
      logout: async () => {
        emit({ event: "logout", businessId: input.businessId });
      }
    };
  }
};

const store = createCp2Store();
store.hydrateSnapshot(JSON.parse(readFileSync(config.snapshotPath, "utf8")));
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 3,
  options: `-c search_path=${config.schema}`
});
const app = Fastify();
registerLinkedWhatsAppRoutes(app, store, config.environment, driver, {
  database: pool,
  transcriber: null
});
await app.listen({ host: "127.0.0.1", port: config.port });
emit({ event: "ready" });
const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown());
