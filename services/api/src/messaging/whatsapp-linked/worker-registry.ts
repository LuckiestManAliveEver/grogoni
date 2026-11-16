import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  LinkedWorkerRefusal,
  LinkedWorkerStatus,
  LinkedWorkerSummary
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2/cp2-error.js";
import type { LinkedLeaseSql } from "./lease.js";

/**
 * Enrolled remote connector workers (migration 139; docs/architecture/whatsapp-linked-devices.md,
 * "Remote connector workers"). A credential is `gwlw1.<workerId>.<secret>`: 32 random bytes,
 * shown once to the owner, stored only as SHA-256. It is bound to one business and to the owner
 * who issued it, expires, rotates (the old secret stops at once) and is revoked permanently.
 *
 * Expiry and attachment decisions use the database clock in Postgres, like the leases.
 */

export interface LinkedWorkerRecord {
  id: string;
  businessId: string;
  ownerId: string;
  label: string;
  secretHash: string;
  credentialVersion: number;
  status: "active" | "revoked";
  expired: boolean;
  createdAt: string;
  rotatedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  attachedHolder: string | null;
  attachedUrl: string | null;
  attached: boolean;
}

export interface LinkedWorkerRegistry {
  /** Issues a credential. One active worker per business: a second enrollment is refused. */
  enroll(input: {
    businessId: string;
    ownerId: string;
    label: string;
    ttlMs: number;
  }): Promise<{ record: LinkedWorkerRecord; secret: string }>;
  /** New secret and expiry, `credentialVersion + 1`; the previous secret stops verifying. */
  rotate(input: {
    businessId: string;
    workerId: string;
    ownerId: string;
    ttlMs: number;
  }): Promise<{ record: LinkedWorkerRecord; secret: string } | null>;
  revoke(businessId: string, workerId: string): Promise<LinkedWorkerRecord | null>;
  list(businessId: string): Promise<LinkedWorkerRecord[]>;
  /** The active, unexpired worker of a business, if any. */
  activeForBusiness(businessId: string): Promise<LinkedWorkerRecord | null>;
  /** Verifies a presented secret. Never says which part was wrong beyond the refusal code. */
  authenticate(
    workerId: string,
    secret: string
  ): Promise<{ record: LinkedWorkerRecord } | { refusal: LinkedWorkerRefusal }>;
  /** Re-check of an attached worker: still active, unexpired, same credential version. */
  stillValid(workerId: string, credentialVersion: number): Promise<boolean>;
  /**
   * Claims the worker's attachment for this host until now + ttl. Succeeds when unattached,
   * expired, or already attached here, and only for the current credential version.
   */
  attach(
    workerId: string,
    credentialVersion: number,
    holderId: string,
    url: string | null,
    ttlMs: number
  ): Promise<boolean>;
  detach(workerId: string, holderId: string): Promise<void>;
  /** Which host the business's active worker is attached to right now. */
  attachment(businessId: string): Promise<{ holderId: string; url: string | null } | null>;
}

export function hashLinkedWorkerSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}
function newSecret(): string {
  return randomBytes(32).toString("base64url");
}
export function formatLinkedWorkerCredential(workerId: string, secret: string): string {
  return `gwlw1.${workerId}.${secret}`;
}
function hashesMatch(stored: string, presented: string): boolean {
  const a = Buffer.from(stored, "hex");
  const b = Buffer.from(hashLinkedWorkerSecret(presented), "hex");
  return a.length === 32 && a.length === b.length && timingSafeEqual(a, b);
}

export function linkedWorkerSummary(record: LinkedWorkerRecord): LinkedWorkerSummary {
  const status: LinkedWorkerStatus =
    record.status === "revoked" ? "revoked" : record.expired ? "expired" : "active";
  return {
    id: record.id,
    businessId: record.businessId,
    label: record.label,
    status,
    createdAt: record.createdAt,
    rotatedAt: record.rotatedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    credentialVersion: record.credentialVersion,
    attached: record.status === "active" && !record.expired && record.attached,
    lastSeenAt: record.lastSeenAt
  };
}

/** Default and bounds for WHATSAPP_LINKED_WORKER_CREDENTIAL_DAYS. */
export function linkedWorkerCredentialTtlMs(environment: Record<string, string | undefined>) {
  const raw = environment.WHATSAPP_LINKED_WORKER_CREDENTIAL_DAYS?.trim() || "30";
  if (!/^[0-9]{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > 90)
    throw new Error("WHATSAPP_LINKED_WORKER_CREDENTIAL_DAYS must be a whole number from 1 to 90.");
  return Number(raw) * 86_400_000;
}

function duplicate(): Cp2Error {
  return new Cp2Error(
    409,
    "whatsapp_worker_exists",
    "This business already has an active WhatsApp worker. Revoke it before enrolling another."
  );
}

/** Process-local registry with the Postgres semantics. Single-process deployments and tests. */
export class MemoryLinkedWorkerRegistry implements LinkedWorkerRegistry {
  private readonly rows = new Map<
    string,
    Omit<LinkedWorkerRecord, "expired" | "attached"> & {
      expiresMs: number;
      attachedUntilMs: number;
    }
  >();
  constructor(private readonly clock: () => number = Date.now) {}

  private view(id: string): LinkedWorkerRecord | null {
    const row = this.rows.get(id);
    if (!row) return null;
    const now = this.clock();
    const { expiresMs, attachedUntilMs, ...rest } = row;
    return { ...rest, expired: expiresMs <= now, attached: attachedUntilMs > now };
  }
  private active(businessId: string) {
    return [...this.rows.values()].find(
      (row) => row.businessId === businessId && row.status === "active"
    );
  }
  async enroll(input: { businessId: string; ownerId: string; label: string; ttlMs: number }) {
    if (this.active(input.businessId)) throw duplicate();
    const now = this.clock();
    const id = randomUUID();
    const secret = newSecret();
    const iso = new Date(now).toISOString();
    this.rows.set(id, {
      id,
      businessId: input.businessId,
      ownerId: input.ownerId,
      label: input.label,
      secretHash: hashLinkedWorkerSecret(secret),
      credentialVersion: 1,
      status: "active",
      createdAt: iso,
      rotatedAt: iso,
      expiresAt: new Date(now + input.ttlMs).toISOString(),
      expiresMs: now + input.ttlMs,
      revokedAt: null,
      lastSeenAt: null,
      attachedHolder: null,
      attachedUrl: null,
      attachedUntilMs: 0
    });
    return { record: this.view(id)!, secret };
  }
  async rotate(input: { businessId: string; workerId: string; ownerId: string; ttlMs: number }) {
    const row = this.rows.get(input.workerId);
    if (!row || row.businessId !== input.businessId || row.status !== "active") return null;
    const now = this.clock();
    const secret = newSecret();
    row.secretHash = hashLinkedWorkerSecret(secret);
    row.credentialVersion += 1;
    row.ownerId = input.ownerId;
    row.rotatedAt = new Date(now).toISOString();
    row.expiresMs = now + input.ttlMs;
    row.expiresAt = new Date(row.expiresMs).toISOString();
    row.attachedHolder = null;
    row.attachedUrl = null;
    row.attachedUntilMs = 0;
    return { record: this.view(row.id)!, secret };
  }
  async revoke(businessId: string, workerId: string) {
    const row = this.rows.get(workerId);
    if (!row || row.businessId !== businessId) return null;
    if (row.status === "active") {
      row.status = "revoked";
      row.revokedAt = new Date(this.clock()).toISOString();
      row.attachedHolder = null;
      row.attachedUrl = null;
      row.attachedUntilMs = 0;
    }
    return this.view(workerId);
  }
  async list(businessId: string) {
    return [...this.rows.values()]
      .filter((row) => row.businessId === businessId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((row) => this.view(row.id)!);
  }
  async activeForBusiness(businessId: string) {
    const row = this.active(businessId);
    const view = row ? this.view(row.id) : null;
    return view && !view.expired ? view : null;
  }
  async authenticate(workerId: string, secret: string) {
    const record = this.view(workerId);
    if (!record || !hashesMatch(record.secretHash, secret))
      return { refusal: "credential_invalid" as const };
    if (record.status === "revoked") return { refusal: "credential_revoked" as const };
    if (record.expired) return { refusal: "credential_expired" as const };
    this.rows.get(workerId)!.lastSeenAt = new Date(this.clock()).toISOString();
    return { record };
  }
  async stillValid(workerId: string, credentialVersion: number) {
    const record = this.view(workerId);
    return Boolean(
      record &&
      record.status === "active" &&
      !record.expired &&
      record.credentialVersion === credentialVersion
    );
  }
  async attach(
    workerId: string,
    credentialVersion: number,
    holderId: string,
    url: string | null,
    ttlMs: number
  ) {
    const row = this.rows.get(workerId);
    const now = this.clock();
    if (
      !row ||
      row.status !== "active" ||
      row.expiresMs <= now ||
      row.credentialVersion !== credentialVersion ||
      (row.attachedUntilMs > now && row.attachedHolder !== holderId)
    )
      return false;
    row.attachedHolder = holderId;
    row.attachedUrl = url;
    row.attachedUntilMs = now + ttlMs;
    row.lastSeenAt = new Date(now).toISOString();
    return true;
  }
  async detach(workerId: string, holderId: string) {
    const row = this.rows.get(workerId);
    if (row?.attachedHolder === holderId) {
      row.attachedHolder = null;
      row.attachedUrl = null;
      row.attachedUntilMs = 0;
    }
  }
  async attachment(businessId: string) {
    const row = this.active(businessId);
    if (!row || row.attachedUntilMs <= this.clock() || !row.attachedHolder) return null;
    return { holderId: row.attachedHolder, url: row.attachedUrl };
  }
}

const columns = `id, business_id, owner_id, label, secret_hash, credential_version, status,
  expires_at <= now() as expired,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
  to_char(rotated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as rotated_at,
  to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expires_at,
  to_char(revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as revoked_at,
  to_char(last_seen_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_seen_at,
  attached_holder, attached_url,
  coalesce(attached_until > now(), false) as attached`;

function record(row: unknown): LinkedWorkerRecord {
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id),
    businessId: String(value.business_id),
    ownerId: String(value.owner_id),
    label: String(value.label),
    secretHash: String(value.secret_hash),
    credentialVersion: Number(value.credential_version),
    status: value.status === "revoked" ? "revoked" : "active",
    expired: value.expired === true,
    createdAt: String(value.created_at),
    rotatedAt: String(value.rotated_at),
    expiresAt: String(value.expires_at),
    revokedAt: typeof value.revoked_at === "string" ? value.revoked_at : null,
    lastSeenAt: typeof value.last_seen_at === "string" ? value.last_seen_at : null,
    attachedHolder: typeof value.attached_holder === "string" ? value.attached_holder : null,
    attachedUrl: typeof value.attached_url === "string" ? value.attached_url : null,
    attached: value.attached === true
  };
}

export class PostgresLinkedWorkerRegistry implements LinkedWorkerRegistry {
  constructor(private readonly sql: LinkedLeaseSql) {}

  async enroll(input: { businessId: string; ownerId: string; label: string; ttlMs: number }) {
    const secret = newSecret();
    try {
      const result = await this.sql.query(
        `insert into whatsapp_linked_workers
           (id, business_id, owner_id, label, secret_hash, expires_at)
         values ($1, $2, $3, $4, $5, now() + $6::bigint * interval '1 millisecond')
         returning ${columns}`,
        [
          randomUUID(),
          input.businessId,
          input.ownerId,
          input.label,
          hashLinkedWorkerSecret(secret),
          input.ttlMs
        ]
      );
      return { record: record(result.rows[0]), secret };
    } catch (error) {
      if ((error as { code?: unknown }).code === "23505") throw duplicate();
      throw error;
    }
  }
  async rotate(input: { businessId: string; workerId: string; ownerId: string; ttlMs: number }) {
    const secret = newSecret();
    const result = await this.sql.query(
      `update whatsapp_linked_workers
          set secret_hash = $4, credential_version = credential_version + 1, owner_id = $3,
              rotated_at = now(), expires_at = now() + $5::bigint * interval '1 millisecond',
              attached_holder = null, attached_url = null, attached_until = null
        where id = $1 and business_id = $2 and status = 'active'
        returning ${columns}`,
      [input.workerId, input.businessId, input.ownerId, hashLinkedWorkerSecret(secret), input.ttlMs]
    );
    return result.rows[0] ? { record: record(result.rows[0]), secret } : null;
  }
  async revoke(businessId: string, workerId: string) {
    await this.sql.query(
      `update whatsapp_linked_workers
          set status = 'revoked', revoked_at = now(),
              attached_holder = null, attached_url = null, attached_until = null
        where id = $1 and business_id = $2 and status = 'active'`,
      [workerId, businessId]
    );
    const result = await this.sql.query(
      `select ${columns} from whatsapp_linked_workers where id = $1 and business_id = $2`,
      [workerId, businessId]
    );
    return result.rows[0] ? record(result.rows[0]) : null;
  }
  async list(businessId: string) {
    const result = await this.sql.query(
      `select ${columns} from whatsapp_linked_workers where business_id = $1
        order by created_at desc limit 50`,
      [businessId]
    );
    return result.rows.map(record);
  }
  async activeForBusiness(businessId: string) {
    const result = await this.sql.query(
      `select ${columns} from whatsapp_linked_workers
        where business_id = $1 and status = 'active' and expires_at > now()`,
      [businessId]
    );
    return result.rows[0] ? record(result.rows[0]) : null;
  }
  async authenticate(workerId: string, secret: string) {
    if (!/^[0-9a-f-]{36}$/.test(workerId)) return { refusal: "credential_invalid" as const };
    const result = await this.sql.query(
      `select ${columns} from whatsapp_linked_workers where id = $1`,
      [workerId]
    );
    const row = result.rows[0] ? record(result.rows[0]) : null;
    if (!row || !hashesMatch(row.secretHash, secret))
      return { refusal: "credential_invalid" as const };
    if (row.status === "revoked") return { refusal: "credential_revoked" as const };
    if (row.expired) return { refusal: "credential_expired" as const };
    await this.sql.query(`update whatsapp_linked_workers set last_seen_at = now() where id = $1`, [
      workerId
    ]);
    return { record: row };
  }
  async stillValid(workerId: string, credentialVersion: number) {
    const result = await this.sql.query(
      `select 1 as valid from whatsapp_linked_workers
        where id = $1 and status = 'active' and expires_at > now() and credential_version = $2`,
      [workerId, credentialVersion]
    );
    return result.rows.length === 1;
  }
  async attach(
    workerId: string,
    credentialVersion: number,
    holderId: string,
    url: string | null,
    ttlMs: number
  ) {
    const result = await this.sql.query(
      `update whatsapp_linked_workers
          set attached_holder = $3, attached_url = $4,
              attached_until = now() + $5::integer * interval '1 millisecond', last_seen_at = now()
        where id = $1 and credential_version = $2 and status = 'active' and expires_at > now()
          and (attached_until is null or attached_until <= now() or attached_holder = $3)
        returning 1 as attached`,
      [workerId, credentialVersion, holderId, url, ttlMs]
    );
    return result.rows.length === 1;
  }
  async detach(workerId: string, holderId: string) {
    await this.sql.query(
      `update whatsapp_linked_workers
          set attached_holder = null, attached_url = null, attached_until = null
        where id = $1 and attached_holder = $2`,
      [workerId, holderId]
    );
  }
  async attachment(businessId: string) {
    const result = await this.sql.query(
      `select attached_holder, attached_url from whatsapp_linked_workers
        where business_id = $1 and status = 'active' and expires_at > now()
          and attached_until > now() and attached_holder is not null`,
      [businessId]
    );
    const row = result.rows[0] as { attached_holder?: string; attached_url?: string | null };
    return row?.attached_holder
      ? { holderId: row.attached_holder, url: row.attached_url ?? null }
      : null;
  }
}
