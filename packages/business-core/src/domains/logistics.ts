import { createEvent, type BusinessEvent } from "@grogoni/event-core";
import type { FulfillmentMethod, FulfillmentStatus, LogisticsSummary } from "@grogoni/shared-types";
import { invalid, type ValidationResult, valid } from "@grogoni/tool-core";

import {
  normalizeOptionalText,
  normalizeRequiredText,
  nullableText
} from "../shared/text-normalization.js";

export interface LogisticsInput {
  invoiceId: string;
  method: FulfillmentMethod;
  destination?: string | null;
  note?: string | null;
}

export interface LogisticsStatusInput {
  status: FulfillmentStatus;
  note?: string | null;
}

export interface NormalizedLogisticsInput {
  invoiceId: string;
  method: FulfillmentMethod;
  destination: string | null;
  note: string | null;
}

export interface NormalizedLogisticsStatusInput {
  status: FulfillmentStatus;
  note: string | null;
}

export function validateLogisticsInput(input: LogisticsInput): ValidationResult {
  const errors: string[] = [];

  if (normalizeRequiredText(input.invoiceId).length === 0) {
    errors.push("Logistics invoice id is required.");
  }

  if (!isFulfillmentMethod(input.method)) {
    errors.push("Fulfillment method is not supported.");
  }

  if (normalizeOptionalText(input.destination).length > 180) {
    errors.push("Logistics destination must be 180 characters or fewer.");
  }

  if (normalizeOptionalText(input.note).length > 180) {
    errors.push("Logistics note must be 180 characters or fewer.");
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function validateLogisticsStatusInput(input: LogisticsStatusInput): ValidationResult {
  const errors: string[] = [];

  if (!isFulfillmentStatus(input.status)) {
    errors.push("Fulfillment status is not supported.");
  }

  if (normalizeOptionalText(input.note).length > 180) {
    errors.push("Logistics note must be 180 characters or fewer.");
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function validateLogisticsStatusTransition(
  current: FulfillmentStatus,
  next: FulfillmentStatus,
  method: FulfillmentMethod
): ValidationResult {
  if (current === next) {
    return valid();
  }

  if (current === "completed" || current === "cancelled") {
    return invalid("Completed or cancelled fulfillment records cannot change status.");
  }

  const allowed: Record<FulfillmentStatus, FulfillmentStatus[]> = {
    pending: ["ready", "cancelled"],
    ready:
      method === "delivery"
        ? ["out_for_delivery", "completed", "cancelled"]
        : ["completed", "cancelled"],
    out_for_delivery: method === "delivery" ? ["completed", "cancelled"] : [],
    completed: [],
    cancelled: []
  };

  return allowed[current]?.includes(next)
    ? valid()
    : invalid(`Cannot change fulfillment status from ${current} to ${next}.`);
}

export function normalizeLogisticsInput(input: LogisticsInput): NormalizedLogisticsInput {
  return {
    invoiceId: normalizeRequiredText(input.invoiceId),
    method: input.method,
    destination: nullableText(input.destination),
    note: nullableText(input.note)
  };
}

export function normalizeLogisticsStatusInput(
  input: LogisticsStatusInput
): NormalizedLogisticsStatusInput {
  return {
    status: input.status,
    note: nullableText(input.note)
  };
}

export function isFulfillmentMethod(value: string): value is FulfillmentMethod {
  return value === "delivery" || value === "pickup";
}

export function isFulfillmentStatus(value: string): value is FulfillmentStatus {
  return (
    value === "pending" ||
    value === "ready" ||
    value === "out_for_delivery" ||
    value === "completed" ||
    value === "cancelled"
  );
}

export function logisticsCreatedEvent(input: {
  id: string;
  logistics: LogisticsSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{ logistics: LogisticsSummary }> {
  return createEvent({
    id: input.id,
    type: "logistics.created",
    aggregateId: input.logistics.id,
    aggregateType: "logistics",
    actorId: input.actorId,
    risk: "low",
    occurredAt: input.occurredAt,
    payload: {
      logistics: input.logistics
    }
  });
}

export function logisticsStatusUpdatedEvent(input: {
  id: string;
  logistics: LogisticsSummary;
  previousStatus: FulfillmentStatus;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{
  logistics: LogisticsSummary;
  previousStatus: FulfillmentStatus;
}> {
  return createEvent({
    id: input.id,
    type: "logistics.status_updated",
    aggregateId: input.logistics.id,
    aggregateType: "logistics",
    actorId: input.actorId,
    risk: "low",
    occurredAt: input.occurredAt,
    payload: {
      logistics: input.logistics,
      previousStatus: input.previousStatus
    }
  });
}
