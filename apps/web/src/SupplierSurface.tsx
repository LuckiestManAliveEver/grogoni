import { ReceiptBindingCard } from "./ReceiptBindingCard";
import { ReceiptFieldsForm } from "./ReceiptFieldsForm";
import { patchJson } from "./api-helpers";
import { useState, type ChangeEvent } from "react";

import {
  type NetworkNodeSummary,
  type PurchaseReceiptSummary,
  type ReceiptOCRJobSummary,
  type SupplierBusinessCardSummary,
  type SupplierFormState,
  type SupplierSummary,
  emptySupplierForm
} from "./grogoni-application-shared";

import { isExplicitOfflineMode } from "./offline-runtime";
import { formatMoney } from "./formatters";
import PurchaseSaleRecordsCard from "./PurchaseSaleRecordsCard";
import SupplierContactRolesCard from "./SupplierContactRolesCard";

export interface SupplierSurfaceProps {
  businessId: string;
  suppliers: SupplierBusinessCardSummary[];
  purchaseReceipts: PurchaseReceiptSummary[];
  receiptOcrJobs: ReceiptOCRJobSummary[];
  form: SupplierFormState;
  onFormChange: (form: SupplierFormState) => void;
  onSave: () => void;
  onReset: () => void;
  onEdit: (supplier: SupplierSummary) => void;
  onDelete: (supplierId: string) => void;
  onSaveSalesAgent: (supplierId: string, agent: SupplierFormState) => void;
  onDeleteSalesAgent: (supplierId: string, salesAgentId: string) => void;
  onSearchContacts: (query: string) => Promise<NetworkNodeSummary[]>;
  onLinkSupplierContact: (supplierId: string, networkNodeId: string) => void;
  onCreateSupplierFromContact: (networkNodeId: string) => void;
  onLinkSalesAgentContact: (salesAgentId: string, networkNodeId: string) => void;
  onCreateSalesAgentFromContact: (supplierId: string, networkNodeId: string) => void;
  onUploadReceipt: (file: File) => Promise<ReceiptOCRJobSummary | null>;
  onConfirmReceipt: (job: ReceiptOCRJobSummary) => void;
  onImport: () => void;
}

export function SupplierSurface(props: SupplierSurfaceProps) {
  const [receiptReady, setReceiptReady] = useState<Record<string, boolean>>({});
  const [reviewedJobs, setReviewedJobs] = useState<Record<string, ReceiptOCRJobSummary>>({});
  const [openSupplierId, setOpenSupplierId] = useState<string | null>(
    props.suppliers[0]?.id ?? null
  );
  const [hiddenSupplierIds, setHiddenSupplierIds] = useState<Record<string, boolean>>({});
  const [agentFormBySupplier, setAgentFormBySupplier] = useState<Record<string, SupplierFormState>>(
    {}
  );
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState<NetworkNodeSummary[]>([]);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const offline = isExplicitOfflineMode();
  const openSupplier = props.suppliers.find((supplier) => supplier.id === openSupplierId) ?? null;

  async function searchContacts() {
    setContactResults(await props.onSearchContacts(contactQuery));
  }

  async function handleReceiptFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (file === undefined) {
      return;
    }

    const input = event.target;
    setReceiptBusy(true);
    try {
      await props.onUploadReceipt(file);
    } finally {
      setReceiptBusy(false);
      input.value = "";
    }
  }

  function agentForm(supplierId: string): SupplierFormState {
    return agentFormBySupplier[supplierId] ?? emptySupplierForm;
  }

  function updateAgentForm(supplierId: string, next: SupplierFormState) {
    setAgentFormBySupplier((current) => ({
      ...current,
      [supplierId]: next
    }));
  }

  return (
    <div className="records-surface">
      <PurchaseSaleRecordsCard businessId={props.businessId} />

      <section className="record-list" aria-label="Receipt scans">
        <h3>Receipt scans</h3>
        <label className="button-like">
          Scan receipt
          <input
            type="file"
            disabled={receiptBusy}
            accept={
              offline
                ? "image/jpeg,image/png,image/webp"
                : "image/*,.heic,.heif,.pdf,.txt,.csv,text/*,application/pdf"
            }
            onChange={(event) => void handleReceiptFile(event)}
          />
        </label>
        {receiptBusy && <p role="status">Reading receipt…</p>}
        {offline && (
          <p>
            Scans are saved on this device. Sync and go online for supplier matching and
            confirmation. Use JPEG, PNG or WebP photos; PDFs and HEIC receipts need a connection.
          </p>
        )}
        {props.receiptOcrJobs.map((sourceJob) => {
          const corrected = reviewedJobs[sourceJob.id];
          const receiptJob =
            corrected && corrected.updatedAt >= sourceJob.updatedAt ? corrected : sourceJob;
          return (
            <article className="receipt-ocr-card" key={receiptJob.id}>
              <strong>{receiptJob.sourceFileName}</strong>
              <ReceiptFieldsForm
                key={`${receiptJob.id}:${receiptJob.updatedAt}`}
                job={receiptJob}
                onReviewStateChange={(ready) =>
                  setReceiptReady((current) =>
                    current[receiptJob.id] === ready
                      ? current
                      : { ...current, [receiptJob.id]: ready }
                  )
                }
                onSave={async (fields) => {
                  const corrected = await patchJson<ReceiptOCRJobSummary>(
                    `/businesses/${props.businessId}/receipt-ocr/jobs/${receiptJob.id}`,
                    { extractedText: receiptJob.fullText, structuredExtraction: fields }
                  );
                  // Update the reviewed instance used by Confirm; the normal refresh reconciles it.
                  setReviewedJobs((current) => ({ ...current, [corrected.id]: corrected }));
                }}
              />
              <details>
                <summary>Extracted receipt text</summary>
                <pre>{receiptJob.fullText}</pre>
              </details>
              <strong>OCR status: {receiptJob.status.replace("_", " ")}</strong>
              {receiptJob.errorMessage !== null ? <span>{receiptJob.errorMessage}</span> : null}
              <span>
                Engine: {receiptJob.engine} ({receiptJob.profile})
              </span>
              {receiptJob.engine !== "gpt-6-luna" && (
                <span>Confidence: {Math.round(receiptJob.averageConfidence * 100)}%</span>
              )}
              <span>Supplier: {receiptJob.supplierName ?? "No match"}</span>
              <span>Sales agent: {receiptJob.salesAgentName ?? "No match"}</span>
              <div className="mini-card">
                <strong>Receipt contact matching</strong>
                <span>
                  Supplier confidence:{" "}
                  {Math.round(receiptJob.contactMatchingResult.supplier.confidence * 100)}%
                </span>
                <small>
                  Matched from:{" "}
                  {receiptJob.contactMatchingResult.supplier.sources.join(", ") ||
                    "No contact match"}
                </small>
                <small>
                  Why:{" "}
                  {receiptJob.contactMatchingResult.supplier.matchedBy.join(", ") || "Needs review"}
                </small>
                <span>
                  Sales-agent confidence:{" "}
                  {Math.round(receiptJob.contactMatchingResult.salesAgent.confidence * 100)}%
                </span>
                <small>
                  Matched from:{" "}
                  {receiptJob.contactMatchingResult.salesAgent.sources.join(", ") ||
                    "No contact match"}
                </small>
                <small>
                  Why:{" "}
                  {receiptJob.contactMatchingResult.salesAgent.matchedBy.join(", ") ||
                    "Needs review"}
                </small>
              </div>
              <span>Items: {receiptJob.items.length}</span>
              <span>
                Uploaded image retained temporarily: {receiptJob.imageRetained ? "Yes" : "No"}
              </span>
              {receiptJob.imageDeletedAt !== null ? (
                <span>Uploaded image deleted after processing.</span>
              ) : receiptJob.cleanupPending ? (
                <span>Image cleanup pending after confirmation.</span>
              ) : null}
              {receiptJob.warnings.length > 0 ? (
                <ul>
                  {receiptJob.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
              <button
                type="button"
                disabled={
                  receiptReady[receiptJob.id] === false ||
                  offline ||
                  !["REVIEW_REQUIRED", "MATCHING", "matched", "needs_review"].includes(
                    receiptJob.status
                  )
                }
                onClick={() => props.onConfirmReceipt(receiptJob)}
              >
                Confirm and save
              </button>
            </article>
          );
        })}
      </section>

      <section className="record-form" aria-label="Supplier form">
        <div className="section-heading with-action">
          <div>
            <p className="eyebrow">Suppliers</p>
            <h3>{props.form.id === null ? "Add supplier" : "Update supplier"}</h3>
          </div>
          <button className="secondary" type="button" onClick={props.onImport}>
            Import receipt
          </button>
        </div>
        <label>
          Name
          <input
            value={props.form.name}
            onChange={(event) => props.onFormChange({ ...props.form, name: event.target.value })}
          />
        </label>
        <div className="form-row">
          <label>
            Phone
            <input
              value={props.form.phone}
              onChange={(event) => props.onFormChange({ ...props.form, phone: event.target.value })}
              inputMode="tel"
            />
          </label>
          <label>
            Email
            <input
              value={props.form.email}
              onChange={(event) => props.onFormChange({ ...props.form, email: event.target.value })}
              inputMode="email"
            />
          </label>
        </div>
        <label>
          Notes
          <textarea
            value={props.form.notes}
            onChange={(event) => props.onFormChange({ ...props.form, notes: event.target.value })}
            rows={3}
          />
        </label>
        <div className="actions">
          <button type="button" onClick={props.onSave}>
            {props.form.id === null ? "Create" : "Save"}
          </button>
          <button className="secondary" type="button" onClick={props.onReset}>
            Clear
          </button>
        </div>
      </section>

      <section className="record-list" aria-label="Suppliers">
        <div className="surface-header-row">
          <div className="section-heading">
            <p className="eyebrow">Supplier records</p>
            <h3>Suppliers</h3>
          </div>
          <button type="button" onClick={props.onImport}>
            Upload receipt
          </button>
        </div>
        <div className="supplier-contact-tools">
          <label>
            Search imported contacts
            <input
              value={contactQuery}
              onChange={(event) => setContactQuery(event.target.value)}
              placeholder="Search phonebook contacts"
            />
          </label>
          <button className="secondary" type="button" onClick={() => void searchContacts()}>
            Search
          </button>
        </div>
        {contactResults.length > 0 ? (
          <div className="supplier-contact-results">
            {contactResults.map((contact) => (
              <article className="mini-card" key={contact.id}>
                <strong>{contact.displayName}</strong>
                <span>Phonebook contact</span>
                <div className="actions">
                  <button
                    type="button"
                    onClick={() =>
                      openSupplier === null
                        ? props.onCreateSupplierFromContact(contact.id)
                        : props.onLinkSupplierContact(openSupplier.id, contact.id)
                    }
                  >
                    {openSupplier === null ? "Create supplier" : "Link supplier"}
                  </button>
                  {openSupplier !== null ? (
                    <button
                      className="secondary"
                      type="button"
                      onClick={() =>
                        props.onCreateSalesAgentFromContact(openSupplier.id, contact.id)
                      }
                    >
                      Create sales agent
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        ) : null}
        {props.suppliers.length === 0 ? (
          <div className="empty-record">
            <h3>No suppliers yet</h3>
            <p>Add a supplier manually, create one from a phone contact, or upload a receipt.</p>
          </div>
        ) : (
          props.suppliers.map((supplier) =>
            hiddenSupplierIds[supplier.id] ? null : (
              <article className="supplier-business-card" key={supplier.id}>
                <div className="supplier-card-header">
                  <div>
                    <p className="eyebrow">Supplier</p>
                    <h3>{supplier.name}</h3>
                    <span>{supplier.phone ?? "No phone saved"}</span>
                    <small>
                      {supplier.linkedPhonebookContactName === null
                        ? "Phone contact not linked"
                        : `Linked contact: ${supplier.linkedPhonebookContactName}`}
                    </small>
                    {supplier.email !== null ? <small>{supplier.email}</small> : null}
                    {supplier.notes !== null && supplier.notes.length > 0 ? (
                      <small>{supplier.notes}</small>
                    ) : null}
                  </div>
                  <div className="supplier-card-metrics">
                    <span>Sales agents: {supplier.salesAgentCount}</span>
                    <span>Receipts matched: {supplier.purchaseReceiptCount}</span>
                    <span>
                      Last purchase:{" "}
                      {supplier.lastPurchaseDate === null
                        ? "None"
                        : new Date(supplier.lastPurchaseDate).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                <div className="actions">
                  <button type="button" onClick={() => setOpenSupplierId(supplier.id)}>
                    Open
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => setHiddenSupplierIds((cur) => ({ ...cur, [supplier.id]: true }))}
                  >
                    Close
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => props.onEdit(supplier)}
                  >
                    Edit
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => props.onDelete(supplier.id)}
                  >
                    Delete
                  </button>
                  <button type="button" onClick={() => setOpenSupplierId(supplier.id)}>
                    Add sales agent
                  </button>
                </div>
                {openSupplierId === supplier.id ? (
                  <div className="supplier-nested-cards">
                    <section aria-label="Sales agents">
                      <div className="section-heading">
                        <p className="eyebrow">Sales agents</p>
                        <h4>{supplier.name}</h4>
                      </div>
                      <div className="nested-agent-form">
                        <input
                          value={agentForm(supplier.id).name}
                          onChange={(event) =>
                            updateAgentForm(supplier.id, {
                              ...agentForm(supplier.id),
                              name: event.target.value
                            })
                          }
                          placeholder="Sales agent name"
                        />
                        <input
                          value={agentForm(supplier.id).phone}
                          onChange={(event) =>
                            updateAgentForm(supplier.id, {
                              ...agentForm(supplier.id),
                              phone: event.target.value
                            })
                          }
                          placeholder="Phone number"
                        />
                        <input
                          value={agentForm(supplier.id).notes}
                          onChange={(event) =>
                            updateAgentForm(supplier.id, {
                              ...agentForm(supplier.id),
                              notes: event.target.value
                            })
                          }
                          placeholder="Notes"
                        />
                        <button
                          type="button"
                          disabled={agentForm(supplier.id).name.trim() === ""}
                          onClick={() => {
                            props.onSaveSalesAgent(supplier.id, agentForm(supplier.id));
                            updateAgentForm(supplier.id, emptySupplierForm);
                          }}
                        >
                          Save agent
                        </button>
                      </div>
                      {supplier.salesAgents.length === 0 ? (
                        <p className="form-hint">No sales agents yet.</p>
                      ) : (
                        supplier.salesAgents.map((agent) => (
                          <article className="sales-agent-card" key={agent.id}>
                            <strong>{agent.name}</strong>
                            <span>{agent.phone ?? "No phone saved"}</span>
                            <small>
                              {agent.linkedPhonebookContactName === null
                                ? "Phone contact not linked"
                                : `Phone contact linked: ${agent.linkedPhonebookContactName}`}
                            </small>
                            <small>Supplier: {agent.supplierName}</small>
                            {agent.notes !== null ? <small>{agent.notes}</small> : null}
                            <small>Receipts: {agent.receiptsHandled}</small>
                            <small>
                              Last transaction:{" "}
                              {agent.lastTransactionDate === null
                                ? "None"
                                : new Date(agent.lastTransactionDate).toLocaleDateString()}
                            </small>
                            <div className="actions">
                              <button
                                className="secondary"
                                type="button"
                                onClick={() =>
                                  updateAgentForm(supplier.id, {
                                    id: agent.id,
                                    name: agent.name,
                                    phone: agent.phone ?? "",
                                    email: "",
                                    notes: agent.notes ?? ""
                                  })
                                }
                              >
                                Edit
                              </button>
                              <button
                                className="secondary"
                                type="button"
                                onClick={() => props.onDeleteSalesAgent(supplier.id, agent.id)}
                              >
                                Delete
                              </button>
                              {contactResults[0] !== undefined ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    props.onLinkSalesAgentContact(
                                      agent.id,
                                      contactResults[0]?.id ?? ""
                                    )
                                  }
                                >
                                  Link to phone contact
                                </button>
                              ) : null}
                            </div>
                          </article>
                        ))
                      )}
                    </section>
                    <section aria-label="Purchase receipts">
                      <div className="section-heading">
                        <p className="eyebrow">Purchase receipts</p>
                        <h4>Structured records</h4>
                      </div>
                      {supplier.purchaseReceipts.length === 0 ? (
                        <p className="form-hint">No purchase receipts saved yet.</p>
                      ) : (
                        supplier.purchaseReceipts.map((receipt) => (
                          <article className="mini-card" key={receipt.id}>
                            <strong>{new Date(receipt.receiptDate).toLocaleDateString()}</strong>
                            <span>{formatMoney(receipt.total)}</span>
                            <small>{receipt.salesAgentName ?? "No sales agent"}</small>
                            <ReceiptBindingCard
                              businessId={props.businessId}
                              receiptId={receipt.id}
                            />
                            <small>Image stored: {receipt.imageStored ? "Yes" : "No"}</small>
                          </article>
                        ))
                      )}
                    </section>
                    <SupplierContactRolesCard
                      businessId={props.businessId}
                      supplierId={supplier.id}
                    />
                  </div>
                ) : null}
              </article>
            )
          )
        )}
      </section>

      <section className="record-list" aria-label="All purchase receipts">
        <div className="section-heading">
          <p className="eyebrow">Purchase history</p>
          <h3>All purchase receipts</h3>
        </div>
        {props.purchaseReceipts.length === 0 ? (
          <div className="empty-record">
            <h3>No purchase receipts yet</h3>
            <p>Receipts confirmed from OCR uploads across every supplier appear here.</p>
          </div>
        ) : (
          props.purchaseReceipts.map((receipt) => (
            <article className="mini-card" key={receipt.id}>
              <strong>{new Date(receipt.receiptDate).toLocaleDateString()}</strong>
              <span>{receipt.supplierName}</span>
              <span>{formatMoney(receipt.total)}</span>
              <small>{receipt.salesAgentName ?? "No sales agent"}</small>
              <small>{receipt.lineItems.length} line item(s)</small>
              <small>Image stored: {receipt.imageStored ? "Yes" : "No"}</small>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
