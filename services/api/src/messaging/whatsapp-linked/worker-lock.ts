import { closeSync, constants, openSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** Linux flock locks the inherited open-file description, retained by the parent descriptor.
 * The kernel releases it after exit/SIGKILL. Never unlink the inode: doing so permits split brain.
 * Requires a local filesystem and util-linux flock in the persistent connector host image.
 *
 * `shared: true` (shared-volume lease mode) takes a shared lock instead: any number of lease-mode
 * workers may hold it together, the Postgres lease decides who runs each session, and a
 * single-process worker (exclusive lock) can never start beside them on the same volume, nor
 * they beside it. Across hosts this holds only where the filesystem propagates flock (NFSv4 and
 * most cluster filesystems do); the lease stays the guard either way.
 */
export function acquireLinkedWorkerLock(
  root: string,
  options: { shared?: boolean } = {}
): () => void {
  if (process.platform !== "linux")
    throw new Error("The linked connector currently requires a Linux host.");
  const fd = openSync(
    join(root, "worker.lock"),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600
  );
  const result = spawnSync(
    "flock",
    [options.shared ? "--shared" : "--exclusive", "--nonblock", "3"],
    {
      stdio: ["ignore", "ignore", "pipe", fd],
      timeout: 5000
    }
  );
  if (result.error || result.status !== 0) {
    closeSync(fd);
    throw new Error(
      result.status === 1
        ? options.shared
          ? "A single-process WhatsApp connector owns this session volume; it cannot be shared."
          : "Another WhatsApp connector owns this session volume."
        : "Cannot acquire the WhatsApp worker lock; install util-linux flock."
    );
  }
  let released = false;
  return () => {
    if (!released) {
      released = true;
      closeSync(fd);
    }
  };
}
