import type { Transaction } from "./session-routes.ts";

/** Bounded SSE connection. Every probe uses a short transaction; no connection or tenant lock
 * is held while waiting. The durable account journal bridges isolates and reconnects.
 *
 * Load: the journal is read every `intervalMs` (500 ms, the inbound-visibility budget), but the
 * session is rechecked only every `reauthorizeEveryMs` (5 s). Rechecking on every probe doubled
 * the transactions per open stream; an expired or revoked session still stops receiving hints
 * within 5 s, and hints carry conversation identifiers only, never message content. */
export async function messageEventStream(
  request: Request,
  transaction: Transaction,
  authorize: () => Promise<string>,
  options: { durationMs?: number; intervalMs?: number; reauthorizeEveryMs?: number } = {}
): Promise<Response> {
  const accountId = await authorize();
  const reauthorizeEveryMs = options.reauthorizeEveryMs ?? 5_000;
  let authorizedAt = Date.now();
  const raw =
    request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("since");
  if (raw !== null && !/^\d{1,20}$/u.test(raw))
    return Response.json({ code: "cursor_invalid" }, { status: 400 });
  let cursor =
    raw ??
    String(
      (
        await transaction((db) =>
          db.query(
            "select coalesce(max(sequence), 0)::text as cursor from account_sync_changes where account_id = $1",
            [accountId]
          )
        )
      ).rows[0]?.cursor ?? "0"
    );
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    wake?.();
  };
  request.signal.addEventListener("abort", stop, { once: true });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, data: unknown) =>
        controller.enqueue(
          encoder.encode(`id: ${cursor}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      emit("ready", { accountId });
      void (async () => {
        const until = Date.now() + (options.durationMs ?? 25_000);
        try {
          while (!stopped && Date.now() < until) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              timer = setTimeout(resolve, options.intervalMs ?? 500);
            });
            wake = undefined;
            if (stopped) break;
            if (Date.now() - authorizedAt >= reauthorizeEveryMs) {
              if ((await authorize()) !== accountId) break;
              authorizedAt = Date.now();
            }
            const result = await transaction((db) =>
              db.query(
                `select sequence::text, collection, entity_id, entity->>'conversationId' as conversation_id from account_sync_changes where account_id = $1 and sequence > $2::bigint order by sequence limit 100`,
                [accountId, cursor]
              )
            );
            if (stopped) break;
            if (result.rows.length) {
              cursor = String(result.rows.at(-1)!.sequence);
              const ids = [
                ...new Set(
                  result.rows.flatMap((row) =>
                    row.collection === "conversations"
                      ? [String(row.entity_id)]
                      : row.collection === "conversation_messages" &&
                          typeof row.conversation_id === "string"
                        ? [row.conversation_id]
                        : []
                  )
                )
              ];
              emit("changed", { accountId, conversationIds: ids });
            }
          }
        } catch {
          /* Expired authorization or database failure closes the stream; client falls back. */
        } finally {
          stop();
          request.signal.removeEventListener("abort", stop);
          try {
            controller.close();
          } catch {
            /* Reader cancelled. */
          }
        }
      })();
    },
    cancel() {
      stop();
      request.signal.removeEventListener("abort", stop);
    }
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no"
    }
  });
}
