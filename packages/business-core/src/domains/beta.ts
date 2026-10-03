import { createEvent, type BusinessEvent } from "@grogoni/event-core";
import type {
  BetaAccessStatus,
  BetaAccessSummary,
  BetaDeviceClass,
  BetaDeviceTestStatus,
  BetaDeviceTestSummary,
  BetaFeatureFlagKey,
  BetaFeatureFlagRisk,
  BetaFeatureFlagSummary,
  BetaSupportSeverity,
  BetaSupportTicketStatus,
  BetaSupportTicketSummary,
  BetaTelemetryEventSummary,
  BetaTelemetryKind
} from "@grogoni/shared-types";
import { invalid, type ValidationResult, valid } from "@grogoni/tool-core";

import {
  normalizeOptionalText,
  normalizeRequiredText,
  nullableText
} from "../shared/text-normalization.js";

export interface BetaAccessInput {
  status: BetaAccessStatus;
  invitedMerchantCount?: number;
  pauseReason?: string | null;
}

export interface BetaFeatureFlagInput {
  enabled: boolean;
  reason?: string | null;
}

export interface BetaDeviceTestInput {
  deviceClass: BetaDeviceClass;
  workflow: string;
  status: BetaDeviceTestStatus;
  durationMs: number;
  notes?: string | null;
}

export interface BetaSupportTicketInput {
  severity: BetaSupportSeverity;
  title: string;
  body?: string | null;
  source?: "merchant" | "operator";
}

export interface BetaSupportTicketStatusInput {
  status: BetaSupportTicketStatus;
}

export interface BetaTelemetryInput {
  kind: BetaTelemetryKind;
  message?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface NormalizedBetaAccessInput {
  status: BetaAccessStatus;
  invitedMerchantCount: number;
  pauseReason: string | null;
}

export interface NormalizedBetaFeatureFlagInput {
  enabled: boolean;
  reason: string;
}

export interface NormalizedBetaDeviceTestInput {
  deviceClass: BetaDeviceClass;
  workflow: string;
  status: BetaDeviceTestStatus;
  durationMs: number;
  notes: string | null;
}

export interface NormalizedBetaSupportTicketInput {
  severity: BetaSupportSeverity;
  title: string;
  bodySummary: string;
  source: "merchant" | "operator";
}

export interface NormalizedBetaSupportTicketStatusInput {
  status: BetaSupportTicketStatus;
}

export interface NormalizedBetaTelemetryInput {
  kind: BetaTelemetryKind;
  message: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

export function validateBetaAccessInput(input: BetaAccessInput): ValidationResult {
  const errors: string[] = [];

  if (!isBetaAccessStatus(input.status)) {
    errors.push("Beta access status is not supported.");
  }

  if (
    input.invitedMerchantCount !== undefined &&
    (!Number.isInteger(input.invitedMerchantCount) ||
      input.invitedMerchantCount < 0 ||
      input.invitedMerchantCount > 10)
  ) {
    errors.push("Invited beta merchant count must be an integer between 0 and 10.");
  }

  if (normalizeOptionalText(input.pauseReason).length > 180) {
    errors.push("Beta pause reason must be 180 characters or fewer.");
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function validateBetaFeatureFlagInput(input: BetaFeatureFlagInput): ValidationResult {
  const errors: string[] = [];

  if (typeof input.enabled !== "boolean") {
    errors.push("Beta feature flag enabled state is required.");
  }

  if (normalizeOptionalText(input.reason).length > 180) {
    errors.push("Beta feature flag reason must be 180 characters or fewer.");
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function validateBetaDeviceTestInput(input: BetaDeviceTestInput): ValidationResult {
  const errors: string[] = [];

  if (!isBetaDeviceClass(input.deviceClass)) {
    errors.push("Beta device class is not supported.");
  }

  if (normalizeRequiredText(input.workflow).length < 3) {
    errors.push("Beta device workflow is required.");
  }

  if (normalizeRequiredText(input.workflow).length > 80) {
    errors.push("Beta device workflow must be 80 characters or fewer.");
  }

  if (!isBetaDeviceTestStatus(input.status)) {
    errors.push("Beta device test status is not supported.");
  }

  if (!Number.isFinite(input.durationMs) || input.durationMs < 0 || input.durationMs > 600_000) {
    errors.push("Beta device test duration must be between 0 and 600000 ms.");
  }

  if (normalizeOptionalText(input.notes).length > 180) {
    errors.push("Beta device test notes must be 180 characters or fewer.");
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function validateBetaSupportTicketInput(input: BetaSupportTicketInput): ValidationResult {
  const errors: string[] = [];

  if (!isBetaSupportSeverity(input.severity)) {
    errors.push("Beta support severity is not supported.");
  }

  if (normalizeRequiredText(input.title).length < 3) {
    errors.push("Beta support title is required.");
  }

  if (normalizeRequiredText(input.title).length > 100) {
    errors.push("Beta support title must be 100 characters or fewer.");
  }

  if (normalizeOptionalText(input.body).length > 500) {
    errors.push("Beta support body must be 500 characters or fewer.");
  }

  if (input.source !== undefined && input.source !== "merchant" && input.source !== "operator") {
    errors.push("Beta support source is not supported.");
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function validateBetaSupportTicketStatusInput(
  input: BetaSupportTicketStatusInput
): ValidationResult {
  return isBetaSupportTicketStatus(input.status)
    ? valid()
    : invalid("Beta support ticket status is not supported.");
}

export function validateBetaTelemetryInput(input: BetaTelemetryInput): ValidationResult {
  const errors: string[] = [];

  if (!isBetaTelemetryKind(input.kind)) {
    errors.push("Beta telemetry kind is not supported.");
  }

  if (normalizeOptionalText(input.message).length > 300) {
    errors.push("Beta telemetry message must be 300 characters or fewer.");
  }

  const metadata = input.metadata ?? {};
  const entries = Object.entries(metadata);

  if (entries.length > 12) {
    errors.push("Beta telemetry metadata can include 12 fields or fewer.");
  }

  for (const [key, value] of entries) {
    if (normalizeRequiredText(key).length === 0 || key.length > 40) {
      errors.push("Beta telemetry metadata keys must be 40 characters or fewer.");
    }

    if (value !== null && typeof value === "string" && value.length > 80) {
      errors.push("Beta telemetry string metadata values must be 80 characters or fewer.");
    }
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function normalizeBetaAccessInput(input: BetaAccessInput): NormalizedBetaAccessInput {
  return {
    status: input.status,
    invitedMerchantCount: input.invitedMerchantCount ?? (input.status === "not_invited" ? 0 : 1),
    pauseReason: input.status === "paused" ? nullableText(input.pauseReason) : null
  };
}

export function normalizeBetaFeatureFlagInput(
  input: BetaFeatureFlagInput
): NormalizedBetaFeatureFlagInput {
  return {
    enabled: input.enabled,
    reason: normalizeOptionalText(input.reason) || "Updated for closed beta hardening."
  };
}

export function normalizeBetaDeviceTestInput(
  input: BetaDeviceTestInput
): NormalizedBetaDeviceTestInput {
  return {
    deviceClass: input.deviceClass,
    workflow: normalizeRequiredText(input.workflow),
    status: input.status,
    durationMs: Math.round(input.durationMs),
    notes: nullableText(input.notes)
  };
}

export function normalizeBetaSupportTicketInput(
  input: BetaSupportTicketInput
): NormalizedBetaSupportTicketInput {
  const body = normalizeOptionalText(input.body);

  return {
    severity: input.severity,
    title: normalizeRequiredText(input.title),
    bodySummary:
      body.length === 0
        ? "No details provided."
        : body.length <= 120
          ? body
          : `${body.slice(0, 117)}...`,
    source: input.source ?? "merchant"
  };
}

export function normalizeBetaSupportTicketStatusInput(
  input: BetaSupportTicketStatusInput
): NormalizedBetaSupportTicketStatusInput {
  return {
    status: input.status
  };
}

export function normalizeBetaTelemetryInput(
  input: BetaTelemetryInput
): NormalizedBetaTelemetryInput {
  const metadata = Object.fromEntries(
    Object.entries(input.metadata ?? {}).map(([key, value]) => [
      normalizeRequiredText(key),
      typeof value === "string" ? normalizeOptionalText(value) : value
    ])
  );

  return {
    kind: input.kind,
    message: nullableText(input.message),
    metadata
  };
}

export function isBetaAccessStatus(value: string): value is BetaAccessStatus {
  return value === "not_invited" || value === "active" || value === "paused";
}

export function isBetaFeatureFlagKey(value: string): value is BetaFeatureFlagKey {
  return (
    value === "closed_beta" ||
    value === "offline_hardening" ||
    value === "controlled_payments" ||
    value === "support_intake" ||
    value === "crash_telemetry"
  );
}

export function betaFeatureFlagRisk(key: BetaFeatureFlagKey): BetaFeatureFlagRisk {
  return key === "controlled_payments" ? "high" : key === "closed_beta" ? "medium" : "low";
}

export function isBetaDeviceClass(value: string): value is BetaDeviceClass {
  return value === "android_1gb" || value === "android_2gb";
}

export function isBetaDeviceTestStatus(value: string): value is BetaDeviceTestStatus {
  return value === "passed" || value === "failed";
}

export function isBetaSupportSeverity(value: string): value is BetaSupportSeverity {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

export function isBetaSupportTicketStatus(value: string): value is BetaSupportTicketStatus {
  return value === "open" || value === "triaged" || value === "resolved";
}

export function isBetaTelemetryKind(value: string): value is BetaTelemetryKind {
  return value === "session" || value === "crash" || value === "error";
}

export function betaAccessUpdatedEvent(input: {
  id: string;
  access: BetaAccessSummary;
  previousStatus: BetaAccessStatus;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{
  businessId: string;
  previousStatus: BetaAccessStatus;
  status: BetaAccessStatus;
  invitedMerchantCount: number;
}> {
  return createEvent({
    id: input.id,
    type: "beta.access_updated",
    aggregateId: input.access.businessId,
    aggregateType: "beta_access",
    actorId: input.actorId,
    risk: "high",
    occurredAt: input.occurredAt,
    payload: {
      businessId: input.access.businessId,
      previousStatus: input.previousStatus,
      status: input.access.status,
      invitedMerchantCount: input.access.invitedMerchantCount
    }
  });
}

export function betaFeatureFlagUpdatedEvent(input: {
  id: string;
  featureFlag: BetaFeatureFlagSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{
  businessId: string;
  key: BetaFeatureFlagKey;
  enabled: boolean;
  risk: BetaFeatureFlagRisk;
}> {
  return createEvent({
    id: input.id,
    type: "beta.feature_flag_updated",
    aggregateId: `${input.featureFlag.businessId}:${input.featureFlag.key}`,
    aggregateType: "beta_feature_flag",
    actorId: input.actorId,
    risk: input.featureFlag.risk,
    occurredAt: input.occurredAt,
    payload: {
      businessId: input.featureFlag.businessId,
      key: input.featureFlag.key,
      enabled: input.featureFlag.enabled,
      risk: input.featureFlag.risk
    }
  });
}

export function betaDeviceTestRecordedEvent(input: {
  id: string;
  deviceTest: BetaDeviceTestSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{
  businessId: string;
  deviceTestId: string;
  deviceClass: BetaDeviceClass;
  workflow: string;
  status: BetaDeviceTestStatus;
  durationMs: number;
}> {
  return createEvent({
    id: input.id,
    type: "beta.device_test_recorded",
    aggregateId: input.deviceTest.id,
    aggregateType: "beta_device_test",
    actorId: input.actorId,
    risk: "medium",
    occurredAt: input.occurredAt,
    payload: {
      businessId: input.deviceTest.businessId,
      deviceTestId: input.deviceTest.id,
      deviceClass: input.deviceTest.deviceClass,
      workflow: input.deviceTest.workflow,
      status: input.deviceTest.status,
      durationMs: input.deviceTest.durationMs
    }
  });
}

export function betaSupportTicketCreatedEvent(input: {
  id: string;
  ticket: BetaSupportTicketSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{
  businessId: string;
  supportTicketId: string;
  severity: BetaSupportSeverity;
  status: BetaSupportTicketStatus;
  titleLength: number;
  bodySummaryLength: number;
}> {
  return createEvent({
    id: input.id,
    type: "beta.support_ticket_created",
    aggregateId: input.ticket.id,
    aggregateType: "beta_support_ticket",
    actorId: input.actorId,
    risk: input.ticket.severity === "critical" ? "high" : "medium",
    occurredAt: input.occurredAt,
    payload: {
      businessId: input.ticket.businessId,
      supportTicketId: input.ticket.id,
      severity: input.ticket.severity,
      status: input.ticket.status,
      titleLength: input.ticket.title.length,
      bodySummaryLength: input.ticket.bodySummary.length
    }
  });
}

export function betaSupportTicketStatusUpdatedEvent(input: {
  id: string;
  ticket: BetaSupportTicketSummary;
  previousStatus: BetaSupportTicketStatus;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{
  businessId: string;
  supportTicketId: string;
  previousStatus: BetaSupportTicketStatus;
  status: BetaSupportTicketStatus;
  severity: BetaSupportSeverity;
}> {
  return createEvent({
    id: input.id,
    type: "beta.support_ticket_status_updated",
    aggregateId: input.ticket.id,
    aggregateType: "beta_support_ticket",
    actorId: input.actorId,
    risk: input.ticket.severity === "critical" ? "high" : "medium",
    occurredAt: input.occurredAt,
    payload: {
      businessId: input.ticket.businessId,
      supportTicketId: input.ticket.id,
      previousStatus: input.previousStatus,
      status: input.ticket.status,
      severity: input.ticket.severity
    }
  });
}

export function betaTelemetryRecordedEvent(input: {
  id: string;
  telemetry: BetaTelemetryEventSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{
  businessId: string;
  telemetryId: string;
  kind: BetaTelemetryKind;
  severity: BetaTelemetryEventSummary["severity"];
  fingerprint: string;
  metadataFieldCount: number;
}> {
  return createEvent({
    id: input.id,
    type: "beta.telemetry_recorded",
    aggregateId: input.telemetry.id,
    aggregateType: "beta_telemetry",
    actorId: input.actorId,
    risk: input.telemetry.severity === "critical" ? "medium" : "low",
    occurredAt: input.occurredAt,
    payload: {
      businessId: input.telemetry.businessId,
      telemetryId: input.telemetry.id,
      kind: input.telemetry.kind,
      severity: input.telemetry.severity,
      fingerprint: input.telemetry.fingerprint,
      metadataFieldCount: Object.keys(input.telemetry.boundedMetadata).length
    }
  });
}
