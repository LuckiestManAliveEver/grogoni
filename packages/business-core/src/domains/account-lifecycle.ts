import { createEvent, type BusinessEvent } from "@grogoni/event-core";
import type { AccountDeletionRequestSummary, DataExportBundleSummary } from "@grogoni/shared-types";
import { invalid, type ValidationResult, valid } from "@grogoni/tool-core";

import { normalizeOptionalText, nullableText } from "../shared/text-normalization.js";

export interface AccountDeletionInput {
  confirmation: string;
  reason?: string | null;
}

export interface NormalizedAccountDeletionInput {
  reason: string | null;
}

export function validateAccountDeletionInput(input: AccountDeletionInput): ValidationResult {
  const errors: string[] = [];

  if (input.confirmation.trim() !== "DELETE") {
    errors.push("Account deletion requires DELETE confirmation.");
  }

  if (normalizeOptionalText(input.reason).length > 240) {
    errors.push("Account deletion reason must be 240 characters or fewer.");
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function normalizeAccountDeletionInput(
  input: AccountDeletionInput
): NormalizedAccountDeletionInput {
  return {
    reason: nullableText(input.reason)
  };
}

export function dataExportCreatedEvent(input: {
  id: string;
  exportBundle: DataExportBundleSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{
  businessId: string;
  exportId: string;
  recordCounts: Record<string, number>;
  checksum: string;
}> {
  return createEvent({
    id: input.id,
    type: "compliance.data_export_created",
    aggregateId: input.exportBundle.id,
    aggregateType: "data_export",
    actorId: input.actorId,
    risk: "high",
    occurredAt: input.occurredAt,
    payload: {
      businessId: input.exportBundle.businessId,
      exportId: input.exportBundle.id,
      recordCounts: input.exportBundle.recordCounts,
      checksum: input.exportBundle.checksum
    }
  });
}

export function accountDeletionScheduledEvent(input: {
  id: string;
  deletionRequest: AccountDeletionRequestSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{
  businessId: string;
  deletionRequestId: string;
  status: AccountDeletionRequestSummary["status"];
  anonymizeAfter: string;
  retention: AccountDeletionRequestSummary["retention"];
}> {
  return createEvent({
    id: input.id,
    type: "compliance.account_deletion_scheduled",
    aggregateId: input.deletionRequest.id,
    aggregateType: "account_deletion",
    actorId: input.actorId,
    risk: "critical",
    occurredAt: input.occurredAt,
    payload: {
      businessId: input.deletionRequest.businessId,
      deletionRequestId: input.deletionRequest.id,
      status: input.deletionRequest.status,
      anonymizeAfter: input.deletionRequest.anonymizeAfter,
      retention: input.deletionRequest.retention
    }
  });
}
