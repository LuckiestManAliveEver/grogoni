import { SyncDatabaseBlockedError } from "./indexeddb-repository";

/** Waits between attempts while another tab blocks the device database: 2 s, 5 s, 10 s, 30 s, then every 60 s. */
export const blockedRetryDelaysMs = [2_000, 5_000, 10_000, 30_000, 60_000] as const;

/**
 * Opens the device sync database, and keeps trying while an older Grogoni tab blocks the upgrade
 * (it holds the database open until it closes or reloads). Without this, one blocked open turned
 * sync off for the whole session. Any other failure is final, as before. Resolves null once
 * cancelled; an open that lands after cancelling is closed, never leaked.
 */
export async function openSyncRepositoryWhenFree<T extends { close(): void }>(options: {
  open: () => Promise<T>;
  isCancelled: () => boolean;
  /** Called once, on the first blocked attempt, so the person can be told to close the old tab. */
  onBlocked?: () => void;
  wait?: (ms: number) => Promise<void>;
}): Promise<T | null> {
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    if (options.isCancelled()) return null;
    try {
      const repository = await options.open();
      if (options.isCancelled()) {
        repository.close();
        return null;
      }
      return repository;
    } catch (error) {
      if (!(error instanceof SyncDatabaseBlockedError)) throw error;
      if (attempt === 0) options.onBlocked?.();
      await wait(blockedRetryDelaysMs[Math.min(attempt, blockedRetryDelaysMs.length - 1)]!);
    }
  }
}
