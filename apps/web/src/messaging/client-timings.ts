/**
 * Sends the web app's send and reply timings (message.send.accepted_ms, message.send.ack_ms,
 * agent.turn.reply_ms) to POST /v1/client-timings, where the Edge API logs each as one
 * `client_timing` line (supabase/functions/api/client-timings.ts). They are performance
 * measures already; this only carries them off the device, so the instant-messaging targets are
 * measured on real phones and networks. A duration, the random clientMessageId and the network
 * class only: never message text. Production builds only.
 */

export const reportedTimingNames = new Set([
  "message.send.accepted_ms",
  "message.send.ack_ms",
  "agent.turn.reply_ms"
]);
/** A beacon goes when this many are waiting, or when the page is hidden. */
export const clientTimingsBatchSize = 20;
const maxWaiting = 30;

export interface ClientTiming {
  name: string;
  ms: number;
  clientMessageId?: string;
  network?: string;
}

interface TimingEnvironment {
  observe: (onEntry: (entry: { name: string; duration: number; detail?: unknown }) => void) => void;
  network: () => string | undefined;
  send: (body: string) => boolean;
  onHidden: (flush: () => void) => void;
}

/** Starts collecting and sending timings; returns flush (tests, and an explicit send). */
export function startClientTimings(environment: TimingEnvironment): () => void {
  let waiting: ClientTiming[] = [];
  const flush = () => {
    if (waiting.length === 0) return;
    const batch = waiting;
    waiting = [];
    // Dropped when the browser refuses the beacon: timings are never worth a retry queue.
    environment.send(JSON.stringify({ timings: batch }));
  };
  environment.observe((entry) => {
    if (!reportedTimingNames.has(entry.name)) return;
    const id = (entry.detail as { clientMessageId?: unknown } | null | undefined)?.clientMessageId;
    const network = environment.network();
    waiting.push({
      name: entry.name,
      ms: Math.round(entry.duration),
      ...(typeof id === "string" ? { clientMessageId: id } : {}),
      ...(network ? { network } : {})
    });
    if (waiting.length > maxWaiting) waiting = waiting.slice(-maxWaiting);
    if (waiting.length >= clientTimingsBatchSize) flush();
  });
  environment.onHidden(flush);
  return flush;
}

/** The browser's PerformanceObserver, network class and sendBeacon, or null where missing. */
export function browserTimingEnvironment(endpoint: string): TimingEnvironment | null {
  if (
    typeof PerformanceObserver === "undefined" ||
    typeof navigator === "undefined" ||
    typeof navigator.sendBeacon !== "function"
  )
    return null;
  return {
    observe: (onEntry) => {
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            onEntry(entry as PerformanceEntry & { detail?: unknown });
        }).observe({ type: "measure" });
      } catch {
        // No measure observation in this browser: nothing is reported.
      }
    },
    network: () =>
      (navigator as Navigator & { connection?: { effectiveType?: string } }).connection
        ?.effectiveType,
    // text/plain keeps the beacon a simple request (no CORS preflight).
    send: (body) => navigator.sendBeacon(endpoint, new Blob([body], { type: "text/plain" })),
    onHidden: (flush) => {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
      });
      window.addEventListener("pagehide", flush);
    }
  };
}
