import { useEffect } from "react";
import { daemonTaskUpdatedEvent } from "../daemon-chat";
import { apiCloudFetch } from "../lib/api";
import { isExplicitOfflineMode } from "../offline-runtime";
import { idleLoadedDeviceModel } from "../device-models";
import { startBrowserDaemonLane, type DaemonDeviceRunner } from "../daemon-lane";

/** Dispatch on window to make the lane look for due work now (after creating a task). */
export const daemonLaneWakeEvent = "grogoni:daemon-lane-wake";

/** Off only when the build sets VITE_DAEMON_BROWSER_LANE=false. */
export const daemonBrowserLaneEnabled = import.meta.env.VITE_DAEMON_BROWSER_LANE !== "false";

const deviceSystemPrompt =
  "You are Grogoni's background assistant for a small shop. Reply in plain text, briefly.";

/**
 * The on-device model to run a background task on, if any. Only one already loaded and idle when
 * the task starts: the lane never loads a model in the background (memory, data) and never swaps
 * out the one a person's chat uses (runLoadedDeviceGeneration refuses anything else). A chat turn
 * started while a background generation runs waits for it, as two turns on one model do.
 * Otherwise the server runs the claim. The engine module (and WebLLM) is imported only when a task
 * actually runs on the device.
 */
function deviceRunner(): DaemonDeviceRunner | null {
  const modelId = idleLoadedDeviceModel();
  if (modelId === null) return null;
  return {
    modelId,
    async generate(message, signal) {
      const { runLoadedDeviceGeneration } = await import("../device-model-engine");
      const result = await runLoadedDeviceGeneration(
        {
          providerModelId: modelId,
          messages: [
            { role: "system", content: deviceSystemPrompt },
            { role: "user", content: message }
          ],
          generation: { maxOutputTokens: 1024, temperature: 0.3, jsonOutput: false }
        },
        () => undefined,
        signal
      );
      return result.text;
    }
  };
}

/**
 * Runs the signed-in user's due background tasks while the app is open and visible
 * (docs/deployment/daemon-lanes.md). One tab at a time works the lane; the others stand by.
 * `accountId` is null for signed-out and device-only identities: only an explicit sign-in runs it.
 */
export function useDaemonLane(accountId: string | null): void {
  useEffect(() => {
    if (accountId === null || !daemonBrowserLaneEnabled) return;
    const stop = startBrowserDaemonLane({
      request: (path, init) => apiCloudFetch(path, init),
      device: deviceRunner,
      report: (event) => {
        if (event.type === "server_completed" || event.type === "device_completed")
          window.dispatchEvent(new Event(daemonTaskUpdatedEvent));
      },
      isActive: () =>
        document.visibilityState === "visible" && navigator.onLine && !isExplicitOfflineMode(),
      exclusive: async (action) =>
        navigator.locks
          ? navigator.locks.request("grogoni-daemon-lane", { ifAvailable: true }, (lock) =>
              lock === null ? null : action()
            )
          : // Without Web Locks, tabs work in parallel; claims never hand one task to two tabs.
            action(),
      onWake: (listener) => {
        const onVisible = () => {
          if (document.visibilityState === "visible") listener();
        };
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("online", listener);
        window.addEventListener(daemonLaneWakeEvent, listener);
        return () => {
          document.removeEventListener("visibilitychange", onVisible);
          window.removeEventListener("online", listener);
          window.removeEventListener(daemonLaneWakeEvent, listener);
        };
      }
    });
    activeLaneStop = stop;
    return () => {
      if (activeLaneStop === stop) activeLaneStop = null;
      void stop();
    };
  }, [accountId]);
}

let activeLaneStop: (() => Promise<void>) | null = null;
/** Longest sign-out waits for the lane; a server run in flight is left to its lease. */
const signOutWaitMs = 3_000;

/**
 * Stops this tab's lane and releases the task it holds while the session is still valid. Call it
 * before logging out or switching account: afterwards the release would no longer be authorized,
 * and the task would wait for its lease to lapse. Never waits more than three seconds.
 */
export async function stopDaemonLane(): Promise<void> {
  const stop = activeLaneStop;
  activeLaneStop = null;
  if (stop === null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    stop(),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, signOutWaitMs)))
  ]);
  clearTimeout(timer);
}
