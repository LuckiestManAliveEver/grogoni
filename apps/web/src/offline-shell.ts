import { assertStorage } from "@grogoni/offline-runtime";
const cacheName = "grogoni-offline-shell-v1";
const activeKey = "/__grogoni_offline_active__";
export async function prepareOfflineShell(
  progress: (completed: number, total: number) => void
): Promise<void> {
  if (import.meta.env.DEV) return;
  if (!navigator.serviceWorker?.controller)
    throw new Error("Reload Grogoni once to activate offline support, then try again.");
  const response = await fetch("/offline-manifest.json", {
    cache: "no-store",
    credentials: "omit"
  });
  if (!response.ok) throw new Error("The offline application manifest is unavailable.");
  const manifest = (await response.json()) as { files: string[]; bytes: number };
  if (
    !manifest ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes <= 0 ||
    manifest.bytes > 256 * 1024 * 1024 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > 2048 ||
    new Set(manifest.files).size !== manifest.files.length ||
    manifest.files.some(
      (file) => typeof file !== "string" || !/^assets\/[A-Za-z0-9_.-]+$/.test(file)
    )
  )
    throw new Error("Invalid offline application manifest.");
  assertStorage(await navigator.storage.estimate(), manifest.bytes * 2 + 16 * 1024 * 1024);
  const cache = await caches.open(cacheName);
  // Publish the new root last: interruption must not replace a working root with one
  // referencing assets that have not yet been downloaded.
  const paths = [...manifest.files.map((file) => `/${file}`), "/"];
  let completed = 0;
  for (const path of paths) {
    const asset = await fetch(path, { cache: "no-store", credentials: "omit", redirect: "error" });
    if (!asset.ok) throw new Error(`Unable to download the offline application (${path}).`);
    const policy = asset.headers.get("cache-control") || "";
    if (
      asset.redirected ||
      asset.type === "opaque" ||
      /(?:^|,)\s*(?:private|no-store)(?:\s|,|=|$)/i.test(policy) ||
      asset.headers.has("set-cookie") ||
      asset.headers.has("vary")
    )
      throw new Error("The offline application response is not safe to save on this device.");
    if (path === "/" && !asset.headers.get("content-type")?.includes("text/html"))
      throw new Error("The offline application shell is not HTML.");
    await cache.put(path, asset);
    progress(++completed, paths.length);
  }
}
export async function activateOfflineShell(active: boolean): Promise<void> {
  if (import.meta.env.DEV || !("caches" in globalThis)) return;
  const cache = await caches.open(cacheName);
  if (active) await cache.put(activeKey, new Response("active"));
  else await cache.delete(activeKey);
}
