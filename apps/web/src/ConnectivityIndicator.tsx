import { useSyncExternalStore } from "react";
import {
  getConnectivitySnapshot,
  subscribeConnectivity,
  type ConnectivityState
} from "./connectivity";

export function ConnectivityIndicator() {
  const state = useSyncExternalStore(
    subscribeConnectivity,
    getConnectivitySnapshot,
    () => "unknown" as const
  );
  const description = connectivityDescription(state);

  return (
    <div
      className={`connectivity-indicator ${state}`}
      role="status"
      aria-live="polite"
      title={description}
      data-connectivity={state}
    >
      <span aria-hidden="true" />
      <span className="visually-hidden">{description}</span>
    </div>
  );
}

function connectivityDescription(state: ConnectivityState): string {
  switch (state) {
    case "browser_offline":
      return "Offline. Local data remains available.";
    case "api_unreachable":
      return "Internet is available, but Grogoni synchronization is unavailable.";
    case "session_expired":
      return "Your session expired. Local data remains visible until you sign in.";
    case "degraded":
      return "Grogoni synchronization is degraded and will retry in the background.";
    case "authenticated":
      return "Connected and authenticated.";
    case "api_reachable":
      return "Grogoni synchronization is reachable.";
    default:
      return "Checking synchronization in the background.";
  }
}
