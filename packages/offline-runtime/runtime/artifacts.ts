import type { Artifact } from "../types.js";
export async function cacheVerifiedArtifacts(
  artifacts: Artifact[],
  cache: Cache,
  progress: (done: number, total: number) => void,
  fetcher: typeof fetch = fetch
): Promise<void> {
  const total = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
  let done = 0;
  for (const artifact of artifacts) {
    const key = `https://offline.grogoni.invalid/artifacts/${artifact.sha256}`;
    const cached = await cache.match(key);
    if (cached && (await verified(await cached.arrayBuffer(), artifact))) {
      done += artifact.bytes;
      progress(done, total);
      continue;
    }
    const buffer = await downloadVerified(artifact, fetcher, (count) =>
      progress(done + count, total)
    );
    await cache.put(key, new Response(buffer));
    done += buffer.byteLength;
    progress(done, total);
  }
}
/**
 * Same integrity guarantees as cacheVerifiedArtifacts, but keyed by the artifact's own URL rather
 * than a synthetic content-addressed key - required when the artifact is consumed by something
 * that fetches it directly (e.g. a Worker's importScripts), not read back through our own code, so
 * a Service Worker must be able to serve it straight from the cache by its real request URL.
 */
export async function cacheArtifactsByUrl(
  artifacts: Artifact[],
  cache: Cache,
  progress: (done: number, total: number) => void,
  fetcher: typeof fetch = fetch
): Promise<void> {
  const total = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
  let done = 0;
  for (const artifact of artifacts) {
    const cached = await cache.match(artifact.url);
    if (
      cached &&
      (!artifact.url.endsWith(".js") ||
        cached.headers.get("content-type")?.includes("javascript")) &&
      (await verified(await cached.arrayBuffer(), artifact))
    ) {
      done += artifact.bytes;
      progress(done, total);
      continue;
    }
    const buffer = await downloadVerified(artifact, fetcher, (count) =>
      progress(done + count, total)
    );
    await cache.put(
      artifact.url,
      new Response(buffer, {
        headers: {
          "content-type": new URL(
            artifact.url,
            "https://offline.grogoni.invalid"
          ).pathname.endsWith(".js")
            ? "application/javascript"
            : "application/octet-stream"
        }
      })
    );
    done += buffer.byteLength;
    progress(done, total);
  }
}
async function downloadVerified(
  artifact: Artifact,
  fetcher: typeof fetch,
  progress: (count: number) => void
) {
  const response = await fetcher(artifact.url, { credentials: "omit" });
  if (!response.ok || !response.body)
    throw new Error("The pinned artifact could not be downloaded.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      count += next.value.byteLength;
      if (count > artifact.bytes) throw new Error("Artifact exceeds its declared size.");
      chunks.push(next.value);
      progress(count);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  const buffer = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  if (!(await verified(buffer.buffer, artifact)))
    throw new Error("Pinned artifact integrity verification failed.");
  return buffer;
}
async function verified(buffer: ArrayBuffer, artifact: Artifact): Promise<boolean> {
  if (buffer.byteLength !== artifact.bytes) return false;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return (
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") ===
    artifact.sha256.toLowerCase()
  );
}
