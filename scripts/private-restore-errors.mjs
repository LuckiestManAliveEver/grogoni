/** Never log pg_restore stderr: COPY failures can include production row values. */
export function classifyPrivateRestoreFailure(stderr) {
  if (
    /^pg_restore: error: could not execute query: ERROR:\s+extension "pg_session_jwt" is not available/m.test(
      stderr
    )
  )
    return "RESTORE_PG_SESSION_JWT_UNAVAILABLE";
  if (/^pg_restore: error: could not execute query: ERROR:\s+extension /m.test(stderr))
    return "RESTORE_EXTENSION_UNAVAILABLE";
  if (/^pg_restore: error: connection to server /m.test(stderr)) return "RESTORE_CONNECTION_FAILED";
  return "RESTORE_FAILED";
}
