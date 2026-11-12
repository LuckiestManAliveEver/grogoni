import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";

/**
 * Cross-process ownership of one business's WhatsApp Linked Devices socket.
 *
 * The database row in `whatsapp_linked_leases` (migration 136) is the authority. Every expiry
 * decision on the database side uses the database clock (`now()`), so worker wall clocks never
 * decide who owns a lease. Locally, a worker treats its lease as valid only until
 *   (monotonic time when the acquire/renew request was SENT) + ttl - skew
 * which ends before the database can consider the row expired, provided the local monotonic
 * clock and the database clock disagree by less than `skewMs` over one TTL. Each takeover
 * increments `generation`; rows are never deleted, so a stale generation can never match again.
 * See docs/architecture/whatsapp-linked-devices.md, "Multi-worker leasing".
 */

/** The slice of `pg.Pool` / `pg.PoolClient` the lease store needs. */
export interface LinkedLeaseSql {
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Lease primitives. Every method is a single compare-and-set against holder + generation. */
export interface LinkedLeaseStore {
  /** Takes the lease when absent, expired, or already held by `holderId`; returns the new generation. */
  acquire(businessId: string, holderId: string, ttlMs: number): Promise<string | null>;
  /** Extends the lease only for the current holder and generation of an unexpired lease. */
  renew(businessId: string, holderId: string, generation: string, ttlMs: number): Promise<boolean>;
  /** Expires the lease now, only for the current holder and generation. */
  release(businessId: string, holderId: string, generation: string): Promise<boolean>;
  /** True only when holder + generation still own an unexpired lease. */
  verify(businessId: string, holderId: string, generation: string): Promise<boolean>;
}

const GENERATION = /^[1-9][0-9]{0,18}$/;
const MAX_ID = 200;

function checkIds(businessId: string, holderId: string, generation?: string): void {
  if (!businessId || businessId.length > MAX_ID) throw new Error("Invalid lease business id.");
  if (!holderId || holderId.length > MAX_ID) throw new Error("Invalid lease holder id.");
  if (generation !== undefined && !GENERATION.test(generation))
    throw new Error("Invalid lease generation.");
}
function checkTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 3_600_000)
    throw new Error("Invalid lease TTL.");
}

/** Postgres implementation. `sql` is a `pg.Pool`; each statement runs in its own transaction. */
export class PostgresLinkedLeaseStore implements LinkedLeaseStore {
  constructor(private readonly sql: LinkedLeaseSql) {}

  async acquire(businessId: string, holderId: string, ttlMs: number): Promise<string | null> {
    checkIds(businessId, holderId);
    checkTtl(ttlMs);
    // INSERT .. ON CONFLICT serializes concurrent acquirers on the primary key: the loser waits
    // for the winner's commit, then re-evaluates the WHERE against the winner's unexpired row.
    const result = await this.sql.query(
      `insert into whatsapp_linked_leases as lease
         (business_id, holder_id, generation, expires_at, heartbeat_at, acquired_at)
       values ($1, $2, 1, now() + $3::integer * interval '1 millisecond', now(), now())
       on conflict (business_id) do update
         set holder_id = excluded.holder_id,
             generation = lease.generation + 1,
             expires_at = excluded.expires_at,
             heartbeat_at = excluded.heartbeat_at,
             acquired_at = excluded.acquired_at
         where lease.expires_at <= now() or lease.holder_id = excluded.holder_id
       returning generation::text as generation`,
      [businessId, holderId, ttlMs]
    );
    const row = result.rows[0] as { generation?: unknown } | undefined;
    return typeof row?.generation === "string" ? row.generation : null;
  }

  async renew(
    businessId: string,
    holderId: string,
    generation: string,
    ttlMs: number
  ): Promise<boolean> {
    checkIds(businessId, holderId, generation);
    checkTtl(ttlMs);
    const result = await this.sql.query(
      `update whatsapp_linked_leases
          set expires_at = now() + $4::integer * interval '1 millisecond', heartbeat_at = now()
        where business_id = $1 and holder_id = $2 and generation = $3::bigint
          and expires_at > now()
        returning 1 as renewed`,
      [businessId, holderId, generation, ttlMs]
    );
    return result.rows.length === 1;
  }

  async release(businessId: string, holderId: string, generation: string): Promise<boolean> {
    checkIds(businessId, holderId, generation);
    const result = await this.sql.query(
      `update whatsapp_linked_leases set expires_at = now()
        where business_id = $1 and holder_id = $2 and generation = $3::bigint
          and expires_at > now()
        returning 1 as released`,
      [businessId, holderId, generation]
    );
    return result.rows.length === 1;
  }

  async verify(businessId: string, holderId: string, generation: string): Promise<boolean> {
    checkIds(businessId, holderId, generation);
    const result = await this.sql.query(
      `select 1 as held from whatsapp_linked_leases
        where business_id = $1 and holder_id = $2 and generation = $3::bigint
          and expires_at > now()`,
      [businessId, holderId, generation]
    );
    return result.rows.length === 1;
  }
}

/**
 * In-memory store with exactly the Postgres semantics, driven by an injectable "database clock".
 * Used by unit tests (the same conformance suite runs against Postgres) and by single-host tests
 * of several connectors sharing one store. It is not a production lease: it is per process.
 */
export class MemoryLinkedLeaseStore implements LinkedLeaseStore {
  private readonly rows = new Map<
    string,
    { holderId: string; generation: number; expiresAt: number; heartbeatAt: number }
  >();
  constructor(private readonly clock: () => number = Date.now) {}

  async acquire(businessId: string, holderId: string, ttlMs: number): Promise<string | null> {
    checkIds(businessId, holderId);
    checkTtl(ttlMs);
    const now = this.clock();
    const row = this.rows.get(businessId);
    if (row && row.expiresAt > now && row.holderId !== holderId) return null;
    const generation = (row?.generation ?? 0) + 1;
    this.rows.set(businessId, { holderId, generation, expiresAt: now + ttlMs, heartbeatAt: now });
    return String(generation);
  }
  async renew(
    businessId: string,
    holderId: string,
    generation: string,
    ttlMs: number
  ): Promise<boolean> {
    checkIds(businessId, holderId, generation);
    checkTtl(ttlMs);
    const now = this.clock();
    const row = this.current(businessId, holderId, generation, now);
    if (!row) return false;
    row.expiresAt = now + ttlMs;
    row.heartbeatAt = now;
    return true;
  }
  async release(businessId: string, holderId: string, generation: string): Promise<boolean> {
    checkIds(businessId, holderId, generation);
    const now = this.clock();
    const row = this.current(businessId, holderId, generation, now);
    if (!row) return false;
    row.expiresAt = now;
    return true;
  }
  async verify(businessId: string, holderId: string, generation: string): Promise<boolean> {
    checkIds(businessId, holderId, generation);
    return this.current(businessId, holderId, generation, this.clock()) !== undefined;
  }
  /** Test inspection only. */
  row(businessId: string) {
    const row = this.rows.get(businessId);
    return row ? { ...row, generation: String(row.generation) } : undefined;
  }
  private current(businessId: string, holderId: string, generation: string, now: number) {
    const row = this.rows.get(businessId);
    return row &&
      row.holderId === holderId &&
      String(row.generation) === generation &&
      row.expiresAt > now
      ? row
      : undefined;
  }
}

export interface LinkedLeaseSettings {
  /** Stable for the life of one process; never shared by two processes. */
  holderId: string;
  /** Database-side lease duration. */
  ttlMs: number;
  /** Renewal period. At least three renewals fit inside the local safe window. */
  heartbeatMs: number;
  /** Bound on local-monotonic vs database clock disagreement over one TTL (incl. pauses). */
  skewMs: number;
  /** How often a worker without the lease retries acquisition for a restorable session. */
  retryMs: number;
}

export const defaultLinkedLeaseSettings = {
  ttlMs: 30_000,
  heartbeatMs: 8_000,
  skewMs: 5_000,
  retryMs: 10_000
} as const;

export function validateLinkedLeaseSettings(settings: LinkedLeaseSettings): LinkedLeaseSettings {
  const { holderId, ttlMs, heartbeatMs, skewMs, retryMs } = settings;
  if (!/^[A-Za-z0-9._:@-]{1,200}$/.test(holderId))
    throw new Error("WHATSAPP_LINKED_WORKER_ID must be 1-200 characters of [A-Za-z0-9._:@-].");
  for (const [name, value] of Object.entries({ ttlMs, heartbeatMs, skewMs, retryMs }))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`Lease ${name} must be a positive integer.`);
  if (ttlMs < 5_000 || ttlMs > 600_000)
    throw new Error("WHATSAPP_LINKED_LEASE_TTL_MS must be between 5000 and 600000.");
  if (skewMs < 1_000 || skewMs * 2 > ttlMs)
    throw new Error(
      "WHATSAPP_LINKED_LEASE_SKEW_MS must be at least 1000 and at most half the TTL."
    );
  if (heartbeatMs < 500 || heartbeatMs * 3 > ttlMs - skewMs)
    throw new Error(
      "WHATSAPP_LINKED_LEASE_HEARTBEAT_MS must be at least 500 and at most (TTL - skew) / 3."
    );
  if (retryMs < 1_000 || retryMs > ttlMs * 4)
    throw new Error("WHATSAPP_LINKED_LEASE_RETRY_MS must be between 1000 and four TTLs.");
  return settings;
}

export function defaultLinkedWorkerId(): string {
  const host =
    hostname()
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .slice(0, 120) || "host";
  return `${host}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

/**
 * Reads operator settings. `WHATSAPP_LINKED_LEASE_MODE` is `off` (default: single process,
 * today's behaviour, the flock is the only guard) or `postgres`. Invalid values refuse startup.
 */
export function linkedLeaseSettingsFromEnvironment(
  environment: Record<string, string | undefined>
): { mode: "off" } | { mode: "postgres"; settings: LinkedLeaseSettings } {
  const mode = (environment.WHATSAPP_LINKED_LEASE_MODE ?? "off").trim() || "off";
  if (mode === "off") return { mode };
  if (mode !== "postgres") throw new Error("WHATSAPP_LINKED_LEASE_MODE must be off or postgres.");
  const integer = (name: string, fallback: number) => {
    const raw = environment[name]?.trim();
    if (!raw) return fallback;
    if (!/^[0-9]{1,9}$/.test(raw)) throw new Error(`${name} must be a whole number of ms.`);
    return Number(raw);
  };
  const ttlMs = integer("WHATSAPP_LINKED_LEASE_TTL_MS", defaultLinkedLeaseSettings.ttlMs);
  return {
    mode,
    settings: validateLinkedLeaseSettings({
      holderId: environment.WHATSAPP_LINKED_WORKER_ID?.trim() || defaultLinkedWorkerId(),
      ttlMs,
      heartbeatMs: integer(
        "WHATSAPP_LINKED_LEASE_HEARTBEAT_MS",
        defaultLinkedLeaseSettings.heartbeatMs
      ),
      skewMs: integer("WHATSAPP_LINKED_LEASE_SKEW_MS", defaultLinkedLeaseSettings.skewMs),
      retryMs: integer("WHATSAPP_LINKED_LEASE_RETRY_MS", defaultLinkedLeaseSettings.retryMs)
    })
  };
}

/** What the connector needs. `LinkedLeaseKeeper` is the implementation. */
export interface LinkedLeaseGuard {
  readonly retryMs: number;
  /** Current locally valid generation, or a fresh one from the store; null when held elsewhere. */
  acquire(businessId: string): Promise<string | null>;
  /** Synchronous, local: true while `generation` is held and inside its safe window. */
  holds(businessId: string, generation: string): boolean;
  /** Authoritative database check before an irreversible action. Fails closed on error. */
  verify(businessId: string, generation: string): Promise<boolean>;
  release(businessId: string, generation: string): Promise<void>;
  onLost(listener: (businessId: string, generation: string) => void): () => void;
  stop(): Promise<void>;
}

interface Held {
  generation: string;
  deadline: number;
  heartbeat?: ReturnType<typeof setTimeout>;
  expiry?: ReturnType<typeof setTimeout>;
}

export type LinkedLeaseLossReason = "rejected" | "expired" | "revoked";
export interface LinkedLeaseLogEvent {
  event: "whatsapp_linked.lease";
  businessId: string;
  holderId: string;
  generation: string;
  action: "acquired" | "lost" | "released";
  reason?: LinkedLeaseLossReason;
}

/**
 * Holds leases for one worker: heartbeats each one and reports loss. A lease is lost when a
 * renewal is rejected (another generation exists), when no renewal succeeds before the local
 * deadline (database unreachable, process paused), or when `verify` finds it gone.
 */
export class LinkedLeaseKeeper implements LinkedLeaseGuard {
  private readonly held = new Map<string, Held>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly listeners = new Set<(businessId: string, generation: string) => void>();
  private readonly settings: LinkedLeaseSettings;
  private readonly now: () => number;
  private stopped = false;

  constructor(
    private readonly store: LinkedLeaseStore,
    settings: LinkedLeaseSettings,
    options: {
      /** Local monotonic clock in ms; tests inject a controllable one. */
      now?: () => number;
      /** Structured trace: one line per acquire, loss and release. */
      log?: (event: LinkedLeaseLogEvent) => void;
    } = {}
  ) {
    this.settings = validateLinkedLeaseSettings(settings);
    this.now = options.now ?? (() => performance.now());
    this.log = options.log;
  }
  private readonly log: ((event: LinkedLeaseLogEvent) => void) | undefined;

  get holderId(): string {
    return this.settings.holderId;
  }
  get retryMs(): number {
    return this.settings.retryMs;
  }

  current(businessId: string): string | undefined {
    const entry = this.held.get(businessId);
    return entry && this.now() < entry.deadline ? entry.generation : undefined;
  }
  holds(businessId: string, generation: string): boolean {
    return !this.stopped && this.current(businessId) === generation;
  }

  acquire(businessId: string): Promise<string | null> {
    if (this.stopped) return Promise.resolve(null);
    const current = this.current(businessId);
    if (current) return Promise.resolve(current);
    const inFlight = this.pending.get(businessId);
    if (inFlight) return inFlight;
    const attempt = this.acquireFromStore(businessId).finally(() =>
      this.pending.delete(businessId)
    );
    this.pending.set(businessId, attempt);
    return attempt;
  }

  private async acquireFromStore(businessId: string): Promise<string | null> {
    const { holderId, ttlMs, skewMs } = this.settings;
    // Measure before sending: the database's expires_at is computed later than this instant.
    const started = this.now();
    const generation = await this.store.acquire(businessId, holderId, ttlMs);
    if (!generation) return null;
    const deadline = started + ttlMs - skewMs;
    if (this.stopped || deadline <= this.now()) {
      // Too slow to be safe, or shutting down: never act on it; hand it back immediately.
      await this.store.release(businessId, holderId, generation).catch(() => false);
      return null;
    }
    const previous = this.held.get(businessId);
    if (previous && previous.generation !== generation) this.lose(businessId, previous, "expired");
    const entry: Held = { generation, deadline };
    this.held.set(businessId, entry);
    this.armExpiry(businessId, entry);
    this.scheduleHeartbeat(businessId, entry);
    this.log?.({
      event: "whatsapp_linked.lease",
      businessId,
      holderId,
      generation,
      action: "acquired"
    });
    return generation;
  }

  private armExpiry(businessId: string, entry: Held): void {
    clearTimeout(entry.expiry);
    entry.expiry = setTimeout(
      () => {
        if (this.held.get(businessId) === entry && this.now() >= entry.deadline)
          this.lose(businessId, entry, "expired");
        else if (this.held.get(businessId) === entry) this.armExpiry(businessId, entry);
      },
      // At least 1 ms: a local clock slower than the timer clock re-arms in shrinking steps.
      Math.max(1, Math.ceil(entry.deadline - this.now()))
    );
    entry.expiry.unref?.();
  }

  private scheduleHeartbeat(businessId: string, entry: Held): void {
    clearTimeout(entry.heartbeat);
    // Normally `heartbeatMs`; sooner when a slow acquire/renew left less of the window, so at
    // least two attempts still land before the local deadline.
    const remaining = entry.deadline - this.now();
    const delay = Math.max(1, Math.min(this.settings.heartbeatMs, Math.floor(remaining / 3)));
    entry.heartbeat = setTimeout(() => void this.renew(businessId, entry), delay);
    entry.heartbeat.unref?.();
  }

  private async renew(businessId: string, entry: Held): Promise<void> {
    if (this.held.get(businessId) !== entry) return;
    const { holderId, ttlMs, skewMs } = this.settings;
    const started = this.now();
    let renewed: boolean | undefined;
    try {
      renewed = await this.store.renew(businessId, holderId, entry.generation, ttlMs);
    } catch {
      // Transient (database unreachable): keep the old deadline; expiry fires if none succeeds.
      renewed = undefined;
    }
    if (this.held.get(businessId) !== entry) return;
    if (renewed === false) {
      this.lose(businessId, entry, "rejected");
      return;
    }
    if (renewed === true) {
      if (started >= entry.deadline) {
        // The local window closed while the request was in flight; the expiry timer is due.
        this.lose(businessId, entry, "expired");
        return;
      }
      entry.deadline = Math.max(entry.deadline, started + ttlMs - skewMs);
      this.armExpiry(businessId, entry);
    }
    this.scheduleHeartbeat(businessId, entry);
  }

  async verify(businessId: string, generation: string): Promise<boolean> {
    if (!this.holds(businessId, generation)) return false;
    let held: boolean;
    try {
      held = await this.store.verify(businessId, this.settings.holderId, generation);
    } catch {
      return false;
    }
    const entry = this.held.get(businessId);
    if (!held && entry?.generation === generation) this.lose(businessId, entry, "revoked");
    return held && this.holds(businessId, generation);
  }

  async release(businessId: string, generation: string): Promise<void> {
    const entry = this.held.get(businessId);
    if (entry?.generation === generation) this.forget(businessId, entry);
    try {
      await this.store.release(businessId, this.settings.holderId, generation);
      this.log?.({
        event: "whatsapp_linked.lease",
        businessId,
        holderId: this.settings.holderId,
        generation,
        action: "released"
      });
    } catch {
      /* The row expires on its own within one TTL. */
    }
  }

  onLost(listener: (businessId: string, generation: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all(
      [...this.held.entries()].map(([businessId, entry]) =>
        this.release(businessId, entry.generation)
      )
    );
    this.listeners.clear();
  }

  private forget(businessId: string, entry: Held): void {
    clearTimeout(entry.heartbeat);
    clearTimeout(entry.expiry);
    if (this.held.get(businessId) === entry) this.held.delete(businessId);
  }

  private lose(businessId: string, entry: Held, reason: LinkedLeaseLossReason): void {
    this.forget(businessId, entry);
    this.log?.({
      event: "whatsapp_linked.lease",
      businessId,
      holderId: this.settings.holderId,
      generation: entry.generation,
      action: "lost",
      reason
    });
    // Best effort: lets a standby take over now instead of after the TTL. Conditional on
    // holder + generation, so it can never expire a successor's lease.
    void this.store
      .release(businessId, this.settings.holderId, entry.generation)
      .catch(() => false);
    for (const listener of [...this.listeners]) {
      try {
        listener(businessId, entry.generation);
      } catch {
        /* A listener failure must not keep other listeners from fencing. */
      }
    }
  }
}

/** Builds the keeper for a configured environment, or undefined for single-process mode. */
export function createLinkedLeaseKeeper(
  environment: Record<string, string | undefined>,
  sql: LinkedLeaseSql | undefined,
  options: ConstructorParameters<typeof LinkedLeaseKeeper>[2] = {}
): LinkedLeaseKeeper | undefined {
  const config = linkedLeaseSettingsFromEnvironment(environment);
  if (config.mode === "off") return undefined;
  if (!sql)
    throw new Error("WHATSAPP_LINKED_LEASE_MODE=postgres requires a Postgres database connection.");
  return new LinkedLeaseKeeper(new PostgresLinkedLeaseStore(sql), config.settings, options);
}
