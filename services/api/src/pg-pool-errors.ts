import type { Pool } from "pg";

/** Checked-out clients can be idle between transaction statements when their socket fails. */
export function guardPgPoolErrors(pool: Pool, onError: (error: Error) => void): void {
  pool.on("error", onError);
  pool.on("connect", (client) => {
    // pg still marks the client unusable; the owning operation must fail, never replay.
    client.on("error", onError);
  });
}
