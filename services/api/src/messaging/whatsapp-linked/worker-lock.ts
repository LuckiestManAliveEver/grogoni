import { closeSync, constants, openSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** Linux flock locks the inherited open-file description, retained by the parent descriptor.
 * The kernel releases it after exit/SIGKILL. Never unlink the inode: doing so permits split brain.
 * Requires a local filesystem and util-linux flock in the persistent connector host image.
 */
export function acquireLinkedWorkerLock(root: string): () => void {
  if (process.platform !== "linux")
    throw new Error("The linked connector currently requires a Linux host.");
  const fd = openSync(
    join(root, "worker.lock"),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600
  );
  const result = spawnSync("flock", ["--exclusive", "--nonblock", "3"], {
    stdio: ["ignore", "ignore", "pipe", fd],
    timeout: 5000
  });
  if (result.error || result.status !== 0) {
    closeSync(fd);
    throw new Error(
      result.status === 1
        ? "Another WhatsApp connector owns this session volume."
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
