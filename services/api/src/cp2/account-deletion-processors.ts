import { createHmac } from "node:crypto";
import type { AccountDeletionProcessor, AccountDeletionSubject } from "./store.js";

interface WebhookProcessorConfig {
  id: string;
  url: string;
}

/** Runs inside the purge itself and calls Brevo's API directly; no webhook endpoint involved. */
interface BrevoProcessorConfig {
  id: string;
  type: "brevo";
}

type ProcessorConfig = WebhookProcessorConfig | BrevoProcessorConfig;

/**
 * ACCOUNT_DELETION_PROCESSORS_JSON is a non-empty array of
 *   {"id": "...", "url": "https://..."}  a signed webhook (needs ACCOUNT_DELETION_WEBHOOK_SECRET)
 *   {"id": "...", "type": "brevo"}       erases the account's emails from Brevo (needs BREVO_API_KEY)
 */
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

  const configs = parsed.map(parseProcessorConfig);
  const ids = new Set<string>();
  for (const config of configs) {
    if (ids.has(config.id)) throw new Error(`Duplicate deletion processor id: ${config.id}`);
    ids.add(config.id);
  }

  let secret: string | undefined;
  if (configs.some((config) => !("type" in config))) {
    secret = environment.ACCOUNT_DELETION_WEBHOOK_SECRET?.trim();
    if (secret === undefined || secret.length < 32) {
      throw new Error("ACCOUNT_DELETION_WEBHOOK_SECRET must contain at least 32 characters.");
    }
  }
  let brevoApiKey: string | undefined;
  if (configs.some((config) => "type" in config)) {
    brevoApiKey = environment.BREVO_API_KEY?.trim();
    if (brevoApiKey === undefined || brevoApiKey.length === 0) {
      throw new Error("BREVO_API_KEY is required for a brevo deletion processor.");
    }
  }

  return configs.map((config) =>
    "type" in config
      ? createBrevoDeletionProcessor({ id: config.id, apiKey: brevoApiKey as string })
      : createSignedDeletionWebhookProcessor(config, secret as string)
  );
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const brevoApiBase = "https://api.brevo.com/v3";

/**
 * Brevo keeps a transactional log entry (address, IP, subject, date) for every OTP and
 * notification email it delivers, plus any contact that was added by hand. This erases both
 * for every email address among the account's deletion subjects. Brevo answers 404
 * `document_not_found` when it holds nothing for an address, which counts as already erased, so
 * a retry after a partial failure is safe. Error messages never include the address.
 */
export function createBrevoDeletionProcessor(config: {
  id: string;
  apiKey: string;
}): AccountDeletionProcessor {
  return {
    id: config.id,
    async deleteAccount(input) {
      const emails = deletionEmails(input.subjects);
      let logs = 0;
      let contacts = 0;
      for (const email of emails) {
        if (await brevoDelete(config, "smtp/log", email)) logs += 1;
        if (await brevoDelete(config, "contacts", email)) contacts += 1;
      }
      return {
        externalReference: `brevo:emails-${emails.length}:logs-${logs}:contacts-${contacts}`
      };
    }
  };
}

/**
 * Distinct email addresses among the subjects, whatever provider recorded them. Each address is
 * erased as recorded and lower-cased, in case Brevo matches log identifiers by exact case.
 */
export function deletionEmails(subjects: AccountDeletionSubject[]): string[] {
  const emails = subjects
    .map((item) => item.subject.trim())
    .filter((subject) => emailPattern.test(subject))
    .flatMap((subject) => [subject, subject.toLowerCase()]);
  return [...new Set(emails)].sort();
}

/** true: Brevo erased something; false: it held nothing for this address. Throws otherwise. */
async function brevoDelete(
  config: { id: string; apiKey: string },
  resource: "smtp/log" | "contacts",
  email: string
): Promise<boolean> {
  const response = await fetch(`${brevoApiBase}/${resource}/${encodeURIComponent(email)}`, {
    method: "DELETE",
    headers: { "api-key": config.apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(15_000)
  });
  if (response.ok) return true;
  if (response.status === 404) {
    const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
    if (body?.code === "document_not_found") return false;
  }
  throw new Error(
    `Deletion processor ${config.id} got HTTP ${response.status} from Brevo ${resource}.`
  );
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

function parseProcessorConfig(value: unknown, index: number): ProcessorConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Deletion processor at index ${index} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{1,63}$/.test(id)) {
    throw new Error(`Deletion processor at index ${index} has an invalid id.`);
  }
  if ("type" in record) {
    if (record.type !== "brevo") throw new Error(`Deletion processor ${id} has an unknown type.`);
    if ("url" in record) throw new Error(`Deletion processor ${id} cannot have both type and url.`);
    return { id, type: "brevo" };
  }
  const urlValue = record.url;
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
