import { isExplicitOfflineMode } from "./offline-runtime";
export function registerAppServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  if (import.meta.env.DEV) {
    void unregisterDevelopmentServiceWorkers();
    return;
  }

  const controlledAtStartup = navigator.serviceWorker.controller !== null;
  let reloadingForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!controlledAtStartup || reloadingForUpdate || isExplicitOfflineMode()) return;
    reloadingForUpdate = true;
    window.location.reload();
  });

  void navigator.serviceWorker
    .register("/sw.js", {
      scope: "/",
      updateViaCache: "none"
    })
    .then((registration) => {
      if (!isExplicitOfflineMode()) return registration.update();
    })
    .catch((error: unknown) => {
      console.error("Unable to register the Grogoni service worker.", error);
    });
}

async function unregisterDevelopmentServiceWorkers() {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));

    if ("caches" in globalThis) {
      const cacheNames = await globalThis.caches.keys();
      await Promise.all(
        cacheNames
          .filter((cacheName) => cacheName.startsWith("grogoni-app-"))
          .map((cacheName) => globalThis.caches.delete(cacheName))
      );
    }
  } catch (error) {
    console.warn("Unable to unregister the development service worker.", error);
  }
}
