import { useEffect } from "react";
import type { SessionContextRetry } from "../session-context-retry";

/**
 * The account's session context (its shops, last mode and surface) applies once per sign-in
 * (session-context-retry.ts). A load that failed (offline, server down) used to stay failed until a
 * reload, keeping a stale stored shop, which for a device session also hid Log in
 * (showsSignInEntry). It retries when the device comes back online or the app is shown again, and
 * never re-runs once any load in this sign-in has applied. A retry only refreshes data (it never
 * moves the user: they may have navigated since).
 */
export function useSessionContextLoading(input: {
  accountId: string | null;
  retry: SessionContextRetry;
  /** The retry decides restore (first load of the sign-in) versus refresh (data-only retry). */
  load: (shouldApply: () => boolean, apply: "restore" | "refresh") => Promise<boolean>;
  clear: () => void;
}): void {
  const { accountId, retry } = input;
  useEffect(() => {
    if (accountId === null) {
      retry.track(null);
      input.clear();
      return;
    }
    retry.track(accountId, input.load);
    function retryWhenVisible() {
      if (document.visibilityState === "visible") retry.retry();
    }
    window.addEventListener("online", retry.retry);
    document.addEventListener("visibilitychange", retryWhenVisible);
    return () => {
      window.removeEventListener("online", retry.retry);
      document.removeEventListener("visibilitychange", retryWhenVisible);
    };
    // Re-registered only when the signed-in account changes, as before the extraction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);
}
