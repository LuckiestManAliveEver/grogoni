import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const publicDirectory = "apps/web/public";

describe("PWA installability", () => {
  it("publishes a complete installable web app manifest", () => {
    const manifest = JSON.parse(
      readFileSync(`${publicDirectory}/manifest.webmanifest`, "utf8")
    ) as {
      name?: string;
      short_name?: string;
      start_url?: string;
      scope?: string;
      display?: string;
      launch_handler?: { client_mode?: string };
      shortcuts?: Array<{ url?: string }>;
      icons?: Array<{ src?: string; sizes?: string; type?: string; purpose?: string }>;
    };

    expect(manifest.name).toBe("Grogoni");
    expect(manifest.short_name).toBe("Grogoni");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.launch_handler?.client_mode).toBe("focus-existing");
    expect(manifest.shortcuts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "/marketplace" }),
        expect.objectContaining({ url: "/workspace" })
      ])
    );
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sizes: "any",
          type: "image/svg+xml",
          purpose: "any"
        }),
        expect.objectContaining({
          sizes: "192x192",
          type: "image/png",
          purpose: "any"
        }),
        expect.objectContaining({
          sizes: "512x512",
          type: "image/png",
          purpose: "any"
        }),
        expect.objectContaining({
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable"
        })
      ])
    );

    for (const icon of manifest.icons ?? []) {
      expect(icon.src).toMatch(/^\/icons\//);
      expect(existsSync(`${publicDirectory}${icon.src}`)).toBe(true);
    }
  });

  it("links the manifest and Apple touch icon and registers a service worker", () => {
    const html = readFileSync("apps/web/index.html", "utf8");
    const entrypoint = readFileSync("apps/web/src/main.tsx", "utf8");
    const serviceWorkerRegistration = readFileSync("apps/web/src/service-worker.ts", "utf8");
    const serviceWorker = readFileSync("apps/web/public/sw.js", "utf8");

    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="icon" href="/icons/grogoni-icon.svg"');
    expect(html).toContain('rel="icon" href="/icons/grogoni-icon-32.png"');
    expect(html).toContain('rel="shortcut icon" href="/favicon.ico"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('<script type="module" src="/src/main.tsx"></script>');
    expect(html).not.toContain('<script type="module">');
    expect(existsSync(`${publicDirectory}/favicon.ico`)).toBe(true);
    expect(existsSync(`${publicDirectory}/icons/grogoni-icon-32.png`)).toBe(true);
    expect(entrypoint).toContain("registerAppServiceWorker()");
    expect(serviceWorkerRegistration).toContain('.register("/sw.js"');
    expect(serviceWorkerRegistration).toContain('addEventListener("controllerchange"');
    expect(serviceWorkerRegistration).toContain("registration.update()");
    expect(serviceWorkerRegistration).toContain("window.location.reload()");
    expect(serviceWorkerRegistration).not.toContain('window.addEventListener("load"');
    expect(serviceWorker).toMatch(/const CACHE_NAME = `\$\{CACHE_PREFIX\}v\d+`/);
    expect(serviceWorker).toContain('"/favicon.ico"');
    expect(serviceWorker).toContain('"/icons/grogoni-icon-32.png"');
    expect(serviceWorker).toContain("cacheName !== CACHE_NAME");
    expect(serviceWorker).toContain("caches.delete(cacheName)");
  });

  it("never queues or caches interactive model activation requests", () => {
    const serviceWorker = readFileSync("apps/web/public/sw.js", "utf8");

    expect(serviceWorker).toContain("isInteractiveModelRequest(request, url)");
    expect(serviceWorker).toContain('code: "interactive_model_offline"');
    expect(serviceWorker).toContain('"Connect to the internet to activate this model."');
    expect(serviceWorker).toContain('"cache-control": "no-store"');
    expect(serviceWorker).not.toContain('addEventListener("sync"');
  });

  it("keeps canonical app icons while using the reference monogram in the home header", () => {
    const icon = readFileSync(`${publicDirectory}/icons/grogoni-icon.svg`, "utf8");
    const iconComponent = readFileSync("apps/web/src/AppIcon.tsx", "utf8");
    const application = readFileSync("apps/web/src/GrogoniApplication.tsx", "utf8");
    const phoneFirst = readFileSync("apps/web/src/PhoneFirstAuthentication.tsx", "utf8");
    const router = readFileSync("apps/web/src/AppRouter.tsx", "utf8");
    const legalPages = [
      "apps/web/src/legal/AccountDeletionPage.tsx",
      "apps/web/src/legal/PrivacyPolicyPage.tsx",
      "apps/web/src/legal/TermsOfServicePage.tsx"
    ].map((path) => readFileSync(path, "utf8"));

    expect(icon).toContain("A round African woven kiondo basket");
    expect(icon).toContain('viewBox="0 0 512 512"');
    expect(iconComponent).toContain('src="/icons/grogoni-icon.svg"');
    expect(application).toContain('<span className="home-brand-mark" aria-hidden="true">');
    expect(application).toContain('<AppIcon className="auth-header-icon" />');
    expect(phoneFirst).toContain('<AppIcon className="auth-wordmark-icon" />');
    expect(router).toContain('<AppIcon className="route-brand-icon" />');
    for (const legalPage of legalPages) {
      expect(legalPage).toContain('<AppIcon className="legal-brand-icon" />');
    }
  });
});
