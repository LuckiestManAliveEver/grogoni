import {
  repositoryDefaultRuntimePolicy,
  type EnvironmentConfig,
  type ModelExecutionTarget
} from "@grogoni/shared-types";

export function shouldInitializeOllama(
  executionTarget: ModelExecutionTarget,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    env.NODE_ENV !== "production" ||
    executionTarget === "local" ||
    Boolean(env.OLLAMA_BASE_URL?.trim())
  );
}

export function readEnvironment(): EnvironmentConfig {
  const runtimeMode = runtimeModeFromEnv();
  rejectRemovedCloudConfiguration();
  const inferenceRequired = booleanFromEnv("INFERENCE_REQUIRED", false);
  const metricsAuthToken = stringFromEnv("METRICS_AUTH_TOKEN", "").trim();
  if (metricsAuthToken !== "" && metricsAuthToken.length < 32) {
    throw new Error("METRICS_AUTH_TOKEN must contain at least 32 characters.");
  }

  return {
    runtimeMode,
    apiHost: stringFromEnv("API_HOST", "127.0.0.1"),
    apiPort: numberFromEnvList(["API_PORT", "PORT"], 4000),
    allowedCorsOrigins: stringListFromEnv("WEB_ORIGINS", [
      "http://127.0.0.1:5173",
      "http://localhost:5173"
    ]),
    databaseUrl: stringFromEnv(
      "DATABASE_URL",
      "postgres://grogoni:grogoni_dev_password@127.0.0.1:5432/grogoni_market"
    ),
    inferenceRequired,
    inferenceTimeoutMs: numberFromEnv("LOCAL_INFERENCE_TIMEOUT_MS", 300_000),
    inferenceOwnerNodeEnabled: booleanFromEnv("INFERENCE_OWNER_NODE_ENABLED", false),
    inferenceMaxFallbacks: numberFromEnv("INFERENCE_MAX_FALLBACKS", 2),
    inferenceJobTimeoutMs: numberFromEnv("INFERENCE_JOB_TIMEOUT_MS", 120_000),
    workspaceDeliveryMaxFileBytes: numberFromEnv("WORKSPACE_DELIVERY_MAX_FILE_BYTES", 10_000_000),
    workspaceRoot: stringFromEnv("GROGONI_WORKSPACE_ROOT", "").trim(),
    redisUrl: readRedisUrl(),
    localCacheMode: localCacheModeFromEnv(),
    localInferenceProvider: "ollama",
    ollamaBaseUrl: normalizeBaseUrl(
      stringFromEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").trim(),
      "OLLAMA_BASE_URL"
    ),
    ollamaModel: stringFromEnv("OLLAMA_MODEL", "smollm2:360m").trim(),
    metricsAuthToken,
    platformDefaultRuntime: {
      agentId: portableIdFromEnv(
        "PLATFORM_DEFAULT_AGENT_ID",
        repositoryDefaultRuntimePolicy.agentId
      ),
      agentName: stringFromEnv(
        "PLATFORM_DEFAULT_AGENT_NAME",
        repositoryDefaultRuntimePolicy.agentName
      ).trim(),
      agentRuntimeAdapterId: portableIdFromEnv(
        "PLATFORM_DEFAULT_AGENT_ADAPTER_ID",
        repositoryDefaultRuntimePolicy.agentRuntimeAdapterId
      ),
      modelId: portableIdFromEnv(
        "PLATFORM_DEFAULT_MODEL_ID",
        repositoryDefaultRuntimePolicy.modelId
      ),
      executionTarget: executionTargetFromEnv(
        "PLATFORM_DEFAULT_EXECUTION_TARGET",
        repositoryDefaultRuntimePolicy.executionTarget
      )
    }
  };
}

function rejectRemovedCloudConfiguration(): void {
  const removed = [
    "VERCEL_INFERENCE_URL",
    "VERCEL_INFERENCE_TIMEOUT_MS",
    "GROGONI_INFERENCE_SERVICE_TOKEN",
    "NEON_MODEL_STORAGE_ENDPOINT",
    "NEON_MODEL_STORAGE_REGION",
    "NEON_MODEL_STORAGE_ACCESS_KEY_ID",
    "NEON_MODEL_STORAGE_SECRET_ACCESS_KEY",
    "MODEL_ARTIFACT_URL_TTL_SECONDS",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ZAI_API_KEY",
    "ZAI_BASE_URL",
    "ZAI_CODING_API_KEY",
    "ZAI_CODING_BASE_URL",
    "GROGONI_LLAMA_BASE_URL",
    "GROGONI_LLAMA_API_KEY",
    "INFERENCE_CREDENTIAL_KEYS",
    "HF_TOKEN",
    "HUGGINGFACE_TOKEN",
    "ZEROCLAW_GATEWAY_URL",
    "ZEROCLAW_GATEWAY_TOKEN",
    "ZEROCLAW_WEBHOOK_SECRET",
    "COMPUTER_RUNTIME_URL",
    "COMPUTER_RUNTIME_SERVICE_TOKEN",
    "REDIS_URL",
    "RENDER_DEPLOY_WEBHOOK_SECRET",
    "RESEND_API_KEY",
    "SMTP_URL",
    "TELEGRAM_BOT_TOKEN",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "OCR_WORKER_URL",
    "LOCAL_OCR_URL",
    "LOCAL_OCR_ENABLED",
    "OCR_MODE"
  ].filter((name) => (process.env[name]?.trim() ?? "") !== "");
  if (removed.length > 0) {
    throw new Error(
      `Cloud runtime configuration is no longer supported. Remove: ${removed.join(", ")}.`
    );
  }
}

function runtimeModeFromEnv(): EnvironmentConfig["runtimeMode"] {
  const configured = stringFromEnv("GROGONI_RUNTIME_MODE", "").trim();
  const fallback =
    process.env.NODE_ENV === "test"
      ? "test"
      : process.env.NODE_ENV === "production"
        ? "production"
        : "local";
  const value = configured === "" ? fallback : configured;
  if (value === "local" || value === "production" || value === "test") return value;
  throw new Error("GROGONI_RUNTIME_MODE must be local, production, or test.");
}

function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function numberFromEnvList(names: string[], fallback: number): number {
  const configured = names.find((name) => (process.env[name]?.trim() ?? "") !== "");
  return configured === undefined ? fallback : numberFromEnv(configured, fallback);
}

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be true or false.`);
}

function stringFromEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value;
}

function stringListFromEnv(name: string, fallback: string[]): string[] {
  const values = (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length === 0 ? fallback : values;
}

function localCacheModeFromEnv(): "memory" {
  const value = stringFromEnv("LOCAL_CACHE_MODE", "memory").trim().toLowerCase();
  if (value === "memory") return value;
  throw new Error("LOCAL_CACHE_MODE must be memory.");
}

function portableIdFromEnv(name: string, fallback: string): string {
  const value = stringFromEnv(name, fallback).trim();
  if (!/^[a-z0-9][a-z0-9:._-]{0,199}$/u.test(value))
    throw new Error(`${name} must be a portable lowercase identifier.`);
  return value;
}

function executionTargetFromEnv(
  name: string,
  fallback: ModelExecutionTarget
): ModelExecutionTarget {
  const value = stringFromEnv(name, fallback).trim();
  if (["local", "vercel", "backend", "remote-shop-device"].includes(value))
    return value as ModelExecutionTarget;
  throw new Error(`${name} is not a supported model execution target.`);
}

function normalizeBaseUrl(value: string, name: string): string {
  const url = new URL(value);
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${name} must not include credentials.`);
  }
  return url.toString().replace(/\/+$/u, "");
}

function readRedisUrl(): string {
  return "redis://127.0.0.1:6379";
}
