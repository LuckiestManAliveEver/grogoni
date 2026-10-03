import { createEvent, type BusinessEvent } from "@grogoni/event-core";
import type {
  LaunchAccessStatus,
  LaunchChecklistItemSummary,
  LaunchChecklistKey,
  LaunchChecklistStatus,
  LaunchIncidentCategory,
  LaunchIncidentSeverity,
  LaunchIncidentStatus,
  LaunchIncidentSummary,
  LaunchSettingsSummary
} from "@grogoni/shared-types";
import { invalid, type ValidationResult, valid } from "@grogoni/tool-core";

import {
  normalizeOptionalText,
  normalizeRequiredText,
  nullableText
} from "../shared/text-normalization.js";

export interface LaunchSettingsInput {
  status: LaunchAccessStatus;
  publicOnboardingEnabled?: boolean;
  rollbackArmed?: boolean;
  freezeActive?: boolean;
  allowedSignupCount?: number;
  pauseReason?: string | null;
}

export interface LaunchChecklistInput {
  key: LaunchChecklistKey;
  status: LaunchChecklistStatus;
  evidence?: string | null;
}

export interface LaunchIncidentInput {
  severity: LaunchIncidentSeverity;
  category: LaunchIncidentCategory;
  title: string;
  body?: string | null;
}

export interface LaunchIncidentStatusInput {
  status: LaunchIncidentStatus;
}

export interface NormalizedLaunchSettingsInput {
  status: LaunchAccessStatus;
  publicOnboardingEnabled: boolean;
  rollbackArmed: boolean;
  freezeActive: boolean;
  allowedSignupCount: number;
  pauseReason: string | null;
}

export interface NormalizedLaunchChecklistInput {
  key: LaunchChecklistKey;
  status: LaunchChecklistStatus;
  evidence: string;
}

export interface NormalizedLaunchIncidentInput {
  severity: LaunchIncidentSeverity;
  category: LaunchIncidentCategory;
  title: string;
  bodySummary: string;
}

export interface NormalizedLaunchIncidentStatusInput {
  status: LaunchIncidentStatus;
}

export function validateLaunchSettingsInput(input: LaunchSettingsInput): ValidationResult {
  const errors: string[] = [];

  if (!isLaunchAccessStatus(input.status)) {
    errors.push("Launch access status is not supported.");
  }

  if (
    input.allowedSignupCount !== undefined &&
    (!Number.isInteger(input.allowedSignupCount) ||
      input.allowedSignupCount < 0 ||
      input.allowedSignupCount > 100_000)
  ) {
    errors.push("Launch allowed signup count must be an integer between 0 and 100000.");
  }

  if (normalizeOptionalText(input.pauseReason).length > 180) {
    errors.push("Launch pause reason must be 180 characters or fewer.");
  }

  if (input.status === "open" && input.publicOnboardingEnabled === false) {
    errors.push("Open launch status requires public onboarding to be enabled.");
  }

  if (input.status === "open" && input.freezeActive === true) {
    errors.push("Open launch status cannot be used while launch freeze is active.");
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function validateLaunchChecklistInput(input: LaunchChecklistInput): ValidationResult {
  const errors: string[] = [];

  if (!isLaunchChecklistKey(input.key)) {
    errors.push("Launch checklist key is not supported.");
  }

  if (!isLaunchChecklistStatus(input.status)) {
    errors.push("Launch checklist status is not supported.");
  }

  if (normalizeOptionalText(input.evidence).length > 180) {
    errors.push("Launch checklist evidence must be 180 characters or fewer.");
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function validateLaunchIncidentInput(input: LaunchIncidentInput): ValidationResult {
  const errors: string[] = [];

  if (!isLaunchIncidentSeverity(input.severity)) {
    errors.push("Launch incident severity is not supported.");
  }

  if (!isLaunchIncidentCategory(input.category)) {
    errors.push("Launch incident category is not supported.");
  }

  if (normalizeRequiredText(input.title).length < 3) {
    errors.push("Launch incident title is required.");
  }

  if (normalizeRequiredText(input.title).length > 100) {
    errors.push("Launch incident title must be 100 characters or fewer.");
  }

  if (normalizeOptionalText(input.body).length > 500) {
    errors.push("Launch incident body must be 500 characters or fewer.");
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function validateLaunchIncidentStatusInput(
  input: LaunchIncidentStatusInput
): ValidationResult {
  return isLaunchIncidentStatus(input.status)
    ? valid()
    : invalid("Launch incident status is not supported.");
}

export function normalizeLaunchSettingsInput(
  input: LaunchSettingsInput
): NormalizedLaunchSettingsInput {
  return {
    status: input.status,
    publicOnboardingEnabled: input.publicOnboardingEnabled ?? input.status === "open",
    rollbackArmed: input.rollbackArmed ?? true,
    freezeActive: input.freezeActive ?? input.status !== "open",
    allowedSignupCount: input.allowedSignupCount ?? (input.status === "open" ? 1 : 0),
    pauseReason:
      input.status === "paused" || input.status === "closed"
        ? nullableText(input.pauseReason)
        : null
  };
}

export function normalizeLaunchChecklistInput(
  input: LaunchChecklistInput
): NormalizedLaunchChecklistInput {
  return {
    key: input.key,
    status: input.status,
    evidence: normalizeOptionalText(input.evidence) || "Launch checklist item reviewed."
  };
}

export function normalizeLaunchIncidentInput(
  input: LaunchIncidentInput
): NormalizedLaunchIncidentInput {
  const body = normalizeOptionalText(input.body);

  return {
    severity: input.severity,
    category: input.category,
    title: normalizeRequiredText(input.title),
    bodySummary:
      body.length === 0
        ? "No details provided."
        : body.length <= 120
          ? body
          : `${body.slice(0, 117)}...`
  };
}

export function normalizeLaunchIncidentStatusInput(
  input: LaunchIncidentStatusInput
): NormalizedLaunchIncidentStatusInput {
  return {
    status: input.status
  };
}

export function isLaunchAccessStatus(value: string): value is LaunchAccessStatus {
  return value === "closed" || value === "open" || value === "paused";
}

export function isLaunchChecklistKey(value: string): value is LaunchChecklistKey {
  return (
    value === "environment_config" ||
    value === "secrets_ready" ||
    value === "backup_verified" ||
    value === "monitoring_ready" ||
    value === "deploy_verified" ||
    value === "rollback_runbook" ||
    value === "support_coverage"
  );
}

export function isLaunchChecklistStatus(value: string): value is LaunchChecklistStatus {
  return value === "pending" || value === "passed" || value === "failed";
}

export function isLaunchIncidentSeverity(value: string): value is LaunchIncidentSeverity {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

export function isLaunchIncidentCategory(value: string): value is LaunchIncidentCategory {
  return (
    value === "onboarding" ||
    value === "payments" ||
    value === "sync" ||
    value === "support" ||
    value === "telemetry" ||
    value === "rollback"
  );
}

export function isLaunchIncidentStatus(value: string): value is LaunchIncidentStatus {
  return value === "open" || value === "mitigating" || value === "resolved";
}

export function launchSettingsUpdatedEvent(input: {
  id: string;
  settings: LaunchSettingsSummary;
  previousStatus: LaunchAccessStatus;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{
  businessId: string;
  previousStatus: LaunchAccessStatus;
  status: LaunchAccessStatus;
  publicOnboardingEnabled: boolean;
  rollbackArmed: boolean;
  freezeActive: boolean;
  allowedSignupCount: number;
}> {
  return createEvent({
    id: input.id,
    type: "launch.settings_updated",
    aggregateId: input.settings.businessId,
    aggregateType: "launch_settings",
    actorId: input.actorId,
    risk: input.settings.status === "open" ? "critical" : "high",
    occurredAt: input.occurredAt,
    payload: {
      businessId: input.settings.businessId,
      previousStatus: input.previousStatus,
      status: input.settings.status,
      publicOnboardingEnabled: input.settings.publicOnboardingEnabled,
      rollbackArmed: input.settings.rollbackArmed,
      freezeActive: input.settings.freezeActive,
      allowedSignupCount: input.settings.allowedSignupCount
    }
  });
}

export function launchChecklistUpdatedEvent(input: {
  id: string;
  item: LaunchChecklistItemSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{
  businessId: string;
  key: LaunchChecklistKey;
  status: LaunchChecklistStatus;
  evidenceLength: number;
}> {
  return createEvent({
    id: input.id,
    type: "launch.checklist_updated",
    aggregateId: `${input.item.businessId}:${input.item.key}`,
    aggregateType: "launch_checklist",
    actorId: input.actorId,
    risk: input.item.status === "failed" ? "high" : "medium",
    occurredAt: input.occurredAt,
    payload: {
      businessId: input.item.businessId,
      key: input.item.key,
      status: input.item.status,
      evidenceLength: input.item.evidence.length
    }
  });
}

export function launchIncidentCreatedEvent(input: {
  id: string;
  incident: LaunchIncidentSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{
  businessId: string;
  incidentId: string;
  severity: LaunchIncidentSeverity;
  status: LaunchIncidentStatus;
  category: LaunchIncidentCategory;
  titleLength: number;
  bodySummaryLength: number;
}> {
  return createEvent({
    id: input.id,
    type: "launch.incident_created",
    aggregateId: input.incident.id,
    aggregateType: "launch_incident",
    actorId: input.actorId,
    risk: input.incident.severity === "critical" ? "critical" : "high",
    occurredAt: input.occurredAt,
    payload: {
      businessId: input.incident.businessId,
      incidentId: input.incident.id,
      severity: input.incident.severity,
      status: input.incident.status,
      category: input.incident.category,
      titleLength: input.incident.title.length,
      bodySummaryLength: input.incident.bodySummary.length
    }
  });
}

export function launchIncidentStatusUpdatedEvent(input: {
  id: string;
  incident: LaunchIncidentSummary;
  previousStatus: LaunchIncidentStatus;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{
  businessId: string;
  incidentId: string;
  previousStatus: LaunchIncidentStatus;
  status: LaunchIncidentStatus;
  severity: LaunchIncidentSeverity;
}> {
  return createEvent({
    id: input.id,
    type: "launch.incident_status_updated",
    aggregateId: input.incident.id,
    aggregateType: "launch_incident",
    actorId: input.actorId,
    risk: input.incident.severity === "critical" ? "critical" : "high",
    occurredAt: input.occurredAt,
    payload: {
      businessId: input.incident.businessId,
      incidentId: input.incident.id,
      previousStatus: input.previousStatus,
      status: input.incident.status,
      severity: input.incident.severity
    }
  });
}
