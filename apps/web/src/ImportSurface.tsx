import { type ChangeEvent } from "react";

import {
  type DocumentImportDraft,
  type DocumentImportJobSummary,
  type DocumentImportPreviewRow,
  type DocumentImportTarget,
  type ImportFormState
} from "./grogoni-application-shared";

import { readFileAsDataUrl, dataUrlPayload } from "./chat-message-plumbing";

import { SupplierImportRowEditor, ProductImportRowEditor } from "./ImportRowEditors";

export interface ImportSurfaceProps {
  form: ImportFormState;
  importJobs: DocumentImportJobSummary[];
  activeImportJob: DocumentImportJobSummary | null;
  selectedImportJobId: string | null;
  onFormChange: (form: ImportFormState) => void;
  onCreate: () => void;
  onSelectJob: (jobId: string) => void;
  onRowChange: (input: {
    importJobId: string;
    rowNumber: number;
    mapped: DocumentImportDraft;
    selected: boolean;
  }) => void;
  onSaveRow: (job: DocumentImportJobSummary, row: DocumentImportPreviewRow) => void;
  onConfirm: (job: DocumentImportJobSummary) => void;
  onRefresh: () => void;
}

export interface ImportSourceTemplate {
  id: string;
  label: string;
  summary: string;
  sourceType: ImportFormState["sourceType"];
  sourceLocator: string;
  fileName: string;
  contentType: string;
  content: string;
}

export function ImportSurface(props: ImportSurfaceProps) {
  const selectedRows = props.activeImportJob?.rows.filter((row) => row.selected) ?? [];
  const invalidSelectedRows = selectedRows.filter((row) => row.errors.length > 0);
  const sourceTemplates = createImportSourceTemplates(props.form.target);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (file === undefined) {
      return;
    }

    const contentType = file.type || inferImportContentType(file.name);
    const binaryDocument = isBinaryImportDocument(file.name, contentType);
    const content = binaryDocument ? "" : await file.text();
    const contentBase64 = binaryDocument ? dataUrlPayload(await readFileAsDataUrl(file)) : null;
    props.onFormChange({
      ...props.form,
      fileName: file.name,
      contentType,
      content,
      contentBase64
    });
    event.target.value = "";
  }

  function applySourceTemplate(template: ImportSourceTemplate) {
    props.onFormChange({
      ...props.form,
      sourceType: template.sourceType,
      sourceLocator: template.sourceLocator,
      fileName: template.fileName,
      contentType: template.contentType,
      content: template.content,
      contentBase64: null
    });
  }

  return (
    <div className="records-surface">
      <section className="record-form" aria-label="Catalogue document import">
        <div className="section-heading">
          <p className="eyebrow">Catalogue imports</p>
          <h3>Import products or supplier records</h3>
        </div>
        <label>
          Import target
          <select
            value={props.form.target}
            onChange={(event) => {
              const target = event.target.value as DocumentImportTarget;
              props.onFormChange({
                ...props.form,
                target,
                sourceType: target === "product" ? props.form.sourceType : "upload",
                sourceLocator: "",
                fileName: target === "product" ? "products.csv" : "suppliers.csv",
                contentType: "text/csv",
                content:
                  target === "product"
                    ? "name,sku,unit,quantity,buyingPrice,sellingPrice\nTomatoes,TOM-001,kg,20,60,90"
                    : "name,phone,email,notes\nWholesale Depot,+254700000010,supply@example.com,Main supplier",
                contentBase64: null
              });
            }}
          >
            <option value="product">Product catalogue</option>
            <option value="supplier">Supplier contacts</option>
          </select>
        </label>
        <label>
          Source
          <select
            value={props.form.sourceType}
            onChange={(event) =>
              props.onFormChange({
                ...props.form,
                sourceType: event.target.value as ImportFormState["sourceType"]
              })
            }
          >
            <option value="upload">Upload document</option>
            <option value="paste">Paste document/export</option>
            <option value="database">Existing database link or export</option>
          </select>
        </label>
        <label>
          Source reference
          <input
            value={props.form.sourceLocator}
            onChange={(event) =>
              props.onFormChange({ ...props.form, sourceLocator: event.target.value })
            }
            placeholder="Sheet URL, database export name, table, or connection reference"
          />
        </label>
        <div className="import-source-grid" aria-label="Import source options">
          {sourceTemplates.map((template) => (
            <button
              key={template.id}
              className={props.form.fileName === template.fileName ? "active" : ""}
              type="button"
              onClick={() => applySourceTemplate(template)}
            >
              <span>{template.label}</span>
              <small>{template.summary}</small>
            </button>
          ))}
        </div>
        <label>
          Upload PDF, Word, Excel, OpenDocument, CSV/TSV, JSON, SQL, or text
          <input
            accept={[
              ".csv",
              ".tsv",
              ".txt",
              ".json",
              ".sql",
              ".pdf",
              ".docx",
              ".xls",
              ".xlsx",
              ".ods",
              "text/*",
              "application/json",
              "application/pdf"
            ].join(",")}
            type="file"
            onChange={(event) => void handleFileChange(event)}
          />
        </label>
        <label>
          File name
          <input
            value={props.form.fileName}
            onChange={(event) =>
              props.onFormChange({ ...props.form, fileName: event.target.value })
            }
          />
        </label>
        <label>
          Content type
          <input
            value={props.form.contentType}
            onChange={(event) =>
              props.onFormChange({ ...props.form, contentType: event.target.value })
            }
          />
        </label>
        <label>
          Document or export content
          <textarea
            value={props.form.content}
            placeholder={
              props.form.contentBase64 === null
                ? "Paste document text or an export"
                : "Binary document loaded and ready for extraction"
            }
            disabled={props.form.contentBase64 !== null}
            onChange={(event) =>
              props.onFormChange({
                ...props.form,
                content: event.target.value,
                contentBase64: null
              })
            }
            rows={7}
          />
        </label>
        <p className="form-hint">
          PDF, DOCX, XLS, XLSX, and ODS files are extracted on the server. Scanned PDFs still
          require OCR. The agent maps the extracted rows into a preview and will not add them until
          you confirm. Do not upload passwords or private keys.
        </p>
        <div className="actions">
          <button
            type="button"
            onClick={props.onCreate}
            disabled={
              props.form.fileName.trim() === "" ||
              (props.form.content.trim() === "" && props.form.contentBase64 === null)
            }
          >
            Preview
          </button>
          <button className="secondary" type="button" onClick={props.onRefresh}>
            Refresh
          </button>
        </div>
      </section>

      <section className="record-list" aria-label="Import jobs">
        <div className="section-heading">
          <p className="eyebrow">Import history</p>
          <h3>Catalogue and supplier imports</h3>
        </div>
        {props.importJobs.length === 0 ? (
          <div className="empty-record">
            <h3>No imports yet</h3>
            <p>Preview a catalogue document before confirming new records.</p>
          </div>
        ) : (
          props.importJobs.map((job) => (
            <article className="record-row" key={job.id}>
              <div>
                <strong>
                  {job.source.fileName} - {job.target} - {job.status}
                </strong>
                <span>
                  {job.rows.length} row{job.rows.length === 1 ? "" : "s"} - {job.confirmedCount}{" "}
                  confirmed
                </span>
              </div>
              <button
                type="button"
                className={props.selectedImportJobId === job.id ? "active" : ""}
                onClick={() => props.onSelectJob(job.id)}
              >
                View
              </button>
            </article>
          ))
        )}
      </section>

      {props.activeImportJob !== null ? (
        <section className="record-list" aria-label="Import preview rows">
          <div className="section-heading">
            <p className="eyebrow">Import preview</p>
            <h3>Review rows</h3>
          </div>
          <div className="metric-grid compact">
            <div className="metric">
              <span>Rows</span>
              <strong>{props.activeImportJob.rows.length}</strong>
            </div>
            <div className="metric">
              <span>Selected</span>
              <strong>{selectedRows.length}</strong>
            </div>
            <div className="metric">
              <span>Invalid</span>
              <strong>{invalidSelectedRows.length}</strong>
            </div>
          </div>
          {props.activeImportJob.errorMessage !== null ? (
            <div className="empty-record">
              <h3>Import failed</h3>
              <p>{props.activeImportJob.errorMessage}</p>
            </div>
          ) : null}
          {props.activeImportJob.rows.map((row) =>
            props.activeImportJob?.target === "product" ? (
              <ProductImportRowEditor
                importJobId={props.activeImportJob.id}
                key={row.rowNumber}
                row={row}
                disabled={props.activeImportJob.status !== "previewed"}
                onRowChange={props.onRowChange}
                onSave={() =>
                  props.activeImportJob !== null && props.onSaveRow(props.activeImportJob, row)
                }
              />
            ) : (
              <SupplierImportRowEditor
                importJobId={props.activeImportJob?.id ?? ""}
                key={row.rowNumber}
                row={row}
                disabled={props.activeImportJob?.status !== "previewed"}
                onRowChange={props.onRowChange}
                onSave={() =>
                  props.activeImportJob !== null && props.onSaveRow(props.activeImportJob, row)
                }
              />
            )
          )}
          <button
            type="button"
            onClick={() => props.activeImportJob !== null && props.onConfirm(props.activeImportJob)}
            disabled={
              props.activeImportJob.status !== "previewed" ||
              selectedRows.length === 0 ||
              invalidSelectedRows.length > 0
            }
          >
            Confirm selected
          </button>
        </section>
      ) : null}
    </div>
  );
}

export function createImportSourceTemplates(target: DocumentImportTarget): ImportSourceTemplate[] {
  if (target === "supplier") {
    return [
      {
        id: "supplier-sheet",
        label: "Spreadsheet",
        summary: "CSV, TSV, or Google Sheets text export",
        sourceType: "upload",
        sourceLocator: "Upload or paste a supplier sheet export",
        fileName: "supplier-contacts.csv",
        contentType: "text/csv",
        content:
          "name,phone,email,notes\nWholesale Depot,+254700000010,supply@example.com,Main supplier\nRegional Foods,+254700000011,regional@example.com,Backup supplier"
      },
      {
        id: "supplier-document",
        label: "PDF or Word",
        summary: "Extract supplier rows from copied document text",
        sourceType: "paste",
        sourceLocator: "Paste text extracted from PDF, DOC, DOCX, or scanned document",
        fileName: "supplier-document.txt",
        contentType: "text/plain",
        content:
          "name,phone,email,notes\nMarket Distributor,+254700000012,market@example.com,Imported from document\nCounty Wholesaler,+254700000013,county@example.com,Imported from document"
      },
      {
        id: "supplier-database",
        label: "Existing database",
        summary: "Paste an exported table or reference a supplier source",
        sourceType: "database",
        sourceLocator: "suppliers table export",
        fileName: "supplier-database-export.csv",
        contentType: "text/csv",
        content:
          "name,phone,email,notes\nDatabase Supplier,+254700000014,db-supplier@example.com,Imported from database export"
      }
    ];
  }

  return [
    {
      id: "product-sheet",
      label: "Spreadsheet",
      summary: "CSV, TSV, or Google Sheets text export",
      sourceType: "upload",
      sourceLocator: "Upload or paste a catalogue sheet export",
      fileName: "product-catalogue.csv",
      contentType: "text/csv",
      content:
        "name,sku,unit,quantity,buyingPrice,sellingPrice\nTomatoes,TOM-001,kg,20,60,90\nCooking Oil,OIL-001,litre,12,220,260"
    },
    {
      id: "product-document",
      label: "PDF or Word",
      summary: "Upload a PDF or DOCX catalogue for extraction",
      sourceType: "upload",
      sourceLocator: "Upload a text-based PDF or modern Word document",
      fileName: "product-document.txt",
      contentType: "text/plain",
      content:
        "name,sku,unit,quantity,buyingPrice,sellingPrice\nRice,RIC-001,kg,30,120,155\nBeans,BEA-001,kg,25,90,130"
    },
    {
      id: "product-database",
      label: "Existing database",
      summary: "Paste an exported table or reference a product source",
      sourceType: "database",
      sourceLocator: "products table export",
      fileName: "product-database-export.csv",
      contentType: "text/csv",
      content:
        "name,sku,unit,quantity,buyingPrice,sellingPrice\nDatabase Product,DB-001,unit,10,100,140"
    }
  ];
}

export function inferImportContentType(fileName: string): string {
  const extension = fileName.toLowerCase().split(".").pop();

  switch (extension) {
    case "csv":
      return "text/csv";
    case "tsv":
      return "text/tab-separated-values";
    case "json":
      return "application/json";
    case "pdf":
      return "application/pdf";
    case "doc":
      return "application/msword";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xls":
      return "application/vnd.ms-excel";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "ods":
      return "application/vnd.oasis.opendocument.spreadsheet";
    case "sql":
      return "application/sql";
    default:
      return "text/plain";
  }
}

export function isBinaryImportDocument(fileName: string, contentType: string): boolean {
  return (
    /\.(?:docx|ods|pdf|xls|xlsx)$/iu.test(fileName) ||
    [
      "application/pdf",
      "application/vnd.ms-excel",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ].includes(contentType)
  );
}
