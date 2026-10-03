import { useEffect, useState } from "react";
import type {
  CanonicalContactSummary,
  SupplierContactRelationshipSummary,
  SupplierContactRole
} from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { useApiMutationRevision } from "./hooks/useApiMutationRevision";
import { deleteJson, getJson, postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";

const supplierContactRoles: SupplierContactRole[] = [
  "OWNER",
  "SALES_AGENT",
  "DELIVERY_AGENT",
  "DRIVER",
  "ACCOUNT_MANAGER",
  "OTHER"
];

// Self-contained management card assigning canonical contacts to a supplier's roles (owner, sales
// agent, delivery agent, driver, account manager, other), added by the "contact-synced supplier,
// purchase, sale, and route history" backend change. Mirrors SupplierManagementCard's shape:
// fetches its own data from businessId/supplierId alone, not useSuppliersState.
export default function SupplierContactRolesCard(props: {
  businessId: string;
  supplierId: string;
}) {
  const relationshipsPath = `/businesses/${props.businessId}/suppliers/${props.supplierId}/contacts`;
  const contactsPath = `/businesses/${props.businessId}/contacts`;
  const mutationRevision = useApiMutationRevision(relationshipsPath, contactsPath);
  const { isPending, runAction } = useAsyncActions();
  const [relationships, setRelationships] = useState<SupplierContactRelationshipSummary[] | null>(
    null
  );
  const [contacts, setContacts] = useState<CanonicalContactSummary[]>([]);
  const [message, setMessage] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState("");
  const [selectedRole, setSelectedRole] = useState<SupplierContactRole>("OTHER");
  const [isPrimary, setIsPrimary] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getJson<SupplierContactRelationshipSummary[]>(relationshipsPath)
      .then((loaded) => {
        if (!cancelled) setRelationships(loaded);
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    void getJson<CanonicalContactSummary[]>(contactsPath)
      .then((loaded) => {
        if (!cancelled) setContacts(loaded);
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [relationshipsPath, contactsPath, mutationRevision]);

  function contactName(contactId: string | null): string {
    if (contactId === null) return "Sales agent record (no linked contact)";
    return contacts.find((contact) => contact.id === contactId)?.displayName ?? contactId;
  }

  async function addRelationship() {
    if (selectedContactId.length === 0) {
      setMessage("Choose a contact to assign.");
      return;
    }
    const created = await postJson<SupplierContactRelationshipSummary>(relationshipsPath, {
      contactId: selectedContactId,
      role: selectedRole,
      isPrimary
    });
    setRelationships((current) => [created, ...(current ?? []).filter((r) => r.id !== created.id)]);
    setSelectedContactId("");
    setIsPrimary(false);
    setIsAdding(false);
    setMessage(`${contactName(created.contactId)} assigned as ${created.role}`);
  }

  async function removeRelationship(relationship: SupplierContactRelationshipSummary) {
    if (!window.confirm(`Remove ${contactName(relationship.contactId)} from this supplier?`))
      return;
    await deleteJson<SupplierContactRelationshipSummary>(
      `/businesses/${props.businessId}/supplier-contacts/${relationship.id}`
    );
    setRelationships((current) => (current ?? []).filter((item) => item.id !== relationship.id));
    setMessage(`${contactName(relationship.contactId)} removed`);
  }

  if (relationships === null) {
    return (
      <section className="record-form supplier-contact-roles-card" aria-label="Supplier contacts">
        {message.length > 0 ? <p className="shell-note">{message}</p> : <p>Loading contacts…</p>}
      </section>
    );
  }

  return (
    <section
      className="record-form supplier-contact-roles-card"
      aria-label="Supplier contact roles"
    >
      <div className="section-heading">
        <p className="eyebrow">Contact roles</p>
        <h4>Assigned to this supplier</h4>
      </div>
      {message.length > 0 ? <p className="shell-note">{message}</p> : null}
      <div className="row-actions">
        <button type="button" onClick={() => setIsAdding((open) => !open)}>
          {isAdding ? "Cancel" : "Assign contact"}
        </button>
      </div>
      {isAdding ? (
        <div className="supplier-contact-role-item">
          <label>
            Contact
            <select
              value={selectedContactId}
              onChange={(event) => setSelectedContactId(event.target.value)}
            >
              <option value="">Choose a contact…</option>
              {contacts.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Role
            <select
              value={selectedRole}
              onChange={(event) => setSelectedRole(event.target.value as SupplierContactRole)}
            >
              {supplierContactRoles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(event) => setIsPrimary(event.target.checked)}
            />
            Primary for this role
          </label>
          <button
            type="button"
            disabled={isPending("supplier-contact-role-add")}
            onClick={() =>
              void runAction("supplier-contact-role-add", async () => {
                try {
                  await addRelationship();
                } catch (error) {
                  setMessage(getUserFacingErrorMessage(error));
                }
              })
            }
          >
            Save assignment
          </button>
        </div>
      ) : null}
      {relationships.length === 0 ? (
        <p className="shell-note">No contacts assigned to this supplier yet.</p>
      ) : (
        relationships.map((relationship) => (
          <div className="supplier-contact-role-item" key={relationship.id}>
            <p>
              <strong>{contactName(relationship.contactId)}</strong>
              <br />
              {relationship.role}
              {relationship.isPrimary ? " · Primary" : ""}
            </p>
            <div className="row-actions">
              <button
                className="secondary"
                type="button"
                disabled={isPending(`supplier-contact-role-remove-${relationship.id}`)}
                onClick={() =>
                  void runAction(`supplier-contact-role-remove-${relationship.id}`, async () => {
                    try {
                      await removeRelationship(relationship);
                    } catch (error) {
                      setMessage(getUserFacingErrorMessage(error));
                    }
                  })
                }
              >
                Remove
              </button>
            </div>
          </div>
        ))
      )}
    </section>
  );
}
