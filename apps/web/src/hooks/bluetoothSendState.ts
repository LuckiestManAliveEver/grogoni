import { useCallback, useEffect, useMemo, useState } from "react";

import type { Scope } from "@grogoni/offline-runtime";

import { getErrorMessage } from "../chat-message-plumbing";
import {
  peerMessagingEnabled,
  peerMessagingSupported,
  nearbyConnectionStatus,
  onNearbyStatusChange,
  connectNearbyDevice,
  sendNearbyMessage,
  type NearbyConnectionStatus
} from "../peer-messaging";

/** The composer's "Send via Bluetooth" leg (pairing + sending over the peer-messaging channel),
 *  split out of useChatComposerState.ts to keep that hook under its modularity budget. */
export function useBluetoothSendState(nearbyScope: Scope | null) {
  const [selected, setSelected] = useState(false);
  const [status, setStatus] = useState<NearbyConnectionStatus>(nearbyConnectionStatus());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = nearbyScope !== null && peerMessagingEnabled && peerMessagingSupported();

  useEffect(() => onNearbyStatusChange(setStatus), []);

  // useCallback keeps these referentially stable across renders (deps permitting) so a caller
  // that closes over them, like useChatComposerState's setSelectedProvider, stays stable too -
  // otherwise every render would look like a "new" dependency to that caller's own effects.
  const reset = useCallback(() => {
    setSelected(false);
    setError(null);
  }, []);

  const select = useCallback(() => {
    if (nearbyScope === null || !available) return;
    setSelected(true);
    setError(null);
    if (status === "connected") return;
    setBusy(true);
    void connectNearbyDevice(nearbyScope)
      .catch((caught: unknown) => setError(getErrorMessage(caught)))
      .finally(() => setBusy(false));
  }, [available, nearbyScope, status]);

  const send = useCallback(
    (text: string, onSent: () => void) => {
      if (nearbyScope === null) return;
      setBusy(true);
      setError(null);
      void sendNearbyMessage(nearbyScope, text)
        .then(onSent)
        .catch((caught: unknown) => setError(getErrorMessage(caught)))
        .finally(() => setBusy(false));
    },
    [nearbyScope]
  );

  // Memoized so a caller depending on the whole returned object (useChatComposerState's
  // setSelectedProvider) doesn't see a "new" value, and re-run its own effects, every render.
  return useMemo(
    () => ({ available, busy, error, reset, select, selected, send, status }),
    [available, busy, error, reset, select, selected, send, status]
  );
}
