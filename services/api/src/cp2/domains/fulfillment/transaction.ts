/**
 * The single transaction shell for Postgres-authoritative fulfillment operations
 * (docs/architecture/corridor-fulfillment.md §6 "Common rules").
 *
 * - One checked-out `PoolClient` for the whole BEGIN..COMMIT, so every row lock and the
 *   idempotency insert stay on one server connection (safe behind Neon's transaction-mode pooler).
 *   `pool.query` is never used inside a transaction.
 * - `SET LOCAL lock_timeout` so a stuck lock fails fast into the bounded retry instead of pinning
 *   a pooled connection until statement_timeout.
 * - Bounded retry only for failures that are safe to repeat: serialization failure (40001),
 *   deadlock (40P01), lock timeout (55P03) and an explicit lock-then-recheck mismatch. Domain
 *   errors (Cp2Error) are never retried.
 * - Session-level advisory locks are never taken (they would leak across pooled connections).
 *   Only transaction-scoped `pg_advisory_xact_lock` is allowed, and only where no stable row can
 *   be locked - see `lockShopLocation` in service.ts for the one current use and its justification.
 */
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { positiveIntegerFromEnv } from "@grogoni/resource-control";
import { Cp2Error } from "../../cp2-error.js";

const retryableSqlStates = new Set(["40001", "40P01", "55P03"]);

/** Thrown by an operation whose post-lock re-read no longer matches its pre-lock read (A17). */
export class FulfillmentRecheckConflict extends Error {
  constructor(message = "Fulfillment state changed while acquiring locks.") {
    super(message);
    this.name = "FulfillmentRecheckConflict";
  }
}

export interface FulfillmentTransactionOptions {
  /** Maximum attempts including the first. Defaults to FULFILLMENT_TRANSACTION_MAX_ATTEMPTS or 3. */
  maxAttempts?: number;
  /** Defaults to FULFILLMENT_LOCK_TIMEOUT_MS or 5000. */
  lockTimeoutMs?: number;
  /** Test/observability hook, called before each retry with the failure that caused it. */
  onRetry?: (attempt: number, error: unknown) => void;
}

export function isRetryableFulfillmentError(error: unknown): boolean {
  if (error instanceof FulfillmentRecheckConflict) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && retryableSqlStates.has(code);
}

export async function withFulfillmentTransaction<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
  options: FulfillmentTransactionOptions = {}
): Promise<T> {
  const maxAttempts =
    options.maxAttempts ?? positiveIntegerFromEnv("FULFILLMENT_TRANSACTION_MAX_ATTEMPTS", 3);
  const lockTimeoutMs =
    options.lockTimeoutMs ?? positiveIntegerFromEnv("FULFILLMENT_LOCK_TIMEOUT_MS", 5000);

  for (let attempt = 1; ; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      // SET LOCAL does not accept bind parameters; the value is an integer we produced ourselves.
      await client.query(`set local lock_timeout = ${Math.trunc(lockTimeoutMs)}`);
      const result = await run(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if (error instanceof Cp2Error || !isRetryableFulfillmentError(error)) throw error;
      if (attempt >= maxAttempts) {
        throw new Cp2Error(
          409,
          "fulfillment_contention",
          "The fulfillment change conflicted with a concurrent change. Try again.",
          true
        );
      }
      options.onRetry?.(attempt, error);
    } finally {
      client.release();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Idempotency (A23)
// ---------------------------------------------------------------------------------------------

/** Deterministic request fingerprint: sha256 over canonical (key-sorted) JSON. */
export function fulfillmentRequestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

export function normalizeIdempotencyKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const key = value.trim();
  if (key === "") return null;
  if (key.length > 200) {
    throw new Cp2Error(
      400,
      "idempotency_key_invalid",
      "Idempotency-Key must be 200 characters or fewer."
    );
  }
  return key;
}

/**
 * Runs `mutate` at most once per (businessId, operation, key) inside the caller's transaction.
 *
 * The record is inserted first. Its primary key makes a concurrent twin block on the index until
 * this transaction ends; if this one commits, the twin's insert conflicts and it returns the
 * stored response; if this one rolls back, the twin's insert succeeds and it performs the
 * mutation itself. Same key with a different request hash is a 409 - never a second mutation.
 */
export async function runIdempotent<T>(
  client: PoolClient,
  input: {
    businessId: string;
    operation: string;
    key: string | null;
    requestHash: string;
    now: Date;
  },
  mutate: () => Promise<T>
): Promise<T> {
  if (input.key === null) return mutate();
  const inserted = await client.query(
    `
      insert into fulfillment_idempotency_records
        (business_id, operation, idempotency_key, request_hash, response_snapshot, created_at)
      values ($1, $2, $3, $4, null, $5)
      on conflict (business_id, operation, idempotency_key) do nothing
      returning 1
    `,
    [input.businessId, input.operation, input.key, input.requestHash, input.now]
  );
  if (inserted.rowCount === 0) {
    const existing = await client.query<{ request_hash: string; response_snapshot: unknown }>(
      `
        select request_hash, response_snapshot
        from fulfillment_idempotency_records
        where business_id = $1 and operation = $2 and idempotency_key = $3
      `,
      [input.businessId, input.operation, input.key]
    );
    const row = existing.rows[0];
    if (row === undefined) {
      // Only possible if the record was purged between the conflict and this read.
      throw new FulfillmentRecheckConflict("Idempotency record disappeared during lookup.");
    }
    if (row.request_hash !== input.requestHash) {
      throw new Cp2Error(
        409,
        "idempotency_key_reused",
        "This Idempotency-Key was already used for a different request."
      );
    }
    return row.response_snapshot as T;
  }
  const result = await mutate();
  await client.query(
    `
      update fulfillment_idempotency_records
      set response_snapshot = $4::jsonb
      where business_id = $1 and operation = $2 and idempotency_key = $3
    `,
    [input.businessId, input.operation, input.key, JSON.stringify(result)]
  );
  return result;
}
