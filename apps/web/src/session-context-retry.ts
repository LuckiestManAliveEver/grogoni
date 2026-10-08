// Loads an account's session context until one load applies, then never again for that sign-in.
//
// The session context (the account's shops, last mode and surface) restores navigation when it
// applies, so it must apply once per sign-in and must not re-run later and move the user. A load
// that fails (offline, server down) is retried when the caller signals a good moment (reconnect,
// app shown again) via retry().
//
// Latest load wins: starting a load supersedes every earlier one, and a sign-in change supersedes
// them all. Each load gets shouldApply(), which the loader checks after its request returns and
// before touching any state, so a superseded result is dropped instead of applied. retry() does
// not start while another load holds the slot, unless that load has run past leaseMs (a hung
// request must not block retries for the rest of the sign-in; whatever starts next supersedes it).

/**
 * "restore" for the sign-in's first load (it may restore where the owner last worked); "refresh"
 * for every retry after it (data only: the user may have navigated since).
 */
export type SessionContextLoad = (
  shouldApply: () => boolean,
  apply: "restore" | "refresh"
) => Promise<boolean>;

export interface ExternalSessionContextLoad {
  /** Pass to the loader: true while this is still the latest load of the current sign-in. */
  shouldApply: () => boolean;
  /** Report whether the loader applied the context. Releases the slot. */
  settle: (applied: boolean) => void;
}

export interface SessionContextRetry {
  /** The signed-in account changed (null on sign-out). Starts a load for a new account. */
  track(accountId: string | null, load?: SessionContextLoad): void;
  /** A moment worth trying again (reconnected, shown again). No-op once applied or in flight. */
  retry(): void;
  /**
   * The user picked where to be (joinStaffShop) and loads the context itself. It supersedes any
   * load in flight and ends retrying for this sign-in whatever its own load does: a later retry
   * would restore the server's last shop over the one the user just chose.
   */
  beginExternalLoad(): ExternalSessionContextLoad;
}

export function createSessionContextRetry(
  options: { leaseMs?: number; now?: () => number } = {}
): SessionContextRetry {
  const leaseMs = options.leaseMs ?? 30_000;
  const now = options.now ?? Date.now;
  let current: string | null = null;
  let loadCurrent: SessionContextLoad | null = null;
  // Bumped on every account change, so results from an earlier sign-in are recognizable.
  let signIn = 0;
  let applied = false;
  // Whether this sign-in already started its first ("restore") load. Kept here, not in the
  // caller's closure, so re-registering the same account's loader (React StrictMode or HMR
  // remounting the effect) cannot make a retry restore again.
  let restoreStarted = false;
  let latest: symbol | null = null;
  let inFlight: { token: symbol; startedAt: number } | null = null;

  function start(): ExternalSessionContextLoad {
    const token = Symbol("session-context-load");
    const startedIn = signIn;
    latest = token;
    inFlight = { token, startedAt: now() };
    return {
      shouldApply: () => latest === token && startedIn === signIn,
      settle: (ok) => {
        if (inFlight?.token === token) inFlight = null;
        if (ok && startedIn === signIn) applied = true;
      }
    };
  }

  function attempt() {
    const load = loadCurrent;
    if (current === null || load === null || applied) return;
    if (inFlight !== null && now() - inFlight.startedAt < leaseMs) return;
    const apply = restoreStarted ? "refresh" : "restore";
    restoreStarted = true;
    const { shouldApply, settle } = start();
    load(shouldApply, apply).then(settle, () => settle(false));
  }

  return {
    track(accountId, load) {
      if (accountId !== current) {
        signIn += 1;
        applied = false;
        restoreStarted = false;
        inFlight = null;
      }
      current = accountId;
      loadCurrent = accountId === null ? null : (load ?? null);
      attempt();
    },
    retry: attempt,
    beginExternalLoad() {
      applied = true;
      return start();
    }
  };
}
