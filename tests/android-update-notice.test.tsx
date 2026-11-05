// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AndroidUpdateNotice } from "../apps/web/src/AndroidUpdateNotice";
import { loadAndroidRelease } from "../apps/web/src/android-release";
import { isNativeDeviceHost } from "../apps/web/src/device-messaging";

vi.mock("../apps/web/src/android-release", () => ({ loadAndroidRelease: vi.fn() }));
vi.mock("../apps/web/src/device-messaging", () => ({ isNativeDeviceHost: vi.fn(() => false) }));

const release = {
  packageName: "market.grogoni.app",
  versionName: "0.1.0",
  versionCode: 3,
  downloadUrl: "https://grogoni.com/android/grogoni-0.1.0-3.apk",
  sha256:
    "57:9A:C1:87:C0:A0:FC:2E:E3:F7:83:59:E3:C4:12:5C:5C:AD:6D:9D:ED:ED:2C:89:C1:AD:83:16:4B:8E:40:E7",
  minSdk: 23
};
let root: Root;
let host: HTMLDivElement;
async function render() {
  await act(async () => root.render(<AndroidUpdateNotice />));
}
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.mocked(isNativeDeviceHost).mockReturnValue(false);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Linux; Android 14)");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.mocked(loadAndroidRelease).mockResolvedValue({
    available: true,
    manifestUrl: "/android/release.json",
    release
  });
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
describe("Android browser update notice", () => {
  it("offers the update even after an earlier install prompt was dismissed", async () => {
    localStorage.setItem("grogoni.android-install-prompt-dismissed.v1", "true");
    await render();
    expect(host.textContent).toContain("Already have Grogoni for Android?");
    expect(host.querySelector("a")?.href).toBe(release.downloadUrl);
    expect(host.textContent).toContain("build 3");
  });
  it("remembers dismissal for this release but shows the next release", async () => {
    await render();
    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent).toBe("");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.textContent).toBe("");
    vi.mocked(loadAndroidRelease).mockResolvedValue({
      available: true,
      manifestUrl: "/android/release.json",
      release: { ...release, versionCode: 4 }
    });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.textContent).toContain("build 4");
  });
  it("does not offer Android downloads on desktop or in the native app", async () => {
    vi.mocked(isNativeDeviceHost).mockReturnValue(true);
    await render();
    expect(loadAndroidRelease).not.toHaveBeenCalled();
    expect(host.textContent).toBe("");
    act(() => root.unmount());
    root = createRoot(host);
    vi.mocked(isNativeDeviceHost).mockReturnValue(false);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Desktop Chrome");
    await render();
    expect(loadAndroidRelease).not.toHaveBeenCalled();
  });
  it("hides the prompt when there is no verified release", async () => {
    vi.mocked(loadAndroidRelease).mockResolvedValue({
      available: false,
      reason: "not-published",
      manifestUrl: "/android/release.json"
    });
    await render();
    expect(host.querySelector("a")).toBeNull();
  });
});
