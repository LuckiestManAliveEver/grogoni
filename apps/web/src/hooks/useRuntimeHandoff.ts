import {
  isLocalRuntimeHost,
  type EffectiveRuntimeSummary,
  type RuntimeCapabilities
} from "@grogoni/shared-types";
import { useEffect, useState } from "react";
import type { LocalState } from "@grogoni/offline-runtime";
import { currentOfflineScope, getOfflineState, offlineModeEvent } from "../offline-runtime";
import { apiCloudFetch, isRetryableApiRequestError, readStableDeviceId } from "../lib/api";
import {
  localRuntimeMessages,
  runtimeHandoffController,
  runtimeTransition,
  withRuntimeTransition
} from "../runtime-handoff";
import type { ChatMessage } from "../app-shell";

export function useRuntimeHandoff(
  accountId: string,
  businessId: string,
  conversationId: string | null,
  runtimeRevision: string
) {
  const [state, setState] = useState<LocalState | null>(null);
  const [availability, setAvailability] = useState({
    available: false,
    reason: "Checking local runtime availability…"
  });
  const [canonicalStatus, setCanonicalStatus] = useState("Checking runtime…");
  const [error, setError] = useState("");
  const [transition, setTransition] = useState<"offline" | "online" | null>(null);
  const [connected, setConnected] = useState(navigator.onLine);
  useEffect(() => {
    setAvailability({ available: false, reason: "Checking local runtime availability…" });
    setCanonicalStatus(conversationId ? "Checking runtime…" : "Runtime unavailable");
    let revision = 0;
    let disposed = false;
    const scope = { accountId, storeId: businessId, deviceId: readStableDeviceId() };
    const maxRuntimeCheckRetries = 3;
    const runtimeCheckRetryBaseDelayMs = 1_000;
    const runtimeCheckRetryMaxDelayMs = 8_000;
    const isStale = (current: number) => disposed || current !== revision;
    const checkRuntime = async (current: number) => {
      const next = await getOfflineState(scope);
      if (isStale(current)) return undefined;
      setState(next);
      if (next.runtimeHandoffSession && next.runtimeHandoffSession.status !== "hosted")
        return undefined;
      let caps: RuntimeCapabilities | undefined;
      if (navigator.onLine && conversationId) {
        const fetched = await (
          await runtimeHandoffController()
        ).capabilities(scope, conversationId);
        if (isStale(current)) return undefined;
        caps = fetched;
        setCanonicalStatus(
          fetched.activeTransfer
            ? fetched.local.some(
                (host) => host.executionHostId === fetched.activeTransfer?.targetHostId
              )
              ? "Switching to local…"
              : "Switching to hosted…"
            : fetched.local.some((host) => host.active)
              ? "Local"
              : fetched.hosted.some((host) => host.active)
                ? "Hosted"
                : "Runtime unavailable"
        );
      }
      if (navigator.onLine && !conversationId) {
        const runtime = await apiCloudFetch<EffectiveRuntimeSummary>(
          `/businesses/${encodeURIComponent(businessId)}/runtime/effective`
        );
        if (isStale(current)) return undefined;
        setCanonicalStatus(
          runtime.ready
            ? isLocalRuntimeHost(runtime.execution.type)
              ? "Local"
              : "Hosted"
            : "Runtime unavailable"
        );
      }
      return !navigator.locks
        ? {
            available: false,
            reason: "This browser cannot safely coordinate runtime handoffs."
          }
        : !navigator.onLine
          ? {
              available: false,
              reason: "Reconnect to prepare this conversation for local execution."
            }
          : await (await runtimeHandoffController()).availability(scope, conversationId, caps);
    };
    const refresh = async () => {
      const current = ++revision;
      setConnected(navigator.onLine);
      setTransition(runtimeTransition(scope));
      let delayMs = runtimeCheckRetryBaseDelayMs;
      for (let attempt = 0; attempt <= maxRuntimeCheckRetries; attempt++) {
        try {
          const result = await checkRuntime(current);
          if (!isStale(current) && result !== undefined) setAvailability(result);
          return;
        } catch (cause) {
          if (isStale(current)) return;
          const retriesLeft = maxRuntimeCheckRetries - attempt;
          if (retriesLeft <= 0 || !isRetryableApiRequestError(cause)) {
            setCanonicalStatus("Runtime unavailable");
            setAvailability({
              available: false,
              reason: cause instanceof Error ? cause.message : "Local runtime is unavailable."
            });
            return;
          }
          setCanonicalStatus(`Runtime unavailable — retrying in ${Math.round(delayMs / 1000)}s…`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (isStale(current)) return;
          delayMs = Math.min(delayMs * 2, runtimeCheckRetryMaxDelayMs);
        }
      }
    };
    const listener = () => {
      void refresh();
    };
    listener();
    for (const name of [offlineModeEvent, "online", "offline", "storage"])
      window.addEventListener(name, listener);
    return () => {
      disposed = true;
      for (const name of [offlineModeEvent, "online", "offline", "storage"])
        window.removeEventListener(name, listener);
    };
  }, [accountId, businessId, conversationId, runtimeRevision]);

  const activeScope = currentOfflineScope();
  const offline = activeScope?.accountId === accountId && activeScope.storeId === businessId;
  const scopeLoaded = state?.accountId === accountId && state.storeId === businessId;
  const session = scopeLoaded ? state.runtimeHandoffSession : undefined;
  const needsReturn = !!session && session.status !== "hosted";
  const legacyOffline = offline && !needsReturn;
  const label =
    transition === "offline"
      ? "Switching to local…"
      : transition === "online"
        ? "Switching to hosted…"
        : needsReturn || offline
          ? "Go hosted"
          : "Go offline";
  const status =
    transition === "offline"
      ? "Switching to local…"
      : transition === "online"
        ? "Switching to hosted…"
        : offline
          ? legacyOffline
            ? "Offline · Business data only"
            : "Local"
          : needsReturn
            ? "Handoff needs recovery"
            : canonicalStatus;

  async function toggle(messages: ChatMessage[]) {
    const scope = { accountId, storeId: businessId, deviceId: readStableDeviceId() };
    setError("");
    try {
      await withRuntimeTransition(
        scope,
        needsReturn || offline ? "online" : "offline",
        async () => {
          const controller = await runtimeHandoffController();
          if (needsReturn || offline) await controller.goOnline(scope);
          else if (conversationId)
            await controller.goOffline(scope, conversationId, localRuntimeMessages(messages));
        }
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The handoff failed. Your conversation is saved."
      );
    }
  }
  return {
    label,
    status,
    error,
    offline,
    busy: transition !== null,
    disabled:
      !scopeLoaded ||
      transition !== null ||
      (needsReturn ? !connected : legacyOffline || !availability.available),
    reason: legacyOffline
      ? "Sync this business-data session in offline settings before moving the agent runtime."
      : needsReturn
        ? "Sync changes and resume the same conversation online."
        : availability.reason,
    refresh: () => window.dispatchEvent(new Event(offlineModeEvent)),
    recover: async () => {
      const scope = { accountId, storeId: businessId, deviceId: readStableDeviceId() };
      try {
        await withRuntimeTransition(scope, "offline", async () =>
          (await runtimeHandoffController()).recover(scope)
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Handoff recovery failed.");
      }
    },
    needsRecovery: session?.status === "prepared" && !!session.transferKey,
    toggle
  };
}
