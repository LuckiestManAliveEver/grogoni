import { runtimeSessionTurnLimit } from "@grogoni/shared-types";
import { recordRuntimeInitialization } from "./performance";

export type RuntimeManagerState = "idle" | "initializing" | "ready" | "failed" | "stopped";

interface RuntimeSlot {
  sessionId: string | null;
  exhaustedId: string | null;
  initialization: Promise<string> | null;
  state: RuntimeManagerState;
  generation: number;
}

export class RuntimeManager {
  private readonly slots = new Map<string, RuntimeSlot>();
  private selectedKey: string | null = null;
  private slot(key: string): RuntimeSlot {
    this.selectedKey = key;
    let slot = this.slots.get(key);
    if (!slot) {
      slot = {
        sessionId: null,
        exhaustedId: null,
        initialization: null,
        state: "idle",
        generation: 0
      };
      this.slots.set(key, slot);
    }
    return slot;
  }
  getState(): RuntimeManagerState {
    return this.selectedKey ? (this.slots.get(this.selectedKey)?.state ?? "idle") : "idle";
  }
  getSessionId(key: string): string | null {
    return this.slots.get(key)?.sessionId ?? null;
  }
  async ensureSession(key: string, createSession: () => Promise<string>): Promise<string> {
    const slot = this.slot(key);
    if (slot.sessionId === slot.exhaustedId) slot.sessionId = null;
    if (slot.sessionId !== null) {
      recordRuntimeInitialization("reused");
      return slot.sessionId;
    }
    if (slot.initialization) return slot.initialization;
    const started = performance.now();
    const generation = slot.generation;
    slot.state = "initializing";
    recordRuntimeInitialization("initializing");
    const initialization = createSession()
      .then((id) => {
        if (slot.generation !== generation)
          throw new Error("Runtime session initialization was cancelled.");
        slot.sessionId = id;
        slot.state = "ready";
        recordRuntimeInitialization("ready", performance.now() - started);
        return id;
      })
      .catch((error: unknown) => {
        if (slot.generation === generation) slot.state = "failed";
        recordRuntimeInitialization("failed", performance.now() - started);
        throw error;
      })
      .finally(() => {
        if (slot.initialization === initialization) slot.initialization = null;
      });
    slot.initialization = initialization;
    return initialization;
  }
  adoptSession(key: string, id: string, turnCount?: number): void {
    const slot = this.slot(key);
    slot.generation += 1;
    slot.initialization = null;
    slot.sessionId = id;
    if (turnCount !== undefined && turnCount >= runtimeSessionTurnLimit) slot.exhaustedId = id;
    slot.state = "ready";
  }
  async runWithSession<T>(
    key: string,
    create: () => Promise<string>,
    action: (id: string) => Promise<T>
  ): Promise<T> {
    const slot = this.slot(key);
    const id = await this.ensureSession(key, create);
    const generation = slot.generation;
    try {
      const result = await action(id);
      if (slot.generation !== generation) return result;
      const session = runtimeResultRecord(result)?.session as
        { id?: unknown; turnCount?: unknown } | undefined;
      if (typeof session?.id === "string" && Number(session.turnCount) >= runtimeSessionTurnLimit)
        slot.exhaustedId = session.id;
      if (!isRuntimeTurnLimitResult(result)) return result;
      slot.sessionId = null;
      slot.state = "idle";
      return action(await this.ensureSession(key, create));
    } catch (error) {
      if (slot.generation !== generation) throw error;
      if (!isExpiredRuntimeSessionError(error)) throw error;
      slot.sessionId = null;
      slot.state = "idle";
      return action(await this.ensureSession(key, create));
    }
  }
  stop(): void {
    for (const slot of this.slots.values()) {
      slot.generation += 1;
      slot.sessionId = null;
      slot.initialization = null;
      slot.state = "stopped";
    }
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
