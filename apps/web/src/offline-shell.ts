import { assertStorage } from "@grogoni/offline-runtime";
const cacheName = "grogoni-offline-shell-v1";
const activeKey = "/__grogoni_offline_active__";
export async function prepareOfflineShell(
  progress: (completed: number, total: number) => void
): Promise<void> {
  if (import.meta.env.DEV) return;
  if (!navigator.serviceWorker?.controller)
    throw new Error("Reload Grogoni once to activate offline support, then try again.");
  const response = await fetch("/offline-manifest.json", { cache: "no-store" });
  if (!response.ok) throw new Error("The offline application manifest is unavailable.");
  const manifest = (await response.json()) as { files: string[]; bytes: number };
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.some(
      (file) => typeof file !== "string" || !/^assets\/[A-Za-z0-9_.-]+$/.test(file)
    )
  )
    throw new Error("Invalid offline application manifest.");
  assertStorage(await navigator.storage.estimate(), manifest.bytes * 2 + 16 * 1024 * 1024);
  const cache = await caches.open(cacheName);
  const paths = ["/", ...manifest.files.map((file) => `/${file}`)];
  let completed = 0;
  for (const path of paths) {
    const asset = await fetch(path, { cache: "no-store" });
    if (!asset.ok) throw new Error(`Unable to download the offline application (${path}).`);
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
