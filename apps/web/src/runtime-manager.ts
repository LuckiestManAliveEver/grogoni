import { runtimeSessionTurnLimit } from "@grogoni/shared-types";
import { recordRuntimeInitialization } from "./performance";

export type RuntimeManagerState = "idle" | "initializing" | "ready" | "failed" | "stopped";

export class RuntimeManager {
  private key: string | null = null;
  private exhaustedSessionId: string | null = null;
  private runtimeSessionId: string | null = null;
  private initialization: Promise<string> | null = null;
  private state: RuntimeManagerState = "idle";

  getState(): RuntimeManagerState {
    return this.state;
  }

  getSessionId(key: string): string | null {
    return this.key === key ? this.runtimeSessionId : null;
  }

  async ensureSession(key: string, createSession: () => Promise<string>): Promise<string> {
    if (this.key !== key) this.resetForKey(key);
    if (this.runtimeSessionId === this.exhaustedSessionId) this.runtimeSessionId = null;
    if (this.runtimeSessionId !== null) {
      recordRuntimeInitialization("reused");
      return this.runtimeSessionId;
    }
    if (this.initialization !== null) return this.initialization;

    const startedAt = performance.now();
    this.state = "initializing";
    recordRuntimeInitialization("initializing");
    this.initialization = createSession()
      .then((runtimeSessionId) => {
        this.runtimeSessionId = runtimeSessionId;
        this.state = "ready";
        recordRuntimeInitialization("ready", performance.now() - startedAt);
        return runtimeSessionId;
      })
      .catch((error) => {
        this.state = "failed";
        recordRuntimeInitialization("failed", performance.now() - startedAt);
        throw error;
      })
      .finally(() => {
        this.initialization = null;
      });
    return this.initialization;
  }

  adoptSession(key: string, runtimeSessionId: string, turnCount?: number): void {
    if (this.key !== key) this.resetForKey(key);
    this.runtimeSessionId = runtimeSessionId;
    if (turnCount !== undefined && turnCount >= runtimeSessionTurnLimit) {
      this.exhaustedSessionId = runtimeSessionId;
    }
    this.state = "ready";
  }

  async runWithSession<TResult>(
    key: string,
    createSession: () => Promise<string>,
    action: (runtimeSessionId: string) => Promise<TResult>
  ): Promise<TResult> {
    const runtimeSessionId = await this.ensureSession(key, createSession);
    try {
      const result = await action(runtimeSessionId);
      const runtime = runtimeResultRecord(result);
      const session = runtime?.session as { id?: unknown; turnCount?: unknown } | undefined;
      if (typeof session?.id === "string" && Number(session.turnCount) >= runtimeSessionTurnLimit) {
        this.exhaustedSessionId = session.id;
      }
      if (!isRuntimeTurnLimitResult(result)) return result;
      // The server rejected this turn before execution; only that exact rejection is safe
      // to repeat in a fresh session. Never repeat a completed tool or another rate limit.
      this.runtimeSessionId = null;
      this.state = "idle";
      const replacement = await this.ensureSession(key, createSession);
      return action(replacement);
    } catch (error) {
      if (!isExpiredRuntimeSessionError(error)) throw error;
      this.runtimeSessionId = null;
      this.state = "idle";
      const replacement = await this.ensureSession(key, createSession);
      return action(replacement);
    }
  }

  stop(): void {
    this.runtimeSessionId = null;
    this.initialization = null;
    this.state = "stopped";
  }

  private resetForKey(key: string): void {
    this.key = key;
    this.runtimeSessionId = null;
    this.initialization = null;
    this.state = "idle";
  }
}

export function isExpiredRuntimeSessionError(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    (status === null || status === 404 || status === 409 || status === 410) &&
    /runtime session.*(?:expired|not found|closed)/i.test(message)
  );
}

function runtimeResultRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const runtime = record.runtime ?? record;
  return runtime !== null && typeof runtime === "object"
    ? (runtime as Record<string, unknown>)
    : null;
}

function isRuntimeTurnLimitResult(value: unknown): boolean {
  const turn = runtimeResultRecord(value)?.turn;
  if (turn === null || typeof turn !== "object") return false;
  const result = turn as Record<string, unknown>;
  const plan = result.plan as { validationErrors?: unknown; executedAt?: unknown } | undefined;
  return (
    result.status === "rate_limited" &&
    plan?.executedAt === null &&
    Array.isArray(plan.validationErrors) &&
    plan.validationErrors.includes("Runtime session turn limit reached.")
  );
}
