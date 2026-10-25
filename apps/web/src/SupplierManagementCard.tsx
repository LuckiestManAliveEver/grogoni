import { DeliveryReceiptReviewPanel } from "./DeliveryReceiptReviewPanel";
import { useEffect, useState } from "react";
import SupplierOfferPanel from "./SupplierOfferPanel";
import PurchaseOrderPanel from "./PurchaseOrderPanel";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { useApiMutationRevision } from "./hooks/useApiMutationRevision";
import { deleteJson, fetchFreshJson, patchJson, postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";
import type { SupplierBusinessCardSummary, SupplierSummary } from "./grogoni-application-shared";

interface SupplierDraft {
  name: string;
  phone: string;
  email: string;
  notes: string;
}

const emptyDraft: SupplierDraft = { name: "", phone: "", email: "", notes: "" };

function draftFromSupplier(supplier: SupplierBusinessCardSummary): SupplierDraft {
  return {
    name: supplier.name,
    phone: supplier.phone ?? "",
    email: supplier.email ?? "",
    notes: supplier.notes ?? ""
  };
}

// Self-contained generated-surface card for the suppliers domain (Phase 4b), mirroring
// ProductManagementCard's shape: fetches its own data from businessId alone rather than reusing
// useSuppliersState, which needs loadReports/registerReset/registerRefresh tied to sibling hooks
// in GrogoniApplication.tsx. See docs/frontend/frontend.md Phase 4b.
export default function SupplierManagementCard(props: { businessId: string; supplierId?: string }) {
  const suppliersPath = `/businesses/${props.businessId}/suppliers`;
  const mutationRevision = useApiMutationRevision(suppliersPath);
  const { isPending, runAction } = useAsyncActions();
  const [suppliers, setSuppliers] = useState<SupplierBusinessCardSummary[] | null>(null);
  const [message, setMessage] = useState("");
  const [editingId, setEditingId] = useState<string | null>(props.supplierId ?? null);
  const [drafts, setDrafts] = useState<Record<string, SupplierDraft>>({});
  const [isAdding, setIsAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<SupplierDraft>(emptyDraft);

  useEffect(() => {
    let cancelled = false;
    void fetchFreshJson<SupplierBusinessCardSummary[]>(suppliersPath)
      .then((loaded) => {
        if (cancelled) return;
        setSuppliers(loaded);
        setDrafts(
          Object.fromEntries(loaded.map((supplier) => [supplier.id, draftFromSupplier(supplier)]))
        );
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [suppliersPath, mutationRevision]);

  function draftFor(supplierId: string, supplier: SupplierBusinessCardSummary): SupplierDraft {
    return drafts[supplierId] ?? draftFromSupplier(supplier);
  }

  async function saveEdit(supplier: SupplierBusinessCardSummary) {
    const draft = draftFor(supplier.id, supplier);
    if (draft.name.trim().length === 0) {
      setMessage("Enter a supplier name.");
      return;
    }
    const updated = await patchJson<SupplierSummary>(
      `/businesses/${props.businessId}/suppliers/${supplier.id}`,
      {
        name: draft.name.trim(),
        phone: draft.phone.trim() || null,
        email: draft.email.trim() || null,
        notes: draft.notes.trim() || null
      }
    );
    setSuppliers((current) =>
      (current ?? []).map((item) => (item.id === updated.id ? { ...item, ...updated } : item))
    );
    setEditingId(null);
    setMessage(`${updated.name} updated`);
  }

  async function removeSupplier(supplier: SupplierBusinessCardSummary) {
    if (!window.confirm(`Delete ${supplier.name}? This cannot be undone.`)) return;
    await deleteJson<{ deleted: true; supplierId: string }>(
      `/businesses/${props.businessId}/suppliers/${supplier.id}`
    );
    setSuppliers((current) => (current ?? []).filter((item) => item.id !== supplier.id));
    setMessage(`${supplier.name} removed`);
  }

  async function addSupplier() {
    if (addDraft.name.trim().length === 0) {
      setMessage("Enter a supplier name.");
      return;
    }
    const created = await postJson<SupplierSummary>(`/businesses/${props.businessId}/suppliers`, {
      name: addDraft.name.trim(),
      phone: addDraft.phone.trim() || null,
      email: addDraft.email.trim() || null,
      notes: addDraft.notes.trim() || null
    });
    setSuppliers((current) => [
      { ...created, salesAgents: [], purchaseReceipts: [] },
      ...(current ?? [])
    ]);
    setAddDraft(emptyDraft);
    setIsAdding(false);
    setMessage(`${created.name} added`);
  }

  if (suppliers === null) {
    return (
      <section className="record-form supplier-management-card" aria-label="Suppliers">
        {message.length > 0 ? <p className="shell-note">{message}</p> : <p>Loading suppliers…</p>}
      </section>
    );
  }

  return (
    <section className="record-form supplier-management-card" aria-label="Manage suppliers">
      <div className="section-heading">
        <p className="eyebrow">Suppliers</p>
        <h3>Manage suppliers from chat</h3>
      </div>
      <DeliveryReceiptReviewPanel
        key={`receipts:${props.businessId}`}
        businessId={props.businessId}
      />
      <SupplierOfferPanel
        key={props.businessId}
        businessId={props.businessId}
        suppliers={suppliers}
      />
      <PurchaseOrderPanel
        key={`orders:${props.businessId}`}
        businessId={props.businessId}
        suppliers={suppliers}
      />
      {message.length > 0 ? <p className="shell-note">{message}</p> : null}
      <div className="row-actions">
        <button type="button" onClick={() => setIsAdding((open) => !open)}>
          {isAdding ? "Cancel" : "Add supplier"}
        </button>
      </div>
      {isAdding ? (
        <div className="supplier-management-item">
          <label>
            Name
            <input
              value={addDraft.name}
              onChange={(event) =>
                setAddDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
          </label>
          <label>
            Phone
            <input
              value={addDraft.phone}
              onChange={(event) =>
                setAddDraft((current) => ({ ...current, phone: event.target.value }))
              }
            />
          </label>
          <button
            type="button"
            disabled={isPending("supplier-management-add")}
            onClick={() =>
              void runAction("supplier-management-add", async () => {
                try {
                  await addSupplier();
                } catch (error) {
                  setMessage(getUserFacingErrorMessage(error));
                }
              })
            }
          >
            Save supplier
          </button>
        </div>
      ) : null}
      {suppliers.length === 0 ? <p className="shell-note">No suppliers yet.</p> : null}
      {suppliers.map((supplier) => {
        const isEditing = editingId === supplier.id;
        const draft = draftFor(supplier.id, supplier);
        return (
          <div className="supplier-management-item" key={supplier.id}>
            {isEditing ? (
              <>
                <label>
                  Name
                  <input
                    value={draft.name}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [supplier.id]: { ...draft, name: event.target.value }
                      }))
                    }
                  />
                </label>
                <label>
                  Phone
                  <input
                    value={draft.phone}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [supplier.id]: { ...draft, phone: event.target.value }
                      }))
                    }
                  />
                </label>
                <div className="row-actions">
                  <button
                    type="button"
                    disabled={isPending(`supplier-management-save-${supplier.id}`)}
                    onClick={() =>
                      void runAction(`supplier-management-save-${supplier.id}`, async () => {
                        try {
                          await saveEdit(supplier);
                        } catch (error) {
                          setMessage(getUserFacingErrorMessage(error));
                        }
                      })
                    }
                  >
                    Save
                  </button>
                  <button className="secondary" type="button" onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  <strong>{supplier.name}</strong>
                  <br />
                  {supplier.phone ?? "No phone"}
                </p>
                <div className="row-actions">
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => setEditingId(supplier.id)}
                  >
                    Edit
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    disabled={isPending(`supplier-management-delete-${supplier.id}`)}
                    onClick={() =>
                      void runAction(`supplier-management-delete-${supplier.id}`, async () => {
                        try {
                          await removeSupplier(supplier);
                        } catch (error) {
                          setMessage(getUserFacingErrorMessage(error));
                        }
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}
