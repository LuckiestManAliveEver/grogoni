import { createHash } from "node:crypto";
import { open, rename, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { ResolvedModelArtifact } from "@grogoni/shared-types";

import { InferenceServiceError } from "./service-error.js";

export async function downloadVerifiedArtifact(input: {
  artifact: ResolvedModelArtifact;
  allowedHosts: ReadonlySet<string>;
  maximumBytes: number;
  request?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ path: string; downloadMs: number }> {
  validateArtifact(input.artifact, input.allowedHosts, input.maximumBytes);
  const cacheKey = input.artifact.sha256 ?? input.artifact.id.replace(/[^a-z0-9._-]/giu, "_");
  const finalPath = join(tmpdir(), `grogoni-model-${cacheKey}.gguf`);
  const existing = await stat(finalPath).catch(() => null);
  if (
    existing !== null &&
    (input.artifact.sizeBytes === null || existing.size === input.artifact.sizeBytes)
  ) {
    return { path: finalPath, downloadMs: 0 };
  }
  const startedAt = Date.now();
  const response = await (input.request ?? fetch)(input.artifact.downloadUrl, {
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    redirect: "error",
    credentials: "omit"
  }).catch((error) => {
    throw new InferenceServiceError(
      "ARTIFACT_DOWNLOAD_FAILED",
      "The model artifact could not be downloaded.",
      true,
      502,
      { cause: error }
    );
  });
  if (!response.ok || response.body === null) {
    throw new InferenceServiceError(
      response.status === 404 ? "ARTIFACT_NOT_FOUND" : "ARTIFACT_DOWNLOAD_FAILED",
      "The model artifact could not be downloaded.",
      response.status >= 500,
      response.status === 404 ? 404 : 502
    );
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > input.maximumBytes) {
    throw new InferenceServiceError(
      "ARTIFACT_TOO_LARGE",
      "The model artifact is too large.",
      false,
      413
    );
  }
  const temporaryPath = `${finalPath}.${process.pid}.${Date.now()}.partial`;
  const file = await open(temporaryPath, "wx");
  const digest = createHash("sha256");
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const data = Buffer.from(value);
      bytes += data.byteLength;
      if (bytes > input.maximumBytes) {
        throw new InferenceServiceError(
          "ARTIFACT_TOO_LARGE",
          "The model artifact is too large.",
          false,
          413
        );
      }
      digest.update(data);
      await file.write(data);
    }
  } finally {
    reader.releaseLock();
    await file.close();
  }
  try {
    if (input.artifact.sizeBytes !== null && bytes !== input.artifact.sizeBytes) {
      throw new InferenceServiceError(
        "ARTIFACT_SIZE_MISMATCH",
        "The model artifact size did not match its metadata.",
        false,
        422
      );
    }
    const actualHash = digest.digest("hex");
    if (input.artifact.sha256 !== null && actualHash !== input.artifact.sha256) {
      throw new InferenceServiceError(
        "ARTIFACT_HASH_MISMATCH",
        "The model artifact checksum did not match its metadata.",
        false,
        422
      );
    }
    await rename(temporaryPath, finalPath);
    return { path: finalPath, downloadMs: Date.now() - startedAt };
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function validateArtifact(
  artifact: ResolvedModelArtifact,
  allowedHosts: ReadonlySet<string>,
  maximumBytes: number
): void {
  if (artifact.format.toLowerCase() !== "gguf") {
    throw new InferenceServiceError(
      "UNSUPPORTED_MODEL_FORMAT",
      "Only GGUF artifacts are supported.",
      false,
      422
    );
  }
  if (artifact.sizeBytes !== null && artifact.sizeBytes > maximumBytes) {
    throw new InferenceServiceError(
      "ARTIFACT_TOO_LARGE",
      "The model artifact is too large.",
      false,
      413
    );
  }
  if (artifact.sha256 !== null && !/^[0-9a-f]{64}$/u.test(artifact.sha256)) {
    throw new InferenceServiceError(
      "ARTIFACT_METADATA_INVALID",
      "The artifact checksum is invalid.",
      false,
      400
    );
  }
  const url = new URL(artifact.downloadUrl);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname.toLowerCase())) {
    throw new InferenceServiceError(
      "ARTIFACT_URL_FORBIDDEN",
      "The artifact URL is not allowed.",
      false,
      400
    );
  }
  if (new Date(artifact.expiresAt).getTime() <= Date.now()) {
    throw new InferenceServiceError(
      "ARTIFACT_URL_EXPIRED",
      "The artifact URL has expired.",
      true,
      401
    );
  }
  // Prevent deceptive metadata from influencing filesystem paths. The downloaded filename is
  // derived exclusively from a digest/id, never from objectKey.
  void basename(artifact.objectKey);
}
