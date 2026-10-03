import type { BetaFeatureFlagKey, LaunchChecklistKey } from "@grogoni/shared-types";

export function deviceTrustKey(businessId: string, userId: string, deviceId: string): string {
  return `${businessId}:${userId}:${deviceId}`;
}

export function betaFeatureFlagMapKey(businessId: string, key: BetaFeatureFlagKey): string {
  return `${businessId}:${key}`;
}

export function launchChecklistMapKey(businessId: string, key: LaunchChecklistKey): string {
  return `${businessId}:${key}`;
}

export const betaFeatureFlagKeys: BetaFeatureFlagKey[] = [
  "closed_beta",
  "offline_hardening",
  "controlled_payments",
  "support_intake",
  "crash_telemetry"
];

export const launchChecklistKeys: LaunchChecklistKey[] = [
  "environment_config",
  "secrets_ready",
  "backup_verified",
  "monitoring_ready",
  "deploy_verified",
  "rollback_runbook",
  "support_coverage"
];
