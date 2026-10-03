// Shared by scripts/store-lock.mjs and its tests. Matches only the CP2 persistence lock
// `pg_advisory_*lock(hashtext('grogoni.cp2.normalized_store'))` in the current database: pg_locks is
// server-wide, and a bigint advisory key is stored as classid (high 32 bits), objid (low 32 bits)
// and objsubid 1.
export const storeLockPredicate = `
  l.locktype = 'advisory'
  and l.database = (select oid from pg_database where datname = current_database())
  and l.classid = ((hashtext('grogoni.cp2.normalized_store')::bigint >> 32) & 4294967295)::oid
  and l.objid = (hashtext('grogoni.cp2.normalized_store')::bigint & 4294967295)::oid
  and l.objsubid = 1`;

/** Every backend holding or waiting for the store lock, holders first. */
export async function findStoreLockHolders(client) {
  const { rows } = await client.query(
    `select a.pid, l.granted, a.state, a.application_name,
            now() - a.backend_start as connection_age, now() - a.state_change as in_state_for,
            left(regexp_replace(a.query, '\\s+', ' ', 'g'), 100) as last_query
       from pg_locks l join pg_stat_activity a on a.pid = l.pid
      where ${storeLockPredicate}
      order by l.granted desc, a.pid`
  );
  return {
    holders: rows.filter((row) => row.granted),
    waiters: rows.filter((row) => !row.granted)
  };
}

/**
 * Terminates holders that are "idle" outside any transaction. The current code only takes the lock
 * inside a transaction, so its holders are "active" or "idle in transaction"; an idle holder can only
 * be a leaked session-level lock. The state is re-checked in the terminating statement itself, so a
 * backend that started running something since it was listed is left alone.
 */
export async function releaseLeakedStoreLockHolders(client) {
  const { rows } = await client.query(
    `select a.pid, pg_terminate_backend(a.pid) as terminated
       from pg_locks l join pg_stat_activity a on a.pid = l.pid
      where ${storeLockPredicate} and l.granted and a.state = 'idle'`
  );
  return rows.map((row) => ({ pid: row.pid, terminated: row.terminated === true }));
}
