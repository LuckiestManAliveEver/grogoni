/**
 * Contract for the daemon lanes (docs/deployment/daemon-lanes.md): the /v1/daemon routes served by
 * the Edge API and the browser lane that calls them. The API's queue store re-exports these.
 */

export type DaemonPayload =
  | {
      kind: "agent";
      message: string;
      modelId: string;
      agentAdapterId: "grogoni" | "pi";
      /** Authorized by the API before enqueue; execution never trusts it as tool authority. */
      conversation?: {
        id: string;
        clientMessageId: string;
        scope: string;
        kind: "reply" | "reminder";
        reminderText?: string;
      };
    }
  | { kind: "maintenance"; job: string };

export type DaemonTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/**
 * The daemon task lifecycle, written down once. The queue store moves rows only along these
 * edges (each SQL update guards on its `from` states; a test in services/api checks them):
 *
 *   queued    → running    (a worker claims it)          | cancelled (owner/operator cancels)
 *   running   → completed  (settled with a result)       | failed (no retries left, or lease exhausted)
 *             → queued     (retry backoff, recurring run, or the worker releases it)
 *             → cancelled  (cancelled mid-run; the lease token is cleared to fence the worker)
 *   failed    → queued     (manual retry)
 *   cancelled → queued     (manual retry, once the old lease has run out)
 *   completed is final: a recurring task re-queues from `running`, never from `completed`.
 */
export const daemonTaskTransitions = {
  queued: ["running", "cancelled"],
  running: ["completed", "failed", "queued", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: ["queued"]
} as const satisfies Record<DaemonTaskStatus, readonly DaemonTaskStatus[]>;

/** Statuses a worker may still pick up or is executing. */
export const activeDaemonTaskStatuses = [
  "queued",
  "running"
] as const satisfies readonly DaemonTaskStatus[];

/** Statuses no worker will act on again without a manual retry. */
export const terminalDaemonTaskStatuses = [
  "completed",
  "failed",
  "cancelled"
] as const satisfies readonly DaemonTaskStatus[];

export function canTransitionDaemonTask(from: DaemonTaskStatus, to: DaemonTaskStatus): boolean {
  return (daemonTaskTransitions[from] as readonly DaemonTaskStatus[]).includes(to);
}

export function isActiveDaemonTaskStatus(status: DaemonTaskStatus): boolean {
  return (activeDaemonTaskStatuses as readonly DaemonTaskStatus[]).includes(status);
}

/** Which worker kind ran a task's latest attempt. */
export type DaemonLane = "browser" | "server";

/** A task as callers see it: no lease token, numeric counters, camelCase names. */
export interface PublicDaemonTask {
  id: string;
  key: string;
  payload: DaemonPayload;
  status: DaemonTaskStatus;
  runAt: string;
  intervalMs: number | null;
  attempts: number;
  maxAttempts: number;
  executions: number;
  leaseUntil: string | null;
  result: unknown;
  errorCode: string | null;
  lane: DaemonLane | null;
  createdAt: string;
  updatedAt: string;
}

/** A user task's result, whichever lane ran it. */
export interface DaemonUserTaskResult {
  text: string;
  modelId: string;
  executedBy: "device" | "server";
}

/**
 * POST /v1/daemon/claims. The lease token is the browser's only credential: it settles, renews,
 * releases or executes this one task, for this user, until leaseUntil.
 */
export interface DaemonClaim {
  task: PublicDaemonTask;
  leaseToken: string;
  leaseUntil: string;
  /** The lease's length. Renew by this, never by comparing leaseUntil with the device clock. */
  leaseMs: number;
  /** How long POST .../execute may take, server time included: the request timeout to use. */
  executeTimeoutMs: number;
  message: string | null;
}

/**
 * POST /v1/daemon/claims. With nothing due, nextDueInMs says how long until this user's next task
 * becomes claimable (null: none queued), measured on the database clock so a device's own clock
 * never matters, letting an idle tab sleep instead of polling.
 */
export interface DaemonClaimResponse {
  claim: DaemonClaim | null;
  nextDueInMs: number | null;
}

/** POST /v1/daemon/claims/:id/settle from a device: the reply, or a failure. */
export type DaemonDeviceOutcome =
  { text: string; modelId: string } | { errorCode: string; retryable: boolean };

/** Durable messenger execution state, owned by the daemon rather than client UI flags. */
export interface ConversationExecutionSummary {
  taskId: string;
  status: DaemonTaskStatus;
  modelId: string;
  attempts: number;
  errorCode: string | null;
  retryable: boolean;
  updatedAt: string;
}
