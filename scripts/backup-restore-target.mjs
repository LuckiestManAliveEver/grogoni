import { URL } from "node:url";

export function assertNeonBackupSource(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("A direct Neon backup connection is required.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname.endsWith(".neon.tech") ||
    url.hostname.includes("-pooler") ||
    !url.username ||
    !url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key))
  )
    throw new Error("A direct Neon backup connection without routing overrides is required.");
  return value;
}

export function assertBackupRestoreTarget(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("An isolated backup restore target is required.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]", "restore-db"].includes(url.hostname) ||
    url.pathname !== "/grogoni_backup_restore" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Restore drills may target only the dedicated local grogoni_backup_restore database."
    );
  return value;
}
