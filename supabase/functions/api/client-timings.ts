/**
 * POST /v1/client-timings: the web app's send and reply timings, one `client_timing` log line
 * each, so the instant-messaging targets (tap to bubble, tap to server ack, tap to agent reply)
 * are measured on real phones and networks, not only in the lab. Matched to the server's own
 * `message_accepted` line (services/api/src/edge-request-timing.ts) by clientMessageId.
 *
 * Nothing is stored and no database is touched, so a beacon never costs a transaction. What a
 * line may hold is fixed here: a known measure name, a duration, a random message id and the
 * browser's coarse network class. Never message text, an account or an IP address. The rate
 * limiter runs inside database transactions, so this route caps its own log lines per isolate.
 */

export const clientTimingNames = [
  "message.send.accepted_ms",
  "message.send.ack_ms",
  "agent.turn.reply_ms"
] as const;
export type ClientTimingName = (typeof clientTimingNames)[number];

const networkClasses = ["slow-2g", "2g", "3g", "4g"] as const;
export const clientTimingsPath = "/v1/client-timings";
/** Most entries one beacon may carry, and the largest body read. */
export const clientTimingsMaxEntries = 30;
export const clientTimingsMaxBytes = 8_192;
/** Longest duration kept: past this a measure is a stuck tab, not a latency. */
export const clientTimingMaxMs = 10 * 60_000;

export interface ClientTimingLine {
  event: "client_timing";
  name: ClientTimingName;
  ms: number;
  clientMessageId: string | null;
  network: (typeof networkClasses)[number] | null;
}

const messageId = /^[A-Za-z0-9._:-]{1,120}$/u;

/** The log lines a beacon body yields; anything malformed is dropped, never echoed. */
export function parseClientTimings(body: unknown): ClientTimingLine[] {
  const entries = (body as { timings?: unknown } | null)?.timings;
  if (!Array.isArray(entries)) return [];
  const lines: ClientTimingLine[] = [];
  for (const entry of entries.slice(0, clientTimingsMaxEntries)) {
    if (entry === null || typeof entry !== "object") continue;
    const { name, ms, clientMessageId, network } = entry as Record<string, unknown>;
    if (!(clientTimingNames as readonly unknown[]).includes(name)) continue;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > clientTimingMaxMs)
      continue;
    lines.push({
      event: "client_timing",
      name: name as ClientTimingName,
      ms: Math.round(ms),
      clientMessageId:
        typeof clientMessageId === "string" && messageId.test(clientMessageId)
          ? clientMessageId
          : null,
      network: (networkClasses as readonly unknown[]).includes(network)
        ? (network as (typeof networkClasses)[number])
        : null
    });
  }
  return lines;
}

export function createClientTimingsRoute(
  options: {
    log?: (line: string) => void;
    now?: () => number;
    /** Log lines per isolate per minute; beyond it beacons are accepted and dropped. */
    perMinute?: number;
  } = {}
) {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? Date.now;
  const perMinute = options.perMinute ?? 1_200;
  let windowStartedAt = now();
  let logged = 0;
  return async (request: Request, path: string): Promise<Response | null> => {
    if (path !== clientTimingsPath || request.method !== "POST") return null;
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > clientTimingsMaxBytes) return new Response(null, { status: 413 });
    const text = await request.text();
    if (text.length > clientTimingsMaxBytes) return new Response(null, { status: 413 });
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (now() - windowStartedAt >= 60_000) {
      windowStartedAt = now();
      logged = 0;
    }
    for (const line of parseClientTimings(body)) {
      if (logged >= perMinute) break;
      logged += 1;
      log(JSON.stringify(line));
    }
    // Same answer whether lines were logged or dropped: a sender learns nothing from it.
    return new Response(null, { status: 204 });
  };
}
