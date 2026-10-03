import { useState } from "react";
import { reportBackgroundLoadError } from "../background-load-error";

import { getErrorMessage } from "../chat-message-plumbing";
import { getJson, patchJson, postJson } from "../api-helpers";
import {
  emptyImportForm,
  type DocumentImportConfirmResult,
  type DocumentImportDraft,
  type DocumentImportJobSummary,
  type DocumentImportPreviewRow,
  type ImportFormState
} from "../grogoni-application-shared";

interface UseImportsStateDeps {
  businessId: string | null;
  setStatusMessage: (message: string) => void;
  loadProducts: (businessId: string) => Promise<void>;
  loadSuppliers: (businessId: string) => Promise<void>;
  loadReports: (businessId: string) => Promise<void>;
  registerReset: (domainKey: string, fn: () => void) => void;
  registerRefresh: (
    domainKey: string,
    views: readonly string[],
    fn: (businessId: string) => Promise<void>
  ) => void;
}

export function useImportsState(deps: UseImportsStateDeps) {
  const [importJobs, setImportJobs] = useState<DocumentImportJobSummary[]>([]);
  const [selectedImportJobId, setSelectedImportJobId] = useState<string | null>(null);
  const [importForm, setImportForm] = useState<ImportFormState>(emptyImportForm);

  const activeImportJob =
    importJobs.find((job) => job.id === selectedImportJobId) ?? importJobs[0] ?? null;

  async function loadDocumentImports(businessId: string) {
    try {
      const jobs = await getJson<DocumentImportJobSummary[]>(`/businesses/${businessId}/imports`);
      setImportJobs(jobs);
      if (selectedImportJobId === null && jobs[0] !== undefined) {
        setSelectedImportJobId(jobs[0].id);
      }
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  async function createDocumentImport() {
    if (deps.businessId === null) {
      return;
    }

    try {
      const endpoint = importForm.target === "product" ? "product-catalogue" : "supplier-csv";
      const job = await postJson<DocumentImportJobSummary>(
        `/businesses/${deps.businessId}/imports/${endpoint}`,
        {
          fileName: importForm.fileName,
          contentType: importForm.contentType,
          sourceType: importForm.sourceType,
          sourceLocator: importForm.sourceLocator.trim() || null,
          ...(importForm.contentBase64 === null
            ? { content: importForm.content }
            : { contentBase64: importForm.contentBase64 })
        }
      );
      setImportJobs((jobs) => [job, ...jobs.filter((item) => item.id !== job.id)]);
      setSelectedImportJobId(job.id);
      deps.setStatusMessage(
        job.status === "failed"
          ? (job.errorMessage ??
              "The document could not be imported because it did not contain any usable rows.")
          : "Import preview ready"
      );
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  function updateImportRowLocal(input: {
    importJobId: string;
    rowNumber: number;
    mapped: DocumentImportDraft;
    selected: boolean;
  }) {
    setImportJobs((jobs) =>
      jobs.map((job) =>
        job.id === input.importJobId
          ? {
              ...job,
              rows: job.rows.map((row) =>
                row.rowNumber === input.rowNumber
                  ? {
                      ...row,
                      mapped: input.mapped,
                      selected: input.selected
                    }
                  : row
              )
            }
          : job
      )
    );
  }

  async function saveImportRow(job: DocumentImportJobSummary, row: DocumentImportPreviewRow) {
    if (deps.businessId === null) {
      return;
    }

    try {
      const rowEndpoint = job.target === "product" ? "product-rows" : "rows";
      const updated = await patchJson<DocumentImportJobSummary>(
        `/businesses/${deps.businessId}/imports/${job.id}/${rowEndpoint}/${row.rowNumber}`,
        {
          mapped: row.mapped,
          selected: row.selected
        }
      );
      setImportJobs((jobs) => jobs.map((item) => (item.id === updated.id ? updated : item)));
      deps.setStatusMessage(`Import row ${row.rowNumber} saved`);
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function confirmImport(job: DocumentImportJobSummary) {
    if (deps.businessId === null) {
      return;
    }

    try {
      const confirmEndpoint = job.target === "product" ? "confirm-products" : "confirm";
      const response = await postJson<DocumentImportConfirmResult>(
        `/businesses/${deps.businessId}/imports/${job.id}/${confirmEndpoint}`,
        {
          selectedRowNumbers: job.rows.filter((row) => row.selected).map((row) => row.rowNumber)
        }
      );
      setImportJobs((jobs) =>
        jobs.map((item) => (item.id === response.job.id ? response.job : item))
      );
      await loadDocumentImports(deps.businessId);
      if (response.job.target === "product") {
        await deps.loadProducts(deps.businessId);
      } else {
        await deps.loadSuppliers(deps.businessId);
      }
      await deps.loadReports(deps.businessId);
      deps.setStatusMessage(
        `${response.job.confirmedCount} ${
          response.job.target === "product" ? "product" : "supplier"
        } row${response.job.confirmedCount === 1 ? "" : "s"} imported`
      );
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  deps.registerReset("imports", () => {
    setImportJobs([]);
    setSelectedImportJobId(null);
    setImportForm(emptyImportForm);
  });
  deps.registerRefresh("imports", ["imports"], loadDocumentImports);

  return {
    importJobs,
    selectedImportJobId,
    setSelectedImportJobId,
    importForm,
    setImportForm,
    activeImportJob,
    loadDocumentImports,
    createDocumentImport,
    updateImportRowLocal,
    saveImportRow,
    confirmImport
  };
}
