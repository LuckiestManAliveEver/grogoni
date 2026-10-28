/**
 * The single source of truth for "is a verified native Android release available?".
 *
 * The browser cannot know whether a separately installed APK exists on the device, so the only
 * honest signal is whether *Grogoni* has published a verified release. That release is described
 * by a static JSON manifest served from the Grogoni web origin, and is gated here on:
 *
 *  - an HTTPS download URL on the Grogoni origin (never an external or placeholder host),
 *  - the production package id,
 *  - a positive integer versionCode,
 *  - a colon-separated uppercase SHA-256 artifact fingerprint.
 *
 * When the manifest is missing, malformed, or fails any check, `available` is `false` and the
 * install call-to-action must stay hidden. This module never fabricates a download URL; publishing
 * a release is a deliberate act of replacing the manifest with real, signed artifact metadata.
 *
 * Keep this module free of React and DOM-only access so it is unit-testable and reusable by any
 * surface that needs to offer (or suppress) the native install.
 */

/** Path of the release manifest, relative to the production web origin. */
export const androidReleaseManifestPath = "/android/release.json";

/** The Android application id this repository builds (apps/android/app/build.gradle.kts). */
export const expectedAndroidPackageId = "market.grogoni.app";

/** Production web origin that must host the release manifest and the signed artifact. */
const productionWebOrigin = "https://grogoni.com";

/** localStorage key recording that the user chose "Not Now" for the native-install card. */
export const androidInstallDismissedStorageKey = "grogoni.android-install-prompt-dismissed.v1";

/** Pseudo-URL the manifest is resolved against when `window` is not available (tests, SSR). */
export const defaultReleaseManifestUrl = `${productionWebOrigin}${androidReleaseManifestPath}`;

export interface AndroidRelease {
  packageName: string;
  versionName: string;
  versionCode: number;
  /** Absolute HTTPS URL of the signed APK, on the Grogoni origin. */
  downloadUrl: string;
  /** Colon-separated uppercase SHA-256 fingerprint of the APK artifact. */
  sha256: string;
  /** Minimum supported Android API level, for guidance only. */
  minSdk: number;
}

export type AndroidReleaseStatus =
  | { available: true; release: AndroidRelease; manifestUrl: string }
  | {
      available: false;
      reason:
        | "not-published"
        | "invalid-url"
        | "invalid-package"
        | "invalid-version"
        | "invalid-sha256"
        | "untrusted-host";
      manifestUrl: string;
    };

const sha256Pattern = /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/;

/**
 * Validate a parsed manifest object. Returns the typed release on success or a reason on failure.
 * Exported so the same rules apply to the build-time gate and to unit tests.
 */
export function parseAndroidRelease(raw: unknown, manifestUrl: string): AndroidReleaseStatus {
  if (raw === null || typeof raw !== "object") {
    return { available: false, reason: "not-published", manifestUrl };
  }
  const candidate = raw as Record<string, unknown>;

  // A manifest without a release block means no release has been published yet.
  if (candidate.release === null || candidate.release === undefined) {
    return { available: false, reason: "not-published", manifestUrl };
  }

  const release = candidate.release as Record<string, unknown>;
  const downloadUrl = typeof release.downloadUrl === "string" ? release.downloadUrl : "";

  if (!isTrustedHttpsUrl(downloadUrl)) {
    return {
      available: false,
      reason: downloadUrl === "" ? "invalid-url" : "untrusted-host",
      manifestUrl
    };
  }

  if (release.packageName !== expectedAndroidPackageId) {
    return { available: false, reason: "invalid-package", manifestUrl };
  }

  const versionCode = release.versionCode;
  if (typeof versionCode !== "number" || !Number.isInteger(versionCode) || versionCode <= 0) {
    return { available: false, reason: "invalid-version", manifestUrl };
  }

  const sha256 = typeof release.sha256 === "string" ? release.sha256 : "";
  if (!sha256Pattern.test(sha256)) {
    return { available: false, reason: "invalid-sha256", manifestUrl };
  }

  return {
    available: true,
    manifestUrl,
    release: {
      packageName: release.packageName as string,
      versionName: typeof release.versionName === "string" ? release.versionName : "",
      versionCode,
      downloadUrl,
      sha256,
      minSdk: typeof release.minSdk === "number" ? release.minSdk : 23
    }
  };
}

/**
 * Resolve the release manifest URL for the current page. Only the production origin is trusted on a
 * deployed build; a local dev origin keeps its own origin so a developer can publish a fake
 * manifest for testing without exposing it in production.
 */
export function resolveReleaseManifestUrl(): string {
  try {
    const origin = window.location.origin;
    if (isLocalDevOrigin(origin)) {
      return `${origin}${androidReleaseManifestPath}`;
    }
  } catch {
    // No window (tests / SSR): fall back to the production manifest URL.
  }
  return defaultReleaseManifestUrl;
}

/**
 * Fetch and validate the release manifest. Any network or parse error is reported as
 * "not-published" — the safe default that hides the install call-to-action rather than offering a
 * download from an unverified source.
 */
export async function loadAndroidRelease(
  fetcher: typeof fetch = fetch,
  manifestUrl: string = resolveReleaseManifestUrl()
): Promise<AndroidReleaseStatus> {
  try {
    const response = await fetcher(manifestUrl, {
      headers: { accept: "application/json" },
      // The manifest is immutable metadata; let the browser cache it but re-validate.
      cache: "no-cache"
    });
    if (!response.ok) {
      return { available: false, reason: "not-published", manifestUrl };
    }
    const parsed: unknown = await response.json();
    return parseAndroidRelease(parsed, manifestUrl);
  } catch {
    return { available: false, reason: "not-published", manifestUrl };
  }
}

/**
 * Whether a download URL is a plain HTTPS URL on the Grogoni production origin (or the current
 * local-dev origin during development). This is the only place the "trusted source" rule lives.
 */
export function isTrustedHttpsUrl(value: string): boolean {
  if (value.trim() === "") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.origin === productionWebOrigin) return true;
  try {
    const currentOrigin = window.location.origin;
    return isLocalDevOrigin(currentOrigin) && url.origin === currentOrigin;
  } catch {
    return false;
  }
}

/** Local-development origins are trusted only for a local manifest so tests/devs can iterate. */
function isLocalDevOrigin(origin: string): boolean {
  return (
    origin.startsWith("http://127.0.0.1") ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://[::1]")
  );
}

/** Read the persisted "Not Now" dismissal for the native-install card. */
export function readAndroidInstallDismissed(): boolean {
  try {
    return window.localStorage.getItem(androidInstallDismissedStorageKey) === "true";
  } catch {
    return false;
  }
}

/** Persist the "Not Now" dismissal so the card is not shown again. */
export function persistAndroidInstallDismissed(): void {
  try {
    window.localStorage.setItem(androidInstallDismissedStorageKey, "true");
  } catch {
    // Storage blocked: the card simply reappears next visit; no functional harm.
  }
}
