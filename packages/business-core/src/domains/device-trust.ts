import { createEvent, type BusinessEvent } from "@grogoni/event-core";
import type { DeviceTrustLevel, DeviceTrustSummary } from "@grogoni/shared-types";
import { invalid, type ValidationResult, valid } from "@grogoni/tool-core";

import {
  normalizeOptionalText,
  normalizeRequiredText,
  nullableText
} from "../shared/text-normalization.js";

export interface DeviceTrustInput {
  deviceId: string;
  level: DeviceTrustLevel;
  reason?: string | null;
}

export interface NormalizedDeviceTrustInput {
  deviceId: string;
  level: DeviceTrustLevel;
  reason: string | null;
}

export function validateDeviceTrustInput(input: DeviceTrustInput): ValidationResult {
  const errors: string[] = [];

  if (normalizeRequiredText(input.deviceId).length < 4) {
    errors.push("Device id must be at least 4 characters.");
  }

  if (normalizeRequiredText(input.deviceId).length > 120) {
    errors.push("Device id must be 120 characters or fewer.");
  }

  if (!isDeviceTrustLevel(input.level)) {
    errors.push("Device trust level is not supported.");
  }

  if (normalizeOptionalText(input.reason).length > 180) {
    errors.push("Device trust reason must be 180 characters or fewer.");
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function normalizeDeviceTrustInput(input: DeviceTrustInput): NormalizedDeviceTrustInput {
  return {
    deviceId: normalizeRequiredText(input.deviceId),
    level: input.level,
    reason: nullableText(input.reason)
  };
}

export function isDeviceTrustLevel(value: string): value is DeviceTrustLevel {
  return value === "unknown" || value === "trusted" || value === "restricted";
}

export function deviceTrustUpdatedEvent(input: {
  id: string;
  deviceTrust: DeviceTrustSummary;
  previousLevel: DeviceTrustLevel;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{
  businessId: string;
  deviceId: string;
  previousLevel: DeviceTrustLevel;
  level: DeviceTrustLevel;
}> {
  return createEvent({
    id: input.id,
    type: "compliance.device_trust_updated",
    aggregateId: `${input.deviceTrust.businessId}:${input.deviceTrust.deviceId}`,
    aggregateType: "device_trust",
    actorId: input.actorId,
    risk: "high",
    occurredAt: input.occurredAt,
    payload: {
      businessId: input.deviceTrust.businessId,
      deviceId: input.deviceTrust.deviceId,
      previousLevel: input.previousLevel,
      level: input.deviceTrust.level
    }
  });
}
