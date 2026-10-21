import { useEffect, useState } from "react";
import { AppIcon } from "./AppIcon";
import { type BeforeInstallPromptEvent } from "./grogoni-application-shared";

const installHelp = [
  "Open Grogoni in Chrome, Edge, or another supported Android browser.",
  "Tap the browser menu and choose Install app or Add to Home Screen.",
  "Confirm the install prompt and wait for the app icon to appear on your home screen."
];

export default function InstallPage() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(false);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setInstallPrompt(null);
      setInstalled(true);
    };

    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) {
      setInstalled(true);
    }

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const isSupportedPlatform = /Android/i.test(navigator.userAgent);
  const canInstallPrompt = installPrompt !== null && !installed;
  const browserLabel = detectBrowser();

  async function handleInstall() {
    if (installPrompt === null) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    setInstallPrompt(null);
    if (choice.outcome === "accepted") {
      setInstalled(true);
    }
  }

  return (
    <main className="install-page-shell">
      <section className="install-card" aria-labelledby="install-header">
        <div className="install-brand">
          <AppIcon className="install-brand-icon" />
          <div>
            <p className="install-kicker">Direct install</p>
            <h1 id="install-header">Install Grogoni</h1>
          </div>
        </div>

        <p className="install-intro">
          Install Grogoni as a secure Progressive Web App or download the signed Android APK when a
          browser does not offer an in-app install prompt.
        </p>

        <div className="install-status-row">
          <span className={`install-pill ${installed ? "is-installed" : ""}`}>
            {installed ? "Installed" : "Not installed yet"}
          </span>
          <span className="install-browser-pill">{browserLabel}</span>
        </div>

        {canInstallPrompt ? (
          <button type="button" className="install-primary-action" onClick={handleInstall}>
            Install Grogoni
          </button>
        ) : (
          <div className="install-secondary-stack">
            {isSupportedPlatform ? (
              <a className="install-primary-action" href="/" aria-label="Open Grogoni home">
                Open Grogoni in browser
              </a>
            ) : (
              <a className="install-primary-action" href="/marketplace" aria-label="Open the Grogoni marketplace">
                View marketplace
              </a>
            )}
          </div>
        )}

        <div className="install-grid">
          <section className="install-panel" aria-labelledby="install-pwa-header">
            <h2 id="install-pwa-header">Installable PWA</h2>
            <p>
              Grogoni is published with a valid web manifest and secure service worker. Most modern
              Android browsers support an Add to Home Screen flow without leaving the site.
            </p>
            {installPrompt !== null ? (
              <p className="install-note">A browser install prompt is available on this device.</p>
            ) : (
              <p className="install-note">
                A browser install prompt is not currently available. Follow the manual steps below.
              </p>
            )}
          </section>

          <section className="install-panel" aria-labelledby="install-apk-header">
            <h2 id="install-apk-header">Signed APK</h2>
            <p>
              For direct Android distribution, use the release APK signed with the production Android
              signing key, verified by the app installer and Google Play Protect before launch.
            </p>
            <a className="install-link" href="/" aria-label="Open the HTTPS download page">
              Download Android APK
            </a>
            <p className="install-note">
              Download links remain HTTPS-only and are shown only after the release is tested and
              signed.
            </p>
          </section>
        </div>

        <section className="install-steps" aria-labelledby="install-steps-header">
          <h2 id="install-steps-header">How to install on Android</h2>
          <ol>
            {installHelp.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p>
            If your browser does not show an install prompt, open the menu, choose <strong>Add to
            Home screen</strong> or <strong>Install app</strong>, then confirm the installation.
          </p>
          <p>
            Android will ask for permission to install from the current source before the app can be
            launched. No installation proceeds without explicit user approval.
          </p>
        </section>

        <section className="install-steps" aria-labelledby="install-security-header">
          <h2 id="install-security-header">Security and trust</h2>
          <ul>
            <li>Use the HTTPS-only production website.</li>
            <li>Keep the app signing certificate tied to the package name already registered for the release.</li>
            <li>Do not bypass Play Protect, Android package verification, or user consent.</li>
            <li>Complete authentication inside the same secure Grogoni session and do not expose app secrets.</li>
          </ul>
        </section>
      </section>
    </main>
  );
}

function detectBrowser(): string {
  const userAgent = navigator.userAgent;
  if (/EdgA?|EdgiOS/i.test(userAgent)) return "Microsoft Edge";
  if (/OPR\//i.test(userAgent)) return "Opera";
  if (/Chrome\//i.test(userAgent) && !/Edg|OPR\//i.test(userAgent)) return "Chrome";
  if (/Safari\//i.test(userAgent) && !/Chrome\//i.test(userAgent)) return "Safari";
  if (/Firefox\//i.test(userAgent)) return "Firefox";
  return "Supported mobile browser";
}
