import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { acquireLinkedWorkerLock } from "./worker-lock.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
it("excludes a second owner and safely reacquires the same inode after release", () => {
  const root = mkdtempSync(join(tmpdir(), "wa-lock-"));
  roots.push(root);
  const release = acquireLinkedWorkerLock(root);
  try {
    expect(() => acquireLinkedWorkerLock(root)).toThrow("Another");
  } finally {
    release();
    release();
  }
  const next = acquireLinkedWorkerLock(root);
  next();
});
it("recovers automatically after SIGKILL without deleting the lock file", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-lock-crash-"));
  roots.push(root);
  // Independent flock owner; stdout readiness arrives only after the kernel lock is acquired.
  const child = spawn(
    "flock",
    [
      "--no-fork",
      "--exclusive",
      "--nonblock",
      join(root, "worker.lock"),
      "sh",
      "-c",
      "printf ready; exec sleep 60"
    ],
    { stdio: ["pipe", "pipe", "ignore"] }
  );
  try {
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(() => {
        throw new Error("Lock test child exited before readiness.");
      })
    ]);
    expect(() => acquireLinkedWorkerLock(root)).toThrow("Another");
    child.kill("SIGKILL");
    await once(child, "exit");
    const release = acquireLinkedWorkerLock(root);
    release();
  } finally {
    child.kill("SIGKILL");
  }
});
