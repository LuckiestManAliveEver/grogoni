import type { DocumentImportSourceSummary } from "@grogoni/shared-types";

export interface DocumentImportSourceRecord extends DocumentImportSourceSummary {
  content: string;
}

export function documentImportSourceView(
  source: DocumentImportSourceRecord
): DocumentImportSourceSummary {
  return {
    id: source.id,
    businessId: source.businessId,
    fileName: source.fileName,
    contentType: source.contentType,
    sizeBytes: source.sizeBytes,
    checksum: source.checksum,
    sourceType: source.sourceType ?? "upload",
    sourceLocator: source.sourceLocator ?? null,
    originalStorageKey: source.originalStorageKey ?? null,
    createdAt: source.createdAt
  };
}
