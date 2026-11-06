export interface AuthRuntimeConfig {
  passkeysEnabled: boolean;
  passwordFallbackEnabled: boolean;
  sessionRotationEnabled: boolean;
  sessionReuseDetectionEnabled: boolean;
  expectedPasskeyOrigins: ReadonlySet<string>;
}

/** Off until the attesting Android build is out and proven on a real phone. */
export function androidAttestationRequired(): boolean {
  return process.env.ANDROID_KEY_ATTESTATION_REQUIRED === "true";
}

export function readAuthRuntimeConfig(allowedOrigins: Iterable<string>): AuthRuntimeConfig {
  const config: AuthRuntimeConfig = {
    passkeysEnabled: readBoolean("AUTH_PASSKEYS_ENABLED", true),
    passwordFallbackEnabled: readBoolean("AUTH_PASSWORD_FALLBACK_ENABLED", true),
    sessionRotationEnabled: readBoolean("SESSION_ROTATION_ENABLED", true),
    sessionReuseDetectionEnabled: readBoolean("SESSION_REUSE_DETECTION_ENABLED", true),
    expectedPasskeyOrigins: readExpectedOrigins(allowedOrigins)
  };

  const inactivityDays = readInteger("SESSION_INACTIVITY_TTL_DAYS", 30, 1, 90);
  const absoluteDays = readInteger("SESSION_ABSOLUTE_TTL_DAYS", 180, 7, 365);
  readInteger("SESSION_ACCESS_TTL_SECONDS", 900, 60, 86_400);
  if (absoluteDays < inactivityDays) {
    throw new Error("SESSION_ABSOLUTE_TTL_DAYS must be at least SESSION_INACTIVITY_TTL_DAYS.");
  }

  validateCookieConfiguration();
  if (process.env.NODE_ENV === "production") validateProductionConfiguration(config);
  return config;
}

function validateProductionConfiguration(config: AuthRuntimeConfig): void {
  if (!config.sessionRotationEnabled || !config.sessionReuseDetectionEnabled) {
    throw new Error("Production requires refresh-token rotation and reuse detection.");
  }
  for (const name of [
    "OTP_HMAC_SECRET",
    "AUTH_AUDIT_HMAC_SECRET",
    "AUTH_TOKEN_ENCRYPTION_KEY",
    "PIN_HASH_SECRET"
  ]) {
    requireSecret(name);
  }
  if (config.passwordFallbackEnabled) requireSecret("PASSWORD_HASH_SECRET");

  if (config.passkeysEnabled) {
    const rpId = process.env.WEBAUTHN_RP_ID?.trim();
    if (!rpId || !isHostname(rpId)) {
      throw new Error("WEBAUTHN_RP_ID must be a valid hostname when passkeys are enabled.");
    }
    if (config.expectedPasskeyOrigins.size === 0) {
      throw new Error("WEBAUTHN_EXPECTED_ORIGINS must contain at least one HTTPS origin.");
    }
    for (const origin of config.expectedPasskeyOrigins) {
      const url = new URL(origin);
      if (url.protocol !== "https:") {
        throw new Error("Production passkey origins must use HTTPS.");
      }
      if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) {
        throw new Error(`Passkey origin ${origin} is outside WEBAUTHN_RP_ID ${rpId}.`);
      }
    }
  }
}

function validateCookieConfiguration(): void {
  const sameSite = (process.env.COOKIE_SAME_SITE?.trim().toLowerCase() || "lax") as string;
  if (!new Set(["lax", "strict", "none"]).has(sameSite)) {
    throw new Error("COOKIE_SAME_SITE must be lax, strict, or none.");
  }
  const secure =
    readBoolean("COOKIE_SECURE", process.env.NODE_ENV === "production") ||
    readBoolean("SESSION_COOKIE_SECURE", false);
  if (process.env.NODE_ENV === "production" && !secure) {
    throw new Error("Production cookies must be secure.");
  }
  if (sameSite === "none" && !secure) {
    throw new Error("COOKIE_SAME_SITE=none requires COOKIE_SECURE=true.");
  }
  const domain = process.env.COOKIE_DOMAIN?.trim();
  if (domain && (!isHostname(domain.replace(/^\./u, "")) || /[:/]/u.test(domain))) {
    throw new Error("COOKIE_DOMAIN must be a hostname without a scheme, path, or port.");
  }
}

function readExpectedOrigins(fallback: Iterable<string>): ReadonlySet<string> {
  const configured = process.env.WEBAUTHN_EXPECTED_ORIGINS?.trim();
  const values = configured ? configured.split(",") : [...fallback];
  const origins = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const url = new URL(trimmed);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error(`Invalid WebAuthn expected origin: ${trimmed}`);
    }
    origins.add(url.origin);
  }
  return origins;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true or false.`);
}

function readInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function requireSecret(name: string): void {
  if ((process.env[name]?.trim().length ?? 0) < 32) {
    throw new Error(`${name} must contain at least 32 characters in production.`);
  }
}

function isHostname(value: string): boolean {
  return (
    value.length <= 253 &&
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(
      value
    )
  );
}
