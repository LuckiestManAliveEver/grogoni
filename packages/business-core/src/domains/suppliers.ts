import { createEvent, type BusinessEvent } from "@grogoni/event-core";
import type {
  DocumentImportPreviewRow,
  SupplierImportDraft,
  SupplierSummary
} from "@grogoni/shared-types";

import { normalizeContactRecordInput, validateContactRecordInput } from "./contact-records.js";
import { parseCsvRecords } from "../shared/content-parsing.js";
import { nullableText } from "../shared/text-normalization.js";

export interface SupplierImportPreview {
  fieldMapping: Record<string, keyof SupplierImportDraft>;
  rows: DocumentImportPreviewRow[];
}

export function createSupplierImportPreview(input: {
  content: string;
  fieldMapping?: Record<string, keyof SupplierImportDraft>;
}): SupplierImportPreview {
  const records = parseCsvRecords(input.content);
  const fieldMapping = input.fieldMapping ?? inferSupplierFieldMapping(records.headers);
  const rows = records.rows.map((row, index) => {
    const mapped = mapSupplierRow(row, fieldMapping);
    const validation = validateContactRecordInput(mapped, "Supplier");

    return {
      rowNumber: index + 1,
      raw: row,
      mapped,
      errors: validation.errors,
      warnings: [],
      selected: validation.ok
    };
  });

  return {
    fieldMapping,
    rows
  };
}

export function normalizeSupplierImportDraft(input: SupplierImportDraft): SupplierImportDraft {
  return normalizeContactRecordInput(input);
}

export function supplierCreatedEvent(input: {
  id: string;
  supplier: SupplierSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{ supplier: SupplierSummary }> {
  return createEvent({
    id: input.id,
    type: "supplier.created",
    aggregateId: input.supplier.id,
    aggregateType: "supplier",
    actorId: input.actorId,
    risk: "low",
    occurredAt: input.occurredAt,
    payload: {
      supplier: input.supplier
    }
  });
}

export function supplierUpdatedEvent(input: {
  id: string;
  supplier: SupplierSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{ supplier: SupplierSummary }> {
  return createEvent({
    id: input.id,
    type: "supplier.updated",
    aggregateId: input.supplier.id,
    aggregateType: "supplier",
    actorId: input.actorId,
    risk: "low",
    occurredAt: input.occurredAt,
    payload: {
      supplier: input.supplier
    }
  });
}

function inferSupplierFieldMapping(headers: string[]): Record<string, keyof SupplierImportDraft> {
  const mapping: Record<string, keyof SupplierImportDraft> = {};

  for (const header of headers) {
    const normalized = header.toLowerCase().replace(/[^a-z0-9]/g, "");

    if (normalized === "name" || normalized === "supplier" || normalized === "suppliername") {
      mapping[header] = "name";
    } else if (normalized === "phone" || normalized === "mobile" || normalized === "tel") {
      mapping[header] = "phone";
    } else if (normalized === "email" || normalized === "emailaddress") {
      mapping[header] = "email";
    } else if (normalized === "note" || normalized === "notes") {
      mapping[header] = "notes";
    }
  }

  return mapping;
}

function mapSupplierRow(
  row: Record<string, string>,
  fieldMapping: Record<string, keyof SupplierImportDraft>
): SupplierImportDraft {
  const mapped: SupplierImportDraft = {
    name: "",
    phone: null,
    email: null,
    notes: null
  };

  for (const [sourceField, targetField] of Object.entries(fieldMapping)) {
    const value = row[sourceField] ?? "";

    if (targetField === "name") {
      mapped.name = value;
    } else if (targetField === "phone") {
      mapped.phone = nullableText(value);
    } else if (targetField === "email") {
      mapped.email = nullableText(value);
    } else {
      mapped.notes = nullableText(value);
    }
  }

  return normalizeSupplierImportDraft(mapped);
}
