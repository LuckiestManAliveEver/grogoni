/**
 * Fifth slice of in-process domain modularization for the Cp2Store monolith (see
 * docs/architecture/domain-modularization-roadmap.md). Owns the documentImports/
 * documentImportSources Maps and the supplier-CSV/product-catalogue import CRUD that reads and
 * writes them.
 *
 * `confirmSupplierImport`/`confirmProductImport` call back up into `Cp2Store` for
 * `createSupplier`/`createProduct` (neither the supplier domain's `createSupplier` nor the
 * not-yet-extracted product/commerce `createProduct` belong to this domain) - both are injected as
 * deps functions, the same "call back up" pattern `LogisticsDomainDeps.requireInvoice` and
 * `CommerceDomainDeps.createProduct` already use.
 */
import { randomUUID, createHash } from "node:crypto";
import {
  createProductImportPreview,
  createSupplierImportPreview,
  documentImportConfirmedEvent,
  documentImportFailedEvent,
  documentImportPreviewedEvent,
  validateContactRecordInput,
  validateDocumentImportSource,
  validateProductInput,
  type BusinessPermission,
  type ContactRecordInput,
  type DocumentImportSourceInput,
  type ProductInput
} from "@grogoni/business-core";
import type { BusinessEvent } from "@grogoni/event-core";
import type {
  AuthenticatedActorView,
  DocumentImportConfirmResult,
  DocumentImportJobSummary,
  DocumentImportPreviewRow,
  DocumentImportSourceSummary,
  ProductImportDraft,
  ProductSummary,
  SupplierImportDraft,
  SupplierSummary
} from "@grogoni/shared-types";
import { Cp2Error, assertValid } from "../../cp2-error.js";
import { documentImportSourceView, type DocumentImportSourceRecord } from "./shared.js";

export interface DocumentImportDomainDeps {
  requireAuthorizedSession: (
    sessionId: string | null,
    businessId: string,
    permission: BusinessPermission,
    now?: Date
  ) => AuthenticatedActorView;
  appendBusinessEvent: (event: BusinessEvent) => void;
  createSupplier: (input: {
    sessionId: string | null;
    businessId: string;
    supplier: ContactRecordInput;
    now?: Date;
  }) => SupplierSummary;
  createProduct: (input: {
    sessionId: string | null;
    businessId: string;
    product: ProductInput;
    now?: Date;
  }) => ProductSummary;
}

export class DocumentImportDomain {
  private readonly documentImports = new Map<string, DocumentImportJobSummary>();
  private readonly documentImportSources = new Map<string, DocumentImportSourceRecord>();

  constructor(private readonly deps: DocumentImportDomainDeps) {}

  get documentImportsMap(): Map<string, DocumentImportJobSummary> {
    return this.documentImports;
  }

  get documentImportSourcesMap(): Map<string, DocumentImportSourceRecord> {
    return this.documentImportSources;
  }

  clear(): void {
    this.documentImports.clear();
    this.documentImportSources.clear();
  }

  createSupplierCsvImport(input: {
    sessionId: string | null;
    businessId: string;
    source: DocumentImportSourceInput;
    now?: Date;
  }): DocumentImportJobSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "import:write",
      now
    );
    assertValid(validateDocumentImportSource(input.source));
    const source: DocumentImportSourceRecord = {
      id: randomUUID(),
      businessId: input.businessId,
      fileName: input.source.fileName.trim(),
      contentType: input.source.contentType?.trim() || "text/csv",
      sizeBytes: input.source.originalSizeBytes ?? Buffer.byteLength(input.source.content),
      checksum:
        input.source.originalChecksum ??
        createHash("sha256").update(input.source.content).digest("hex"),
      sourceType: input.source.sourceType ?? "upload",
      sourceLocator: input.source.sourceLocator?.trim() || null,
      originalStorageKey: input.source.originalStorageKey ?? null,
      content: input.source.content,
      createdAt: now.toISOString()
    };
    const preview = createSupplierImportPreview({
      content: source.content
    });
    const job: DocumentImportJobSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      source: documentImportSourceView(source),
      target: "supplier",
      status: preview.rows.length === 0 ? "failed" : "previewed",
      fieldMapping: preview.fieldMapping,
      rows: preview.rows,
      confirmedCount: 0,
      errorMessage: preview.rows.length === 0 ? "Import file does not contain data rows." : null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      confirmedAt: null
    };

    this.documentImportSources.set(source.id, source);
    this.documentImports.set(job.id, job);
    this.deps.appendBusinessEvent(
      job.status === "failed"
        ? documentImportFailedEvent({
            id: randomUUID(),
            importJob: job,
            actorId: session.user.id,
            occurredAt: now.toISOString()
          })
        : documentImportPreviewedEvent({
            id: randomUUID(),
            importJob: job,
            actorId: session.user.id,
            occurredAt: now.toISOString()
          })
    );

    return job;
  }

  assertDocumentImportWriteAccess(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): void {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "import:write",
      input.now
    );
  }

  createProductCatalogueImport(input: {
    sessionId: string | null;
    businessId: string;
    source: DocumentImportSourceInput;
    now?: Date;
  }): DocumentImportJobSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "import:write",
      now
    );
    assertValid(validateDocumentImportSource(input.source));
    const source: DocumentImportSourceRecord = {
      id: randomUUID(),
      businessId: input.businessId,
      fileName: input.source.fileName.trim(),
      contentType: input.source.contentType?.trim() || "text/plain",
      sizeBytes: input.source.originalSizeBytes ?? Buffer.byteLength(input.source.content),
      checksum:
        input.source.originalChecksum ??
        createHash("sha256").update(input.source.content).digest("hex"),
      sourceType: input.source.sourceType ?? "upload",
      sourceLocator: input.source.sourceLocator?.trim() || null,
      originalStorageKey: input.source.originalStorageKey ?? null,
      content: input.source.content,
      createdAt: now.toISOString()
    };
    const preview = createProductImportPreview({
      content: source.content
    });
    const job: DocumentImportJobSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      source: documentImportSourceView(source),
      target: "product",
      status: preview.rows.length === 0 ? "failed" : "previewed",
      fieldMapping: preview.fieldMapping,
      rows: preview.rows,
      confirmedCount: 0,
      errorMessage: preview.rows.length === 0 ? "Import file does not contain product rows." : null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      confirmedAt: null
    };

    this.documentImportSources.set(source.id, source);
    this.documentImports.set(job.id, job);
    this.deps.appendBusinessEvent(
      job.status === "failed"
        ? documentImportFailedEvent({
            id: randomUUID(),
            importJob: job,
            actorId: session.user.id,
            occurredAt: now.toISOString()
          })
        : documentImportPreviewedEvent({
            id: randomUUID(),
            importJob: job,
            actorId: session.user.id,
            occurredAt: now.toISOString()
          })
    );

    return job;
  }

  listDocumentImports(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): DocumentImportJobSummary[] {
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "import:read", input.now);
    return [...this.documentImports.values()]
      .filter((job) => job.businessId === input.businessId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getDocumentImport(input: {
    sessionId: string | null;
    businessId: string;
    importJobId: string;
    now?: Date;
  }): DocumentImportJobSummary {
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "import:read", input.now);
    return this.requireDocumentImport(input.businessId, input.importJobId);
  }

  updateSupplierImportRow(input: {
    sessionId: string | null;
    businessId: string;
    importJobId: string;
    rowNumber: number;
    mapped: SupplierImportDraft;
    selected?: boolean;
    now?: Date;
  }): DocumentImportJobSummary {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "import:write", now);
    const job = this.requireDocumentImport(input.businessId, input.importJobId);

    if (job.target !== "supplier") {
      throw new Cp2Error(409, "import_target_mismatch", "Import job is not a supplier import.");
    }

    if (job.status !== "previewed") {
      throw new Cp2Error(409, "import_not_editable", "Only previewed imports can be edited.");
    }

    const rowIndex = job.rows.findIndex((row) => row.rowNumber === input.rowNumber);

    if (rowIndex === -1) {
      throw new Cp2Error(404, "import_row_not_found", "Import row was not found.");
    }

    const validation = validateContactRecordInput(input.mapped, "Supplier");
    const rows = job.rows.map((row, index): DocumentImportPreviewRow => {
      if (index !== rowIndex) {
        return row;
      }

      return {
        ...row,
        mapped: input.mapped,
        errors: validation.errors,
        warnings: [],
        selected: input.selected ?? (validation.ok && row.selected)
      };
    });
    const updated: DocumentImportJobSummary = {
      ...job,
      rows,
      updatedAt: now.toISOString()
    };

    this.documentImports.set(updated.id, updated);
    return updated;
  }

  updateProductImportRow(input: {
    sessionId: string | null;
    businessId: string;
    importJobId: string;
    rowNumber: number;
    mapped: ProductImportDraft;
    selected?: boolean;
    now?: Date;
  }): DocumentImportJobSummary {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "import:write", now);
    const job = this.requireDocumentImport(input.businessId, input.importJobId);

    if (job.target !== "product") {
      throw new Cp2Error(409, "import_target_mismatch", "Import job is not a product catalogue.");
    }

    if (job.status !== "previewed") {
      throw new Cp2Error(409, "import_not_editable", "Only previewed imports can be edited.");
    }

    const rowIndex = job.rows.findIndex((row) => row.rowNumber === input.rowNumber);

    if (rowIndex === -1) {
      throw new Cp2Error(404, "import_row_not_found", "Import row was not found.");
    }

    const validation = validateProductInput(input.mapped);
    const rows = job.rows.map((row, index): DocumentImportPreviewRow => {
      if (index !== rowIndex) {
        return row;
      }

      return {
        ...row,
        mapped: input.mapped,
        errors: validation.errors,
        warnings: [],
        selected: input.selected ?? (validation.ok && row.selected)
      };
    });
    const updated: DocumentImportJobSummary = {
      ...job,
      rows,
      updatedAt: now.toISOString()
    };

    this.documentImports.set(updated.id, updated);
    return updated;
  }

  confirmSupplierImport(input: {
    sessionId: string | null;
    businessId: string;
    importJobId: string;
    selectedRowNumbers?: number[];
    now?: Date;
  }): DocumentImportConfirmResult {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "import:write",
      now
    );
    const job = this.requireDocumentImport(input.businessId, input.importJobId);

    if (job.target !== "supplier") {
      throw new Cp2Error(409, "import_target_mismatch", "Import job is not a supplier import.");
    }

    if (job.status !== "previewed") {
      throw new Cp2Error(409, "import_not_confirmable", "Only previewed imports can be confirmed.");
    }

    const selectedRows = this.selectImportRows(job, input.selectedRowNumbers);

    if (selectedRows.length === 0) {
      throw new Cp2Error(400, "import_rows_required", "At least one import row must be selected.");
    }

    const invalidRows = selectedRows.filter(
      (row) => !validateContactRecordInput(row.mapped as SupplierImportDraft, "Supplier").ok
    );

    if (invalidRows.length > 0) {
      throw new Cp2Error(
        409,
        "import_rows_invalid",
        `Import has invalid selected rows: ${invalidRows.map((row) => row.rowNumber).join(", ")}.`
      );
    }

    const suppliers = selectedRows.map((row) =>
      this.deps.createSupplier({
        sessionId: input.sessionId,
        businessId: input.businessId,
        supplier: row.mapped as SupplierImportDraft,
        now
      })
    );
    const confirmed: DocumentImportJobSummary = {
      ...job,
      status: "confirmed",
      confirmedCount: suppliers.length,
      updatedAt: now.toISOString(),
      confirmedAt: now.toISOString()
    };

    this.documentImports.set(confirmed.id, confirmed);
    this.deps.appendBusinessEvent(
      documentImportConfirmedEvent({
        id: randomUUID(),
        importJob: confirmed,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return {
      job: confirmed,
      suppliers
    };
  }

  confirmProductImport(input: {
    sessionId: string | null;
    businessId: string;
    importJobId: string;
    selectedRowNumbers?: number[];
    now?: Date;
  }): DocumentImportConfirmResult {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "import:write",
      now
    );
    const job = this.requireDocumentImport(input.businessId, input.importJobId);

    if (job.target !== "product") {
      throw new Cp2Error(409, "import_target_mismatch", "Import job is not a product catalogue.");
    }

    if (job.status !== "previewed") {
      throw new Cp2Error(409, "import_not_confirmable", "Only previewed imports can be confirmed.");
    }

    const selectedRows = this.selectImportRows(job, input.selectedRowNumbers);

    if (selectedRows.length === 0) {
      throw new Cp2Error(400, "import_rows_required", "At least one import row must be selected.");
    }

    const invalidRows = selectedRows.filter(
      (row) => !validateProductInput(row.mapped as ProductImportDraft).ok
    );

    if (invalidRows.length > 0) {
      throw new Cp2Error(
        409,
        "import_rows_invalid",
        `Import has invalid selected rows: ${invalidRows.map((row) => row.rowNumber).join(", ")}.`
      );
    }

    const products = selectedRows.map((row) =>
      this.deps.createProduct({
        sessionId: input.sessionId,
        businessId: input.businessId,
        product: row.mapped as ProductInput,
        now
      })
    );
    const confirmed: DocumentImportJobSummary = {
      ...job,
      status: "confirmed",
      confirmedCount: products.length,
      updatedAt: now.toISOString(),
      confirmedAt: now.toISOString()
    };

    this.documentImports.set(confirmed.id, confirmed);
    this.deps.appendBusinessEvent(
      documentImportConfirmedEvent({
        id: randomUUID(),
        importJob: confirmed,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return {
      job: confirmed,
      products
    };
  }

  importsForBusiness(businessId: string): DocumentImportJobSummary[] {
    return [...this.documentImports.values()].filter((job) => job.businessId === businessId);
  }

  documentImportSourcesForBusiness(businessId: string): DocumentImportSourceSummary[] {
    return [...this.documentImportSources.values()]
      .filter((source) => source.businessId === businessId)
      .map(documentImportSourceView);
  }

  documentImportSourcesView(): DocumentImportSourceSummary[] {
    return [...this.documentImportSources.values()].map(documentImportSourceView);
  }

  requireDocumentImport(businessId: string, importJobId: string): DocumentImportJobSummary {
    const job = this.documentImports.get(importJobId);

    if (job === undefined || job.businessId !== businessId) {
      throw new Cp2Error(404, "import_not_found", "Document import was not found.");
    }

    return job;
  }

  private selectImportRows(
    job: DocumentImportJobSummary,
    selectedRowNumbers: number[] | undefined
  ): DocumentImportPreviewRow[] {
    if (selectedRowNumbers === undefined) {
      return job.rows.filter((row) => row.selected);
    }

    const selected = new Set(selectedRowNumbers);
    return job.rows.filter((row) => selected.has(row.rowNumber));
  }
}
