import { useEffect, useState } from "react";
import { AppIcon } from "./AppIcon";
import { type BeforeInstallPromptEvent } from "./grogoni-application-shared";
import {
  loadAndroidRelease,
  persistAndroidInstallDismissed,
  readAndroidInstallDismissed,
  type AndroidReleaseStatus
} from "./android-release";

const installHelp = [
  "Open Grogoni in Chrome, Edge, or another supported Android browser.",
  "Tap the browser menu and choose Install app or Add to Home Screen.",
  "Confirm the install prompt and wait for the app icon to appear on your home screen."
];

interface AndroidNativeInstallState {
  /** True only when the device is Android AND a verified release is published. */
  offered: boolean;
  /** The validated release metadata, when offered. */
  release: Extract<AndroidReleaseStatus, { available: true }>["release"] | null;
  /** The user dismissed the card; it stays hidden until they revisit /install and choose to. */
  dismissed: boolean;
}

export default function InstallPage() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(false);
  const [androidNative, setAndroidNative] = useState<AndroidNativeInstallState>({
    offered: false,
    release: null,
    dismissed: readAndroidInstallDismissed()
  });

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

  // Only an Android device can install the native APK. The release manifest is fetched so the card
  // is offered *only* when a verified, signed release is actually published — never a placeholder.
  useEffect(() => {
    if (!/Android/i.test(navigator.userAgent)) {
      return;
    }
    let cancelled = false;
    void loadAndroidRelease().then((status) => {
      if (cancelled) return;
      setAndroidNative((current) => ({
        offered: status.available,
        release: status.available ? status.release : null,
        dismissed: current.dismissed
      }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const isSupportedPlatform = /Android/i.test(navigator.userAgent);
  const canInstallPrompt = installPrompt !== null && !installed;
  const browserLabel = detectBrowser();
  const showNativeInstall = androidNative.offered && androidNative.release !== null;
  const showNativeCard = showNativeInstall && !androidNative.dismissed && !installed;

  function dismissNativeInstall() {
    persistAndroidInstallDismissed();
    setAndroidNative((current) => ({ ...current, dismissed: true }));
  }

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

        {showNativeCard && androidNative.release !== null ? (
          <div
            className="install-android-native"
            role="region"
            aria-labelledby="install-native-header"
          >
            <div className="install-native-copy">
              <h2 id="install-native-header">Get Grogoni for Android</h2>
              <p>
                Install the signed Android app (version{" "}
                {androidNative.release.versionName || "latest"}, build{" "}
                {androidNative.release.versionCode}). Android verifies the download and asks for
                your approval before installing.
              </p>
            </div>
            <div className="install-native-actions">
              <a
                className="install-primary-action"
                href={androidNative.release.downloadUrl}
                rel="noopener noreferrer"
                download
                aria-label={`Download the signed Grogoni Android app, version ${androidNative.release.versionName || "latest"}`}
              >
                Install Grogoni for Android
              </a>
              <button
                type="button"
                className="install-native-secondary"
                onClick={dismissNativeInstall}
              >
                Not now
              </button>
            </div>
            <p className="install-native-trust">
              Downloaded over HTTPS from Grogoni. Android and Play Protect verify the signature; no
              install proceeds without your explicit approval.
            </p>
          </div>
        ) : canInstallPrompt ? (
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
              <a
                className="install-primary-action"
                href="/marketplace"
                aria-label="Open the Grogoni marketplace"
              >
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
              For direct Android distribution, use the release APK signed with the production
              Android signing key, verified by the app installer and Google Play Protect before
              launch.
            </p>
            {showNativeInstall && androidNative.release !== null ? (
              <a
                className="install-link"
                href={androidNative.release.downloadUrl}
                rel="noopener noreferrer"
                download
                aria-label="Download the signed Grogoni Android APK"
              >
                Download Android APK
              </a>
            ) : (
              <p className="install-note" role="note">
                No signed Android release is published yet. The download link appears here only
                after a tested, signed release is available.
              </p>
            )}
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
            If your browser does not show an install prompt, open the menu, choose{" "}
            <strong>Add to Home screen</strong> or <strong>Install app</strong>, then confirm the
            installation.
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
            <li>
              Keep the app signing certificate tied to the package name already registered for the
              release.
            </li>
            <li>Do not bypass Play Protect, Android package verification, or user consent.</li>
            <li>
              Complete authentication inside the same secure Grogoni session and do not expose app
              secrets.
            </li>
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
