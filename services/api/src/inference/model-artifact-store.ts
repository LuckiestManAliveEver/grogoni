import { createHash, createHmac } from "node:crypto";
import type {
  ArtifactVerificationResult,
  ModelArtifact,
  ResolvedModelArtifact
} from "@grogoni/shared-types";
import type { Pool } from "pg";

import { ModelRuntimeError } from "./model-runtime.js";

export interface ModelArtifactStore {
  resolveArtifact(modelId: string): Promise<ModelArtifact>;
  createDownloadUrl(artifact: ModelArtifact): Promise<ResolvedModelArtifact>;
  verifyArtifact(
    artifact: ModelArtifact,
    signal?: AbortSignal
  ): Promise<ArtifactVerificationResult>;
}

export interface NeonModelArtifactStoreOptions {
  database: Pick<Pool, "query">;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  downloadUrlTtlSeconds?: number;
  request?: typeof fetch;
  now?: () => Date;
}

/**
 * Neon/PostgreSQL is authoritative for artifact metadata. The referenced bytes are fetched from
 * Neon's S3-compatible object storage through short-lived SigV4 URLs; credentials stay on Render.
 *
 * Backed by cp2_runtime_model_artifacts (migration 079), not cp2_model_artifacts (migration 066,
 * the legacy account-scoped Postgres-bytea upload subsystem in cp2/postgres-store.ts) - the two
 * tables model unrelated concepts and must never be merged or share a name.
 */
export function createNeonModelArtifactStore(
  options: NeonModelArtifactStoreOptions
): ModelArtifactStore {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "https:") {
    throw new Error("NEON_MODEL_STORAGE_ENDPOINT must use https.");
  }
  if (options.accessKeyId.trim() === "" || options.secretAccessKey.trim() === "") {
    throw new Error("Neon model-storage credentials are required.");
  }
  const ttlSeconds = options.downloadUrlTtlSeconds ?? 900;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) {
    throw new Error("Model artifact download URL TTL must be between 60 and 3600 seconds.");
  }
  const now = options.now ?? (() => new Date());
  const request = options.request ?? fetch;

  const presign = (artifact: ModelArtifact, method: "GET" | "HEAD") => {
    const signedAt = now();
    return {
      downloadUrl: presignS3Request({
        method,
        endpoint,
        bucket: artifact.bucket,
        objectKey: artifact.objectKey,
        region: options.region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        expiresSeconds: ttlSeconds,
        now: signedAt
      }),
      expiresAt: new Date(signedAt.getTime() + ttlSeconds * 1000).toISOString()
    };
  };

  const createDownloadUrl = async (artifact: ModelArtifact): Promise<ResolvedModelArtifact> => {
    assertSafeArtifactLocation(artifact);
    const { downloadUrl, expiresAt } = presign(artifact, "GET");
    return { ...artifact, downloadUrl, expiresAt };
  };

  return {
    async resolveArtifact(modelId) {
      const result = await options.database.query(
        `select id, model_id, storage_provider, bucket, object_key, format, quantization,
                size_bytes, sha256, content_type, status, created_at, updated_at
           from cp2_runtime_model_artifacts
          where model_id = $1 and status = 'available'
          order by updated_at desc, id asc
          limit 1`,
        [modelId]
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (row === undefined) {
        throw new ModelRuntimeError(
          "ARTIFACT_NOT_FOUND",
          "No available model artifact is registered for the selected model.",
          false
        );
      }
      const artifact = artifactFromRow(row);
      assertSafeArtifactLocation(artifact);
      return artifact;
    },
    createDownloadUrl,
    async verifyArtifact(artifact, signal) {
      try {
        assertSafeArtifactLocation(artifact);
        // Signed independently of createDownloadUrl(): a SigV4 presigned URL's signature is bound
        // to the HTTP method it was signed for. Real AWS S3 tolerates a HEAD against a GET-signed
        // URL, but Neon's S3-compatible backend enforces the method strictly and returns 403 -
        // reusing the GET-signed download URL here made every verifyArtifact() call fail against
        // real infrastructure even for a correctly uploaded, checksum-matching object.
        const { downloadUrl } = presign(artifact, "HEAD");
        const response = await request(downloadUrl, {
          method: "HEAD",
          ...(signal === undefined ? {} : { signal })
        });
        if (!response.ok) {
          return {
            ok: false,
            sizeMatches: null,
            hashMatches: null,
            errorCode: response.status === 404 ? "ARTIFACT_NOT_FOUND" : "ARTIFACT_UNREACHABLE"
          };
        }
        const length = response.headers.get("content-length");
        const actualSize = length === null ? null : Number(length);
        const sizeMatches =
          artifact.sizeBytes === null || actualSize === null
            ? null
            : Number.isFinite(actualSize) && actualSize === artifact.sizeBytes;
        return {
          ok: sizeMatches !== false,
          sizeMatches,
          // Hash verification happens while Vercel downloads the full object. A HEAD request
          // cannot prove a SHA-256 unless the object service exposes a trustworthy checksum.
          hashMatches: null,
          errorCode: sizeMatches === false ? "ARTIFACT_SIZE_MISMATCH" : null
        };
      } catch {
        return {
          ok: false,
          sizeMatches: null,
          hashMatches: null,
          errorCode: "ARTIFACT_UNREACHABLE"
        };
      }
    }
  };
}

function artifactFromRow(row: Record<string, unknown>): ModelArtifact {
  const text = (name: string) => {
    const value = row[name];
    if (typeof value !== "string" || value.trim() === "") {
      throw new ModelRuntimeError(
        "ARTIFACT_METADATA_INVALID",
        `Artifact ${name} is invalid.`,
        false
      );
    }
    return value;
  };
  const nullableText = (name: string) => (typeof row[name] === "string" ? row[name] : null);
  const size = row.size_bytes === null ? null : Number(row.size_bytes);
  if (size !== null && (!Number.isSafeInteger(size) || size <= 0)) {
    throw new ModelRuntimeError("ARTIFACT_METADATA_INVALID", "Artifact size is invalid.", false);
  }
  const status = text("status");
  if (status !== "available") {
    throw new ModelRuntimeError(
      "ARTIFACT_NOT_AVAILABLE",
      "The model artifact is unavailable.",
      false
    );
  }
  return {
    id: text("id"),
    modelId: text("model_id"),
    storageProvider: text("storage_provider"),
    bucket: text("bucket"),
    objectKey: text("object_key"),
    format: text("format").toLowerCase(),
    quantization: nullableText("quantization"),
    sizeBytes: size,
    sha256: nullableText("sha256"),
    contentType: text("content_type"),
    status: "available",
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function assertSafeArtifactLocation(artifact: ModelArtifact): void {
  if (artifact.storageProvider !== "neon-object-storage") {
    throw new ModelRuntimeError(
      "ARTIFACT_STORAGE_UNSUPPORTED",
      "The artifact storage provider is unsupported.",
      false
    );
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,62}$/u.test(artifact.bucket)) {
    throw new ModelRuntimeError("ARTIFACT_METADATA_INVALID", "Artifact bucket is invalid.", false);
  }
  if (
    artifact.objectKey.startsWith("/") ||
    artifact.objectKey.includes("\\") ||
    artifact.objectKey.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new ModelRuntimeError(
      "ARTIFACT_METADATA_INVALID",
      "Artifact object key is invalid.",
      false
    );
  }
}

function presignS3Request(input: {
  method: "GET" | "HEAD";
  endpoint: URL;
  bucket: string;
  objectKey: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  now: Date;
}): string {
  const dateTime = input.now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  const date = dateTime.slice(0, 8);
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const path = `/${encodeURIComponent(input.bucket)}/${input.objectKey
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const query = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKeyId}/${scope}`,
    "X-Amz-Date": dateTime,
    "X-Amz-Expires": String(input.expiresSeconds),
    "X-Amz-SignedHeaders": "host"
  });
  query.sort();
  const canonicalRequest = [
    input.method,
    path,
    query.toString(),
    `host:${input.endpoint.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD"
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    dateTime,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex")
  ].join("\n");
  const hmac = (key: string | Buffer, value: string) =>
    createHmac("sha256", key).update(value).digest();
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), "s3"),
    "aws4_request"
  );
  query.set("X-Amz-Signature", createHmac("sha256", signingKey).update(stringToSign).digest("hex"));
  const url = new URL(input.endpoint);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}${path}`;
  url.search = query.toString();
  return url.toString();
}
