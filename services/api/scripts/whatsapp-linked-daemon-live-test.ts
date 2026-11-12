/** One small paid synthetic model call; no WhatsApp transport. */
import { randomUUID } from "node:crypto";
import { createLinkedDaemonTestHost } from "./linked-daemon-test-host.js";
import { LinkedDaemonClient } from "../src/messaging/whatsapp-linked/daemon-client.js";
const host = await createLinkedDaemonTestHost();
try {
  const started = Date.now();
  const reply = await new LinkedDaemonClient({
    url: host.base,
    token: host.token,
    allowLocal: true,
    timeoutMs: 150_000,
    pollMs: 250
  }).reply({
    businessId: randomUUID(),
    ownerId: randomUUID(),
    chat: "synthetic-test",
    sender: "synthetic-test",
    messageId: randomUUID(),
    text: "Habari! Nipe salamu fupi kwa Kiswahili.",
    modelId: host.modelId,
    agentAdapterId: "grogoni"
  });
  if (!reply?.trim()) throw new Error("The existing Daemon/model returned no reply.");
  const tasks = await host.store.list();
  if (tasks.length !== 1 || tasks[0]?.status !== "completed" || !tasks[0].owner_user_id)
    throw new Error("The owned durable task did not complete.");
  console.log(
    JSON.stringify({
      event: "linked_daemon_model_verified",
      modelId: host.modelId,
      replyCharacters: reply.length,
      elapsedMs: Date.now() - started,
      whatsappMessagesSent: 0
    })
  );
} finally {
  await host.close();
}
