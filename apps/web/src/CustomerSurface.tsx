import { type CustomerFormState, type CustomerSummary } from "./grogoni-application-shared";
import ShopLocationCard from "./ShopLocationCard";

export interface CustomerSurfaceProps {
  businessId: string;
  customers: CustomerSummary[];
  form: CustomerFormState;
  onFormChange: (form: CustomerFormState) => void;
  onSave: () => void;
  onReset: () => void;
  onEdit: (customer: CustomerSummary) => void;
}

export function CustomerSurface(props: CustomerSurfaceProps) {
  return (
    <div className="records-surface">
      <section className="record-form" aria-label="Customer form">
        <div className="section-heading">
          <p className="eyebrow">{props.form.id === null ? "New customer" : "Edit customer"}</p>
          <h3>{props.form.id === null ? "Add customer" : "Update customer"}</h3>
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

      {props.form.id === null ? null : (
        <ShopLocationCard businessId={props.businessId} customerId={props.form.id} />
      )}

      <section className="record-list" aria-label="Customers">
        {props.customers.length === 0 ? (
          <div className="empty-record">
            <h3>No customers yet</h3>
            <p>Add the first customer to start customer records.</p>
          </div>
        ) : (
          props.customers.map((customer) => (
            <article className="record-row" key={customer.id}>
              <div>
                <strong>{customer.name}</strong>
                <span>{customer.phone ?? customer.email ?? "No contact saved"}</span>
              </div>
              <button type="button" onClick={() => props.onEdit(customer)}>
                Edit
              </button>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
