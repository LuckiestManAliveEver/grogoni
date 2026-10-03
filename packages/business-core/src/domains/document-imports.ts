import { createEvent, type BusinessEvent } from "@grogoni/event-core";
import type { DocumentImportJobSummary } from "@grogoni/shared-types";
import { invalid, type ValidationResult, valid } from "@grogoni/tool-core";

import { normalizeOptionalText, normalizeRequiredText } from "../shared/text-normalization.js";

export interface DocumentImportSourceInput {
  fileName: string;
  contentType?: string | null;
  content: string;
  sourceType?: "upload" | "paste" | "database";
  sourceLocator?: string | null;
  originalSizeBytes?: number;
  originalChecksum?: string;
  originalStorageKey?: string | null;
}

export function validateDocumentImportSource(input: DocumentImportSourceInput): ValidationResult {
  const errors: string[] = [];
  const fileName = normalizeRequiredText(input.fileName);
  const contentType = normalizeOptionalText(input.contentType);
  const sourceLocator = normalizeOptionalText(input.sourceLocator);
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  const supportedExtensions = new Set([
    "csv",
    "tsv",
    "txt",
    "json",
    "sql",
    "pdf",
    "docx",
    "xls",
    "xlsx",
    "ods"
  ]);

  if (fileName.length < 5 || !supportedExtensions.has(extension)) {
    errors.push("Import file must be PDF, DOCX, XLS, XLSX, ODS, CSV, TSV, text, JSON, or SQL.");
  }

  if (
    contentType.length > 0 &&
    ![
      "text/csv",
      "text/tab-separated-values",
      "text/plain",
      "application/csv",
      "application/json",
      "application/sql",
      "application/pdf",
      "application/octet-stream",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.oasis.opendocument.spreadsheet"
    ].includes(contentType)
  ) {
    errors.push("Import content type is not supported.");
  }

  if (input.content.trim().length === 0) {
    errors.push("Import content is required.");
  }

  if (input.content.length > 250_000) {
    errors.push("Import content must be 250KB or smaller.");
  }

  if (
    input.sourceType !== undefined &&
    input.sourceType !== "upload" &&
    input.sourceType !== "paste" &&
    input.sourceType !== "database"
  ) {
    errors.push("Import source type is not supported.");
  }

  if (
    input.originalStorageKey !== undefined &&
    input.originalStorageKey !== null &&
    !/^[A-Za-z0-9][A-Za-z0-9/_.:-]{0,511}$/u.test(input.originalStorageKey)
  ) {
    errors.push("Import object storage key is invalid.");
  }

  if (sourceLocator.length > 500) {
    errors.push("Import source reference must be 500 characters or fewer.");
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function documentImportPreviewedEvent(input: {
  id: string;
  importJob: DocumentImportJobSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{ importJob: DocumentImportJobSummary }> {
  return createEvent({
    id: input.id,
    type: "document_import.previewed",
    aggregateId: input.importJob.id,
    aggregateType: "document_import",
    actorId: input.actorId,
    risk: "medium",
    occurredAt: input.occurredAt,
    payload: {
      importJob: input.importJob
    }
  });
}

export function documentImportConfirmedEvent(input: {
  id: string;
  importJob: DocumentImportJobSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{ importJob: DocumentImportJobSummary }> {
  return createEvent({
    id: input.id,
    type: "document_import.confirmed",
    aggregateId: input.importJob.id,
    aggregateType: "document_import",
    actorId: input.actorId,
    risk: "medium",
    occurredAt: input.occurredAt,
    payload: {
      importJob: input.importJob
    }
  });
}

export function documentImportFailedEvent(input: {
  id: string;
  importJob: DocumentImportJobSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{ importJob: DocumentImportJobSummary }> {
  return createEvent({
    id: input.id,
    type: "document_import.failed",
    aggregateId: input.importJob.id,
    aggregateType: "document_import",
    actorId: input.actorId,
    risk: "medium",
    occurredAt: input.occurredAt,
    payload: {
      importJob: input.importJob
    }
  });
}
