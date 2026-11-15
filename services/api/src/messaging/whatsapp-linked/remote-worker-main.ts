import { readFileSync } from "node:fs";
import { baileysLinkedDriver } from "./baileys-driver.js";
import { LinkedRemoteWorker } from "./remote-worker.js";

/**
 * Entry point of a remote connector worker process (`pnpm --filter @grogoni/api
 * whatsapp-worker:start`). Settings:
 *   WHATSAPP_LINKED_HUB_URL         tls://api-host:7443 (tcp:// only to a loopback hub)
 *   WHATSAPP_LINKED_WORKER_CREDENTIAL  gwlw1.<id>.<secret>, issued by the business owner
 *   WHATSAPP_LINKED_HUB_CA_FILE     optional PEM bundle that signs the hub's certificate
 * The process holds no session data on disk; the API's encrypted vault stays authoritative.
 */
const hubUrl = process.env.WHATSAPP_LINKED_HUB_URL?.trim() ?? "";
const credential = process.env.WHATSAPP_LINKED_WORKER_CREDENTIAL?.trim() ?? "";
const caFile = process.env.WHATSAPP_LINKED_HUB_CA_FILE?.trim();
// Do not keep the credential in this process's environment for child processes or dumps.
delete process.env.WHATSAPP_LINKED_WORKER_CREDENTIAL;
const worker = new LinkedRemoteWorker({
  hubUrl,
  credential,
  driver: baileysLinkedDriver,
  ...(caFile ? { ca: readFileSync(caFile) } : {}),
  log: (event) => console.log(JSON.stringify(event))
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => worker.stop("signal"));
worker.start();
const reason = await worker.finished;
// A permanent refusal (revoked, expired, invalid) exits non-zero so a supervisor surfaces it.
process.exitCode = reason === "signal" || reason === "stopped" ? 0 : 2;
