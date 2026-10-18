import { useEffect, useState } from "react";
import type { CustomerSummary } from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { useApiMutationRevision } from "./hooks/useApiMutationRevision";
import { fetchFreshJson, patchJson, postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";

interface CustomerDraft {
  name: string;
  phone: string;
  email: string;
  notes: string;
}

const emptyDraft: CustomerDraft = { name: "", phone: "", email: "", notes: "" };

function draftFromCustomer(customer: CustomerSummary): CustomerDraft {
  return {
    name: customer.name,
    phone: customer.phone ?? "",
    email: customer.email ?? "",
    notes: customer.notes ?? ""
  };
}

// Self-contained generated-surface card for the customers domain (Phase 4c), mirroring
// ProductManagementCard/SupplierManagementCard's shape. See docs/frontend/frontend.md Phase 4c.
export default function CustomerManagementCard(props: { businessId: string; customerId?: string }) {
  const customersPath = `/businesses/${props.businessId}/customers`;
  const mutationRevision = useApiMutationRevision(customersPath);
  const { isPending, runAction } = useAsyncActions();
  const [customers, setCustomers] = useState<CustomerSummary[] | null>(null);
  const [message, setMessage] = useState("");
  const [editingId, setEditingId] = useState<string | null>(props.customerId ?? null);
  const [drafts, setDrafts] = useState<Record<string, CustomerDraft>>({});
  const [isAdding, setIsAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<CustomerDraft>(emptyDraft);

  useEffect(() => {
    let cancelled = false;
    void fetchFreshJson<CustomerSummary[]>(customersPath)
      .then((loaded) => {
        if (cancelled) return;
        setCustomers(loaded);
        setDrafts(
          Object.fromEntries(loaded.map((customer) => [customer.id, draftFromCustomer(customer)]))
        );
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [customersPath, mutationRevision]);

  function draftFor(customerId: string, customer: CustomerSummary): CustomerDraft {
    return drafts[customerId] ?? draftFromCustomer(customer);
  }

  async function saveEdit(customer: CustomerSummary) {
    const draft = draftFor(customer.id, customer);
    if (draft.name.trim().length === 0) {
      setMessage("Enter a customer name.");
      return;
    }
    const updated = await patchJson<CustomerSummary>(
      `/businesses/${props.businessId}/customers/${customer.id}`,
      {
        name: draft.name.trim(),
        phone: draft.phone.trim() || null,
        email: draft.email.trim() || null,
        notes: draft.notes.trim() || null
      }
    );
    setCustomers((current) =>
      (current ?? []).map((item) => (item.id === updated.id ? updated : item))
    );
    setEditingId(null);
    setMessage(`${updated.name} updated`);
  }

  async function addCustomer() {
    if (addDraft.name.trim().length === 0) {
      setMessage("Enter a customer name.");
      return;
    }
    const created = await postJson<CustomerSummary>(`/businesses/${props.businessId}/customers`, {
      name: addDraft.name.trim(),
      phone: addDraft.phone.trim() || null,
      email: addDraft.email.trim() || null,
      notes: addDraft.notes.trim() || null
    });
    setCustomers((current) => [created, ...(current ?? [])]);
    setAddDraft(emptyDraft);
    setIsAdding(false);
    setMessage(`${created.name} added`);
  }

  if (customers === null) {
    return (
      <section className="record-form customer-management-card" aria-label="Customers">
        {message.length > 0 ? <p className="shell-note">{message}</p> : <p>Loading customers…</p>}
      </section>
    );
  }

  return (
    <section className="record-form customer-management-card" aria-label="Manage customers">
      <div className="section-heading">
        <p className="eyebrow">Customers</p>
        <h3>Manage customers from chat</h3>
      </div>
      {message.length > 0 ? <p className="shell-note">{message}</p> : null}
      <div className="row-actions">
        <button type="button" onClick={() => setIsAdding((open) => !open)}>
          {isAdding ? "Cancel" : "Add customer"}
        </button>
      </div>
      {isAdding ? (
        <div className="customer-management-item">
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
            disabled={isPending("customer-management-add")}
            onClick={() =>
              void runAction("customer-management-add", async () => {
                try {
                  await addCustomer();
                } catch (error) {
                  setMessage(getUserFacingErrorMessage(error));
                }
              })
            }
          >
            Save customer
          </button>
        </div>
      ) : null}
      {customers.length === 0 ? <p className="shell-note">No customers yet.</p> : null}
      {customers.map((customer) => {
        const isEditing = editingId === customer.id;
        const draft = draftFor(customer.id, customer);
        return (
          <div className="customer-management-item" key={customer.id}>
            {isEditing ? (
              <>
                <label>
                  Name
                  <input
                    value={draft.name}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [customer.id]: { ...draft, name: event.target.value }
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
                        [customer.id]: { ...draft, phone: event.target.value }
                      }))
                    }
                  />
                </label>
                <div className="row-actions">
                  <button
                    type="button"
                    disabled={isPending(`customer-management-save-${customer.id}`)}
                    onClick={() =>
                      void runAction(`customer-management-save-${customer.id}`, async () => {
                        try {
                          await saveEdit(customer);
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
                  <strong>{customer.name}</strong>
                  <br />
                  {customer.phone ?? "No phone"}
                </p>
                <div className="row-actions">
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => setEditingId(customer.id)}
                  >
                    Edit
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
