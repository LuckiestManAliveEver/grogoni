import { createHash, createHmac } from "node:crypto";
import { Cp2Error } from "./store.js";

export interface BinaryUploadInput {
  businessId: string;
  fileName: string;
  contentType: string;
  bytes: Buffer;
}

export interface BinaryUploadPipelineResult {
  checksum: string;
  storageKey: string | null;
}

export interface BinaryUploadPipeline {
  process(
    input: BinaryUploadInput,
    options: { retain: boolean }
  ): Promise<BinaryUploadPipelineResult>;
}

interface SignedEndpoint {
  url: string;
  secret: string;
}

export function createBinaryUploadPipelineFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): BinaryUploadPipeline {
  const scannerEnabled = environment.MALWARE_SCANNER_ENABLED?.trim().toLowerCase() === "true";
  if (!scannerEnabled) {
    console.info("[BinaryUpload] Malware scanning disabled.");
    return createPassthroughBinaryUploadPipeline();
  }

  const scanner = readSignedEndpoint(environment, "MALWARE_SCANNER_URL", "MALWARE_SCANNER_SECRET");
  if (scanner === undefined) {
    throw new Error(
      "MALWARE_SCANNER_URL and MALWARE_SCANNER_SECRET are required when malware scanning is enabled."
    );
  }

  const storage = readSignedEndpoint(environment, "OBJECT_STORAGE_URL", "OBJECT_STORAGE_SECRET");
  const storageRequired = environment.REQUIRE_OBJECT_STORAGE === "true";
  if (storage === undefined && storageRequired) {
    throw new Error(
      "OBJECT_STORAGE_URL and OBJECT_STORAGE_SECRET are required when object storage is enabled."
    );
  }
  return createHttpBinaryUploadPipeline({
    scanner,
    ...(storage === undefined ? {} : { storage })
  });
}

export function createPassthroughBinaryUploadPipeline(): BinaryUploadPipeline {
  return {
    async process(input) {
      return {
        checksum: calculateChecksum(input.bytes),
        storageKey: null
      };
    }
  };
}

export function createHttpBinaryUploadPipeline(options: {
  scanner?: SignedEndpoint;
  storage?: SignedEndpoint;
  fetcher?: typeof fetch;
}): BinaryUploadPipeline {
  const fetcher = options.fetcher ?? fetch;
  return {
    async process(input, processOptions) {
      const checksum = calculateChecksum(input.bytes);
      const payload = {
        schemaVersion: 1,
        businessId: input.businessId,
        fileName: input.fileName,
        contentType: input.contentType,
        sizeBytes: input.bytes.byteLength,
        checksum,
        contentBase64: input.bytes.toString("base64")
      };

      if (options.scanner !== undefined) {
        const response = await signedRequest(fetcher, options.scanner, payload, checksum);
        if (!response.ok) {
          throw new Cp2Error(503, "malware_scanner_unavailable", "Upload scanning is unavailable.");
        }
        const result = (await response.json().catch(() => null)) as {
          status?: unknown;
        } | null;
        if (result?.status === "infected") {
          throw new Cp2Error(
            422,
            "malware_detected",
            "The uploaded file failed the malware safety scan."
          );
        }
        if (result?.status !== "clean") {
          throw new Cp2Error(
            502,
            "malware_scan_invalid",
            "The malware scanner returned an invalid result."
          );
        }
      }

      if (!processOptions.retain || options.storage === undefined) {
        return { checksum, storageKey: null };
      }
      const response = await signedRequest(fetcher, options.storage, payload, checksum);
      if (!response.ok) {
        throw new Cp2Error(503, "object_storage_unavailable", "Upload storage is unavailable.");
      }
      const result = (await response.json().catch(() => null)) as {
        storageKey?: unknown;
      } | null;
      if (
        typeof result?.storageKey !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9/_.:-]{0,511}$/u.test(result.storageKey)
      ) {
        throw new Cp2Error(
          502,
          "object_storage_invalid",
          "Object storage returned an invalid object key."
        );
      }
      return { checksum, storageKey: result.storageKey };
    }
  };
}

function calculateChecksum(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readSignedEndpoint(
  environment: NodeJS.ProcessEnv,
  urlName: string,
  secretName: string
): SignedEndpoint | undefined {
  const value = environment[urlName]?.trim();
  const secret = environment[secretName]?.trim();
  if (!value && !secret) return undefined;
  if (!value || !secret || secret.length < 32) {
    throw new Error(`${urlName} and a 32-character ${secretName} must be configured together.`);
  }
  const url = new URL(value);
  const local =
    url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !local) throw new Error(`${urlName} must use HTTPS.`);
  if (url.username || url.password || url.hash) {
    throw new Error(`${urlName} must not contain credentials or a fragment.`);
  }
  return { url: url.toString(), secret };
}

async function signedRequest(
  fetcher: typeof fetch,
  endpoint: SignedEndpoint,
  payload: Record<string, unknown>,
  idempotencyKey: string
): Promise<Response> {
  const timestamp = new Date().toISOString();
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", endpoint.secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  try {
    return await fetcher(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-grogoni-upload-signature": `sha256=${signature}`,
        "x-grogoni-upload-timestamp": timestamp
      },
      body,
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    throw new Cp2Error(503, "upload_integration_unavailable", "Upload processing is unavailable.");
  }
}
