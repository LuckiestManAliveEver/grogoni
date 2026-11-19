interface StoreClient {
  query: (sql: string) => Promise<unknown>;
}

// Full-snapshot jobs use the exclusive form of this same advisory lock.
export const storeCoordinationSql =
  "select pg_advisory_xact_lock_shared(hashtext('grogoni.cp2.normalized_store'))";

export async function coordinateStoreRequest(client: StoreClient) {
  await client.query(storeCoordinationSql);
}
