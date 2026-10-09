interface DatabaseClient {
  connect(): Promise<void>;
  end(): Promise<void>;
}

export async function connectDatabase<T extends DatabaseClient>(createClient: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = createClient();
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      const code =
        typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      const transient =
        [
          "ETIMEDOUT",
          "ECONNRESET",
          "ECONNREFUSED",
          "EPIPE",
          "ENOTFOUND",
          "EAI_AGAIN",
          "57P03",
          "53300"
        ].includes(code) ||
        (error instanceof Error && /timeout|timed out|connection terminated/i.test(error.message));
      // Only establishment is retried. No BEGIN or application operation has run yet.
      if (attempt >= 1 || !transient) throw error;
    }
  }
}
