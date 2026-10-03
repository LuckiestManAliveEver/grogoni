import { createHmac } from "node:crypto";
import type { AccountDeletionProcessor } from "./store.js";

interface WebhookProcessorConfig {
  id: string;
  url: string;
}

export function readAccountDeletionProcessors(
  environment: NodeJS.ProcessEnv = process.env
): AccountDeletionProcessor[] {
  const raw = environment.ACCOUNT_DELETION_PROCESSORS_JSON?.trim();
  if (raw === undefined || raw.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ACCOUNT_DELETION_PROCESSORS_JSON must be valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("ACCOUNT_DELETION_PROCESSORS_JSON must be a non-empty array.");
  }

  const secret = environment.ACCOUNT_DELETION_WEBHOOK_SECRET?.trim();
  if (secret === undefined || secret.length < 32) {
    throw new Error("ACCOUNT_DELETION_WEBHOOK_SECRET must contain at least 32 characters.");
  }

  const configs = parsed.map(parseProcessorConfig);
  const ids = new Set<string>();
  return configs.map((config) => {
    if (ids.has(config.id)) throw new Error(`Duplicate deletion processor id: ${config.id}`);
    ids.add(config.id);
    return createSignedDeletionWebhookProcessor(config, secret);
  });
}

export function createSignedDeletionWebhookProcessor(
  config: WebhookProcessorConfig,
  secret: string
): AccountDeletionProcessor {
  return {
    id: config.id,
    async deleteAccount(input) {
      const timestamp = new Date().toISOString();
      const body = JSON.stringify({
        schemaVersion: 1,
        event: "account.deletion.requested",
        requestId: input.requestId,
        subjects: input.subjects
      });
      const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
      const response = await fetch(config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": input.requestId,
          "x-grogoni-deletion-processor": config.id,
          "x-grogoni-deletion-signature": `sha256=${signature}`,
          "x-grogoni-deletion-timestamp": timestamp
        },
        body,
        signal: AbortSignal.timeout(15_000)
      });

      if (!response.ok) {
        throw new Error(`Deletion processor ${config.id} returned HTTP ${response.status}.`);
      }
      const responseBody = (await response.json().catch(() => null)) as {
        externalReference?: unknown;
      } | null;
      const externalReference = responseBody?.externalReference;
      if (
        typeof externalReference !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(externalReference.trim())
      ) {
        throw new Error(`Deletion processor ${config.id} did not return an externalReference.`);
      }
      return { externalReference: externalReference.trim() };
    }
  };
}

function parseProcessorConfig(value: unknown, index: number): WebhookProcessorConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Deletion processor at index ${index} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  const urlValue = record.url;
  if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{1,63}$/.test(id)) {
    throw new Error(`Deletion processor at index ${index} has an invalid id.`);
  }
  if (typeof urlValue !== "string") {
    throw new Error(`Deletion processor ${id} has an invalid URL.`);
  }
  const url = new URL(urlValue);
  const localDevelopmentUrl =
    url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !localDevelopmentUrl) {
    throw new Error(`Deletion processor ${id} must use HTTPS.`);
  }
  if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
    throw new Error(`Deletion processor ${id} URL must not contain credentials or a fragment.`);
  }
  return { id, url: url.toString() };
}
