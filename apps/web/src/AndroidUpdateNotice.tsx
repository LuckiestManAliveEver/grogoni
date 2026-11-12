import { useEffect, useState } from "react";
import { loadAndroidRelease, type AndroidRelease } from "./android-release";
import { isNativeDeviceHost } from "./device-messaging";
import "./android-update-notice.css";

const dismissalKey = "grogoni.android-update-dismissed-version.v1";

function dismissed(version: number): boolean {
  try {
    return window.localStorage.getItem(dismissalKey) === String(version);
  } catch {
    return false;
  }
}

export function AndroidUpdateNotice() {
  const [release, setRelease] = useState<AndroidRelease | null>(null);

  useEffect(() => {
    if (!/Android/i.test(navigator.userAgent) || isNativeDeviceHost()) return;
    let active = true;
    let pending = false;
    async function check() {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const status = await loadAndroidRelease();
        if (active)
          setRelease(
            status.available && !dismissed(status.release.versionCode) ? status.release : null
          );
      } finally {
        pending = false;
      }
    }
    void check();
    const recheck = () => void check();
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    const interval = window.setInterval(recheck, 15 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, []);

  if (release === null) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(dismissalKey, String(release!.versionCode));
    } catch {
      // The prompt can still be dismissed for this visit when storage is unavailable.
    }
    setRelease(null);
  }

  return (
    <aside className="android-update-notice" aria-labelledby="android-update-heading">
      <div>
        <strong id="android-update-heading">Already have Grogoni for Android?</strong>
        <p>
          Get the latest Android update (version {release.versionName}, build {release.versionCode}
          ). Install it over your existing app to keep your account and data.
        </p>
      </div>
      <div className="android-update-actions">
        <a className="install-primary-action" href={release.downloadUrl}>
          Download Android update
        </a>
        <button type="button" className="secondary" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </aside>
  );
}
