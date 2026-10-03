import { createHash, createHmac } from "node:crypto";
import type { ModelArtifact } from "@grogoni/shared-types";
import { describe, expect, it, vi } from "vitest";

import { createNeonModelArtifactStore } from "../services/api/src/inference/model-artifact-store";

// Regression coverage for a real production incident: verifyArtifact() reused the GET-signed
// download URL from createDownloadUrl() to perform a HEAD request. A SigV4 presigned URL's
// signature is bound to the HTTP method it was signed for; real AWS S3 tolerates a HEAD against a
// GET-signed URL, but Neon's S3-compatible object storage enforces the method strictly and
// returned 403 for every verifyArtifact() call - even against a correctly uploaded,
// checksum-matching object - because the signature was computed for "GET" but the actual request
// sent was "HEAD". Confirmed against the real Neon bucket before and after the fix.

const now = new Date("2026-01-01T00:00:00.000Z");
const endpoint = "https://example.storage.neon.tech";
const accessKeyId = "AKIDEXAMPLE";
const secretAccessKey = "test-secret-access-key";
const region = "us-east-2";

const artifact: ModelArtifact = {
  id: "builtin:smollm2-360m:q4_0:gguf",
  modelId: "smollm2-360m",
  storageProvider: "neon-object-storage",
  bucket: "grogoni-model-artifacts",
  objectKey: "models/smollm2-360m/SmolLM2-360M-Instruct-Q4_0.gguf",
  format: "gguf",
  quantization: "Q4_0",
  sizeBytes: 229733280,
  sha256: "c3608933eb6e5763b87f769bda40c204dc158333668c7af214644fe39da58627",
  contentType: "application/octet-stream",
  status: "available",
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z"
};

function expectedSignature(method: "GET" | "HEAD"): string {
  const dateTime = now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  const date = dateTime.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const path = `/${encodeURIComponent(artifact.bucket)}/${artifact.objectKey
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const query = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": dateTime,
    "X-Amz-Expires": "900",
    "X-Amz-SignedHeaders": "host"
  });
  query.sort();
  const canonicalRequest = [
    method,
    path,
    query.toString(),
    `host:${new URL(endpoint).host}\n`,
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
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), "s3"),
    "aws4_request"
  );
  return createHmac("sha256", signingKey).update(stringToSign).digest("hex");
}

describe("createNeonModelArtifactStore SigV4 presigning", () => {
  it("signs the download URL for a GET request", async () => {
    const store = createNeonModelArtifactStore({
      database: { query: vi.fn() },
      endpoint,
      region,
      accessKeyId,
      secretAccessKey,
      now: () => now
    });
    const resolved = await store.createDownloadUrl(artifact);
    const url = new URL(resolved.downloadUrl);
    expect(url.searchParams.get("X-Amz-Signature")).toBe(expectedSignature("GET"));
  });

  it("signs verifyArtifact's own request for HEAD, not the GET-signed download URL (regression)", async () => {
    const request = vi.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: { "content-length": String(artifact.sizeBytes) }
        })
    );
    const store = createNeonModelArtifactStore({
      database: { query: vi.fn() },
      endpoint,
      region,
      accessKeyId,
      secretAccessKey,
      now: () => now,
      request: request as unknown as typeof fetch
    });

    const result = await store.verifyArtifact(artifact);
    expect(result).toEqual({ ok: true, sizeMatches: true, hashMatches: null, errorCode: null });

    expect(request).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = request.mock.calls[0] as [string, RequestInit];
    expect(calledInit.method).toBe("HEAD");
    const signature = new URL(calledUrl).searchParams.get("X-Amz-Signature");
    expect(signature).toBe(expectedSignature("HEAD"));
    // The historical bug: verifyArtifact reused createDownloadUrl()'s GET-signed URL for its HEAD
    // request. Real AWS S3 accepts that mismatch; Neon's S3-compatible backend returns 403 for it.
    expect(signature).not.toBe(expectedSignature("GET"));
  });

  it("reports ARTIFACT_UNREACHABLE without throwing when the signed HEAD request is rejected", async () => {
    const request = vi.fn(async () => new Response(null, { status: 403 }));
    const store = createNeonModelArtifactStore({
      database: { query: vi.fn() },
      endpoint,
      region,
      accessKeyId,
      secretAccessKey,
      now: () => now,
      request: request as unknown as typeof fetch
    });

    const result = await store.verifyArtifact(artifact);
    expect(result).toEqual({
      ok: false,
      sizeMatches: null,
      hashMatches: null,
      errorCode: "ARTIFACT_UNREACHABLE"
    });
  });
});
