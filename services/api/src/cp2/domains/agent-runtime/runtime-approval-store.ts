import { createHash } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import type { RuntimeParserIntent } from "@grogoni/shared-types";
import type { PendingRuntimeAction } from "./shared.js";
import { Cp2Error } from "../../cp2-error.js";

const notFound = () =>
  new Cp2Error(
    404,
    "runtime_confirmation_not_found",
    "Runtime confirmation was not found or is no longer available."
  );

export interface RuntimeApprovalStore {
  deleteScope(actorIds: string[], businessIds: string[]): Promise<number>;
  purgeExpired(now: Date): Promise<number>;
  put(token: string, pending: PendingRuntimeAction): Promise<void>;
  claim(input: {
    token: string;
    businessId: string;
    actorId: string;
    runtimeSessionId: string;
    conversationId: string | null;
    now: Date;
  }): Promise<PendingRuntimeAction>;
}

/** Each query must commit independently before returning, including inside an Edge request. */
export function createPostgresRuntimeApprovalStore(database: {
  query: <R extends QueryResultRow>(sql: string, values: unknown[]) => Promise<QueryResult<R>>;
}): RuntimeApprovalStore {
  const hash = (token: string) => createHash("sha256").update(token).digest("hex");
  return {
    async deleteScope(actorIds, businessIds) {
      return (
        (
          await database.query(
            "delete from business_runtime_approvals where actor_id=any($1::text[]) or business_id=any($2::text[])",
            [actorIds, businessIds]
          )
        ).rowCount ?? 0
      );
    },
    async purgeExpired(now) {
      if (!Number.isFinite(now.getTime())) throw new Error("Invalid retention time.");
      return (
        (
          await database.query(
            "delete from business_runtime_approvals where expires_at <= $1::timestamptz - interval '24 hours'",
            [now]
          )
        ).rowCount ?? 0
      );
    },
    async put(token, pending) {
      await database.query(
        `insert into business_runtime_approvals
          (token_hash,business_id,actor_id,runtime_session_id,conversation_id,intent,action,expires_at)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [
          hash(token),
          pending.businessId,
          pending.actorId,
          pending.sessionId,
          pending.conversationId,
          pending.intent,
          JSON.stringify({ ...pending.action, confirmationToken: null }),
          pending.expiresAt
        ]
      );
    },
    async claim(input) {
      if (input.token.length > 200 || !Number.isFinite(input.now.getTime())) throw notFound();
      const result = await database.query<{
        intent: RuntimeParserIntent;
        action: PendingRuntimeAction["action"];
        expires_at: Date;
      }>(
        `update business_runtime_approvals set status='CLAIMED',claimed_at=$6
         where token_hash=$1 and business_id=$2 and actor_id=$3 and runtime_session_id=$4
           and conversation_id is not distinct from $5 and status='PENDING' and expires_at>$6
         returning intent,action,expires_at`,
        [
          hash(input.token),
          input.businessId,
          input.actorId,
          input.runtimeSessionId,
          input.conversationId,
          input.now
        ]
      );
      const row = result.rows[0];
      if (!row) throw notFound();
      return {
        sessionId: input.runtimeSessionId,
        businessId: input.businessId,
        actorId: input.actorId,
        conversationId: input.conversationId,
        expiresAt: new Date(row.expires_at).toISOString(),
        intent: row.intent,
        action: row.action
      };
    }
  };
}

/** Snapshot maintenance can delete approval records, but must never issue or claim approvals. */
export function createPostgresRuntimeApprovalMaintenance(
  database: Parameters<typeof createPostgresRuntimeApprovalStore>[0]
): RuntimeApprovalStore {
  const store = createPostgresRuntimeApprovalStore(database);
  const unavailable = async (): Promise<never> => {
    throw new Cp2Error(
      503,
      "runtime_approval_maintenance_only",
      "Runtime approvals are unavailable in this maintenance transaction."
    );
  };
  return { ...store, put: unavailable, claim: unavailable };
}
