export function integerFromEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
  environment: NodeJS.ProcessEnv = process.env
): number {
  const raw = environment[name]?.trim() ?? "";
  if (raw === "") return fallback;
  const value = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= min && value <= max))
    throw new Error(`${name} must be a decimal integer from ${min} to ${max}.`);
  return value;
}

export function readDaemonNetworkConfig(environment: NodeJS.ProcessEnv = process.env) {
  return {
    port: environment.DAEMON_PORT?.trim()
      ? integerFromEnv("DAEMON_PORT", 42700, 1, 65535, environment)
      : integerFromEnv("PORT", 42700, 1, 65535, environment),
    host: environment.DAEMON_HOST?.trim() || "127.0.0.1",
    pollMs: integerFromEnv("DAEMON_POLL_MS", 1000, 250, 60_000, environment)
  };
}
