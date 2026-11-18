import { readCurrentOwnerRoute } from "../browser-navigation";
import { runtimeSessionTurnLimit } from "@grogoni/shared-types";
import { useRef, useState } from "react";
import { reportBackgroundLoadError } from "../background-load-error";

import { getErrorMessage, runtimeManagerKey } from "../chat-message-plumbing";
import { isRetryableApiRequestError } from "../lib/api";
import { getJson, postJson } from "../api-helpers";
import {
  runtimeManager,
  type RuntimeSessionSummary,
  type RuntimeTurnSummary
} from "../grogoni-application-shared";

interface UseRuntimeHistoryStateDeps {
  business: { id: string } | null;
  session: { account: { id: string } } | null;
  setStatusMessage: (message: string) => void;
  registerReset: (domainKey: string, fn: () => void) => void;
  registerRefresh: (
    domainKey: string,
    views: readonly string[],
    fn: (businessId: string) => Promise<void>
  ) => void;
}

export function useRuntimeHistoryState(deps: UseRuntimeHistoryStateDeps) {
  const [runtimeSessions, setRuntimeSessions] = useState<RuntimeSessionSummary[]>([]);
  const [selectedRuntimeHistorySessionId, setSelectedRuntimeHistorySessionId] = useState<
    string | null
  >(null);
  const [runtimeTurns, setRuntimeTurns] = useState<RuntimeTurnSummary[]>([]);
  const runtimeRestoreInFlightRef = useRef(new Map<string, Promise<string>>());
  const runtimeCreationAttemptRef = useRef<{
    managerKey: string;
    idempotencyKey: string;
  } | null>(null);

  async function loadRuntimeTurns(businessId: string, sessionId: string) {
    try {
      setRuntimeTurns(
        await getJson<RuntimeTurnSummary[]>(
          `/businesses/${businessId}/runtime/sessions/${sessionId}/turns`
        )
      );
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  async function loadRuntimeSessions(businessId: string) {
    try {
      const sessions = await getJson<RuntimeSessionSummary[]>(
        `/businesses/${businessId}/runtime/sessions`
      );
      setRuntimeSessions(sessions);
      const nextSessionId = selectedRuntimeHistorySessionId ?? sessions.at(-1)?.id ?? null;
      setSelectedRuntimeHistorySessionId(nextSessionId);
      if (nextSessionId !== null) {
        await loadRuntimeTurns(businessId, nextSessionId);
      } else {
        setRuntimeTurns([]);
      }
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  async function createManagedRuntimeSession(
    conversationId = readCurrentOwnerRoute()?.conversationId
  ): Promise<string> {
    if (deps.business === null || deps.session === null) {
      throw new Error("Sign in and select a shop before starting the AI runtime.");
    }
    const managerKey = runtimeManagerKey(deps.session.account.id, deps.business.id, conversationId);
    if (runtimeCreationAttemptRef.current?.managerKey !== managerKey) {
      runtimeCreationAttemptRef.current = {
        managerKey,
        idempotencyKey: createRuntimeSessionIdempotencyKey()
      };
    }
    const attempt = runtimeCreationAttemptRef.current;
    const create = () =>
      postJson<RuntimeSessionSummary>(`/businesses/${deps.business!.id}/runtime/sessions`, {
        idempotencyKey: attempt.idempotencyKey,
        ...(conversationId ? { conversationId } : {})
      });
    // The same key makes a retry safe even if the first response was lost after committing.
    const created = await create().catch(async (error) => {
      if (!isRetryableApiRequestError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return create();
    });
    if (runtimeCreationAttemptRef.current === attempt) {
      runtimeCreationAttemptRef.current = null;
    }
    try {
      localStorage.setItem(`grogoni.runtime-conversation:${managerKey}`, created.id);
    } catch {
      /* Session continues in memory. */
    }
    setRuntimeSessions((sessions) =>
      sessions.some((item) => item.id === created.id) ? sessions : [...sessions, created]
    );
    setSelectedRuntimeHistorySessionId(created.id);
    return created.id;
  }

  // setRuntimeSessionId is a call-time argument, not a hook-level dep: it's owned by the Chat
  // domain hook (Phase 16), which itself needs createManagedRuntimeSession/ensureRuntimeSession/
  // loadRuntimeSessions from this hook - a genuine two-way dependency no hook-call ordering can
  // satisfy. Same "call-time argument" pattern used for Sync's replaySyncQueue/replaySyncQueueItem
  // in Phase 7.
  async function createRuntimeHistorySession(setRuntimeSessionId: (sessionId: string) => void) {
    if (deps.business === null || deps.session === null) {
      return;
    }

    try {
      runtimeManager.stop();
      const runtimeSessionId = await createManagedRuntimeSession();
      runtimeManager.adoptSession(
        runtimeManagerKey(
          deps.session.account.id,
          deps.business.id,
          readCurrentOwnerRoute()?.conversationId
        ),
        runtimeSessionId
      );
      setRuntimeTurns([]);
      setRuntimeSessionId(runtimeSessionId);
      deps.setStatusMessage("Runtime session created");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function ensureRuntimeSession(
    setRuntimeSessionId: (sessionId: string) => void,
    conversationId = readCurrentOwnerRoute()?.conversationId
  ): Promise<string> {
    if (deps.business === null || deps.session === null) {
      throw new Error("Sign in and select a shop before starting the AI runtime.");
    }

    const key = runtimeManagerKey(deps.session.account.id, deps.business.id, conversationId);
    const runtimeSessionId = await runtimeManager.ensureSession(key, () =>
      createManagedRuntimeSession(conversationId)
    );
    setRuntimeSessionId(runtimeSessionId);
    return runtimeSessionId;
  }

  async function restoreOrCreateRuntimeSession(
    setRuntimeSessionId: (sessionId: string) => void,
    conversationId = readCurrentOwnerRoute()?.conversationId
  ): Promise<string> {
    if (deps.business === null || deps.session === null) {
      throw new Error("Sign in and select a shop before restoring the AI runtime.");
    }
    const businessId = deps.business.id;
    const key = runtimeManagerKey(deps.session.account.id, businessId, conversationId);
    const pending = runtimeRestoreInFlightRef.current.get(key);
    if (pending) return pending;
    const restore = (async () => {
      const sessions = await getJson<RuntimeSessionSummary[]>(
        `/businesses/${businessId}/runtime/sessions`
      );
      setRuntimeSessions(sessions);
      let remembered: string | null = null;
      try {
        remembered = localStorage.getItem(`grogoni.runtime-conversation:${key}`);
      } catch {
        /* No saved association. */
      }
      const existing = sessions.find(
        (candidate) =>
          (candidate.conversationId === conversationId || candidate.id === remembered) &&
          candidate.status === "active" &&
          candidate.turnCount < runtimeSessionTurnLimit
      );
      if (existing !== undefined) {
        runtimeManager.adoptSession(key, existing.id, existing.turnCount);
        setRuntimeSessionId(existing.id);
        setSelectedRuntimeHistorySessionId(existing.id);
        return existing.id;
      }
      return ensureRuntimeSession(setRuntimeSessionId, conversationId);
    })().finally(() => {
      runtimeRestoreInFlightRef.current.delete(key);
    });
    runtimeRestoreInFlightRef.current.set(key, restore);
    return restore;
  }

  deps.registerReset("runtime-history", () => {
    runtimeCreationAttemptRef.current = null;
    runtimeRestoreInFlightRef.current.clear();
    setRuntimeSessions([]);
    setSelectedRuntimeHistorySessionId(null);
    setRuntimeTurns([]);
  });
  deps.registerRefresh("runtime-history", ["runtime"], loadRuntimeSessions);

  return {
    runtimeSessions,
    selectedRuntimeHistorySessionId,
    setSelectedRuntimeHistorySessionId,
    runtimeTurns,
    loadRuntimeSessions,
    loadRuntimeTurns,
    createRuntimeHistorySession,
    createManagedRuntimeSession,
    ensureRuntimeSession,
    restoreOrCreateRuntimeSession
  };
}

function createRuntimeSessionIdempotencyKey(): string {
  const suffix =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `runtime:${suffix}`;
}
