import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AppRouter } from "./AppRouter";
import { ConnectivityIndicator } from "./ConnectivityIndicator";
import { AndroidUpdateNotice } from "./AndroidUpdateNotice";
import { runDeploymentRecoveryStartupChecks } from "./lazy-module-recovery";
import { PerformancePanel } from "./PerformancePanel";
import { recordReadiness, startPerformanceMonitoring } from "./performance";
import { registerAppServiceWorker } from "./service-worker";
import { browserTimingEnvironment, startClientTimings } from "./messaging/client-timings";
import { readApiBaseUrl } from "./lib/api";
import { captureJoinLink } from "./staff-join-link";
import "./styles.css";
import "./home-reference.css";
// Install the native channel listener before Android's page-load handshake, even when the
// carrier-message route itself is lazy loaded. This is the same bundle on every platform.
import "./device-messaging";

function App() {
  useEffect(() => {
    startPerformanceMonitoring();
    recordReadiness("app-shell");
    registerAppServiceWorker();
    runDeploymentRecoveryStartupChecks();
    // Send and reply timings off the device (production only; logged by the Edge API).
    const timings = import.meta.env.PROD
      ? browserTimingEnvironment(`${readApiBaseUrl()}/v1/client-timings`)
      : null;
    if (timings !== null) startClientTimings(timings);
  }, []);

  return (
    <>
      <AppRouter />
      <AndroidUpdateNotice />
      <ConnectivityIndicator />
      <PerformancePanel />
    </>
  );
}

// A staff invitation link (/?staffInvite=…&t=…) is remembered before any routing reads the URL,
// and its secret is removed from the address bar (staff-join-link.ts).
captureJoinLink(window.location, window.localStorage, window.history);

const root = document.getElementById("root");
if (root === null) throw new Error("Root element not found.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
