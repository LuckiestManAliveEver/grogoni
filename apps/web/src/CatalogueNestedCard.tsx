import { lazy, Suspense } from "react";
import { loadLazyModuleWithRecovery } from "./lazy-module-recovery";
const CommerceSourcesPanel = lazy(() =>
  loadLazyModuleWithRecovery("commerce-sources", () => import("./CommerceSourcesPanel"))
);
import { useEffect, useState } from "react";

import type { ProductFieldDefinition, ProductFieldInputType } from "@grogoni/shared-types";

import {
  type ProductFieldDraft,
  type ProductFormState,
  type ProductSummary
} from "./grogoni-application-shared";

import { formatOptionalMoney } from "./formatters";

import { createProductFieldDraft } from "./owner-app-bootstrap";
import CatalogueBrowsePanel from "./CatalogueBrowsePanel";
import CatalogueShareSettingsCard from "./CatalogueShareSettingsCard";

export function CatalogueNestedCard({
  businessId,
  fields,
  form,
  products,
  view,
  onBack,
  onChangeForm,
  onDeleteProduct,
  onEditProduct,
  onOpenAdd,
  onOpenDelete,
  onOpenEdit,
  onOpenFields,
  onOpenProduct,
  onSaveFields,
  onSaveProduct,
  onProductsDuplicated
}: {
  businessId: string | null;
  fields: ProductFieldDefinition[];
  form: ProductFormState;
  products: ProductSummary[];
  view: "catalogue" | "addProduct" | "editProduct" | "deleteProduct" | "manageFields";
  onBack: () => void;
  onChangeForm: (form: ProductFormState) => void;
  onDeleteProduct: (productId: string) => void;
  onEditProduct: (product: ProductSummary) => void;
  onOpenAdd: () => void;
  onOpenDelete: () => void;
  onOpenEdit: () => void;
  onOpenFields: () => void;
  onOpenProduct: (product: ProductSummary) => void;
  onSaveFields: (fields: ProductFieldDraft[]) => void;
  onSaveProduct: () => Promise<void>;
  onProductsDuplicated: () => void;
}) {
  const [isBrowsingCatalogues, setIsBrowsingCatalogues] = useState(false);
  const [managedFields, setManagedFields] = useState<ProductFieldDraft[]>(() =>
    fields.map((field) => ({ ...field, value: "" }))
  );

  useEffect(() => {
    setManagedFields(fields.map((field) => ({ ...field, value: "" })));
  }, [fields]);

  function updateManagedField(fieldId: string, patch: Partial<ProductFieldDraft>) {
    setManagedFields((fields) =>
      fields.map((field) => (field.id === fieldId ? { ...field, ...patch } : field))
    );
  }

  function moveManagedField(fieldId: string, direction: -1 | 1) {
    setManagedFields((fields) => {
      const index = fields.findIndex((field) => field.id === fieldId);
      const nextIndex = index + direction;

      if (index < 0 || nextIndex < 0 || nextIndex >= fields.length) {
        return fields;
      }

      const nextFields = [...fields];
      const [field] = nextFields.splice(index, 1);

      if (field === undefined) {
        return fields;
      }

      nextFields.splice(nextIndex, 0, field);
      return nextFields;
    });
  }

  function removeManagedField(fieldId: string) {
    setManagedFields((fields) => fields.filter((field) => field.id !== fieldId || field.required));
  }

  if (view === "catalogue") {
    return (
      <div className="nested-card catalogue-card">
        <button className="nested-breadcrumb" type="button" onClick={onBack}>
          &lt; Workspace
        </button>
        <div className="nested-card-title-row">
          <div>
            <h3>Catalogue</h3>
            <p>Manage your products and menu</p>
          </div>
          <span className="count-badge">{products.length}</span>
        </div>
        {businessId ? (
          <Suspense fallback={null}>
            <CommerceSourcesPanel businessId={businessId} products={products} />
          </Suspense>
        ) : null}
        <div className="catalogue-action-grid" aria-label="Catalogue actions">
          <button className="success" type="button" onClick={onOpenAdd}>
            <span>+</span>
            Add Product
          </button>
          <button type="button" onClick={onOpenEdit}>
            <span>Edit</span>
            Edit Product
          </button>
          <button className="danger" type="button" onClick={onOpenDelete}>
            <span>Del</span>
            Delete Product
          </button>
          <button className="secondary" type="button" onClick={onOpenFields}>
            <span>Fields</span>
            Manage Fields
          </button>
        </div>
        <div className="nested-list-heading">
          <strong>Existing products</strong>
          <span>{products.length}</span>
        </div>
        {products.length === 0 ? (
          <div className="catalogue-empty-state">
            <div className="catalogue-empty-icon" aria-hidden="true" />
            <h3>No products yet</h3>
            <p>Add the first product to start stock records.</p>
            <button type="button" onClick={onOpenAdd}>
              Add product
            </button>
          </div>
        ) : (
          <div className="nested-product-list">
            {products.map((product) => (
              <button type="button" key={product.id} onClick={() => onOpenProduct(product)}>
                <span>
                  <strong>{product.name}</strong>
                  <small>
                    {product.sku ?? "No SKU"} - {product.quantity} {product.unit} -{" "}
                    {formatOptionalMoney(product.sellingPrice)}
                  </small>
                </span>
                <span aria-hidden="true">&gt;</span>
              </button>
            ))}
          </div>
        )}
        {businessId === null ? null : (
          <>
            <div className="row-actions">
              <button
                className="secondary"
                type="button"
                onClick={() => setIsBrowsingCatalogues((open) => !open)}
              >
                {isBrowsingCatalogues ? "Cancel" : "Browse shared catalogues"}
              </button>
            </div>
            {isBrowsingCatalogues ? (
              <CatalogueBrowsePanel
                businessId={businessId}
                onDuplicated={onProductsDuplicated}
                onClose={() => setIsBrowsingCatalogues(false)}
              />
            ) : null}
            <CatalogueShareSettingsCard businessId={businessId} />
          </>
        )}
      </div>
    );
  }

  if (view === "deleteProduct") {
    return (
      <div className="nested-card">
        <button className="nested-breadcrumb" type="button" onClick={onBack}>
          &lt; Catalogue
        </button>
        <div className="nested-card-title-row">
          <div>
            <h3>Delete Product</h3>
            <p>Select a product to remove from stock records.</p>
          </div>
        </div>
        {products.length === 0 ? (
          <div className="catalogue-empty-state compact">
            <h3>No products yet</h3>
            <p>There are no product records to delete.</p>
          </div>
        ) : (
          <div className="nested-product-list danger-list">
            {products.map((product) => (
              <button type="button" key={product.id} onClick={() => onDeleteProduct(product.id)}>
                <span>
                  <strong>{product.name}</strong>
                  <small>{product.sku ?? "No SKU"}</small>
                </span>
                <span>Delete</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (view === "manageFields") {
    return (
      <div className="nested-card">
        <button className="nested-breadcrumb" type="button" onClick={onBack}>
          &lt; Catalogue
        </button>
        <div className="nested-card-title-row">
          <div>
            <h3>Manage Fields</h3>
            <p>Add, remove, or reorder catalogue fields.</p>
          </div>
          <button
            className="small-outline-button"
            type="button"
            onClick={() =>
              setManagedFields((fields) => [...fields, createProductFieldDraft("Custom field")])
            }
          >
            + Add field
          </button>
        </div>
        <div className="field-manager-list">
          {managedFields.map((field, index) => (
            <div className="field-manager-row" key={field.id}>
              <span className="drag-handle">::</span>
              <label>
                Label
                <input
                  value={field.label}
                  onChange={(event) => updateManagedField(field.id, { label: event.target.value })}
                />
              </label>
              <label>
                Type
                <select
                  value={field.inputType}
                  onChange={(event) =>
                    updateManagedField(field.id, {
                      inputType: event.target.value as ProductFieldInputType
                    })
                  }
                >
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="select">Select</option>
                  <option value="textarea">Textarea</option>
                  <option value="yes_no">Yes/no</option>
                </select>
              </label>
              <div className="field-manager-actions">
                <button
                  type="button"
                  onClick={() => moveManagedField(field.id, -1)}
                  disabled={index === 0}
                >
                  Up
                </button>
                <button
                  type="button"
                  onClick={() => moveManagedField(field.id, 1)}
                  disabled={index === managedFields.length - 1}
                >
                  Down
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => removeManagedField(field.id)}
                  disabled={field.required}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="nested-form-actions">
          <button className="secondary" type="button" onClick={onBack}>
            Cancel
          </button>
          <button type="button" onClick={() => onSaveFields(managedFields)}>
            Save structure
          </button>
        </div>
      </div>
    );
  }

  return (
    <ProductNestedEditor
      fields={fields}
      form={form}
      isEdit={view === "editProduct"}
      products={products}
      onAddField={onOpenFields}
      onBack={onBack}
      onChangeForm={onChangeForm}
      onEditProduct={onEditProduct}
      onSave={onSaveProduct}
    />
  );
}

export function ProductNestedEditor({
  fields,
  form,
  isEdit,
  products,
  onAddField,
  onBack,
  onChangeForm,
  onEditProduct,
  onSave
}: {
  fields: ProductFieldDefinition[];
  form: ProductFormState;
  isEdit: boolean;
  products: ProductSummary[];
  onAddField: () => void;
  onBack: () => void;
  onChangeForm: (form: ProductFormState) => void;
  onEditProduct: (product: ProductSummary) => void;
  onSave: () => Promise<void>;
}) {
  const customFields = fields.filter((field) => !builtInProductFieldIds.has(field.id));
  const hasMissingRequiredField = customFields.some(
    (field) => field.required && (form.fieldValues[field.id] ?? "").trim().length === 0
  );

  return (
    <div className="nested-card">
      <button className="nested-breadcrumb" type="button" onClick={onBack}>
        &lt; Catalogue
      </button>
      <div className="nested-card-title-row">
        <div>
          <h3>{isEdit ? "Edit Product" : "Add Product"}</h3>
          <p>{isEdit ? "Update stock item details." : "Create a new stock item."}</p>
        </div>
        <button className="small-outline-button" type="button" onClick={onAddField}>
          + Add field
        </button>
      </div>
      {isEdit ? (
        <label>
          Product
          <select
            value={form.id ?? ""}
            onChange={(event) => {
              const product = products.find((item) => item.id === event.target.value);

              if (product !== undefined) {
                onEditProduct(product);
              }
            }}
          >
            <option value="">Select product</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="nested-form-section">
        <div className="nested-form-section-heading">
          <strong>Basic details</strong>
          <button className="small-outline-button" type="button" onClick={onAddField}>
            + Add field
          </button>
        </div>
        <label>
          Name *
          <input
            value={form.name}
            placeholder="Enter product name"
            onChange={(event) => onChangeForm({ ...form, name: event.target.value })}
          />
        </label>
        <label>
          SKU *
          <input
            value={form.sku}
            placeholder="Enter SKU"
            onChange={(event) => onChangeForm({ ...form, sku: event.target.value })}
          />
        </label>
        <label>
          Unit
          <select
            value={form.unit}
            onChange={(event) => onChangeForm({ ...form, unit: event.target.value })}
          >
            <option value="unit">unit</option>
            <option value="piece">piece</option>
            <option value="kg">kg</option>
            <option value="litre">litre</option>
            <option value="box">box</option>
          </select>
        </label>
        <label>
          Quantity
          <input
            value={form.quantity}
            inputMode="decimal"
            onChange={(event) => onChangeForm({ ...form, quantity: event.target.value })}
          />
        </label>
        <label>
          Selling Price
          <input
            value={form.sellingPrice}
            inputMode="decimal"
            placeholder="0.00"
            onChange={(event) => onChangeForm({ ...form, sellingPrice: event.target.value })}
          />
        </label>
        {customFields.map((field) => (
          <ProductFieldControl
            field={field}
            key={field.id}
            value={form.fieldValues[field.id] ?? ""}
            onChange={(value) =>
              onChangeForm({
                ...form,
                fieldValues: { ...form.fieldValues, [field.id]: value }
              })
            }
          />
        ))}
      </div>
      <details className="nested-form-section">
        <summary>Advanced details</summary>
        <label>
          Buying price
          <input
            value={form.buyingPrice}
            inputMode="decimal"
            placeholder="Optional"
            onChange={(event) => onChangeForm({ ...form, buyingPrice: event.target.value })}
          />
        </label>
        <button className="small-outline-button" type="button" onClick={onAddField}>
          + Add field
        </button>
      </details>
      <div className="nested-form-actions">
        <button className="secondary" type="button" onClick={onBack}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={form.name.trim().length === 0 || hasMissingRequiredField}
        >
          Save
        </button>
      </div>
    </div>
  );
}

const builtInProductFieldIds = new Set(["name", "sku", "unit", "quantity", "selling-price"]);

function ProductFieldControl({
  field,
  value,
  onChange
}: {
  field: ProductFieldDefinition;
  value: string;
  onChange: (value: string) => void;
}) {
  const label = `${field.label}${field.required ? " *" : ""}`;

  if (field.inputType === "textarea") {
    return (
      <label>
        {label}
        <textarea
          value={value}
          placeholder={field.label}
          required={field.required}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }

  if (field.inputType === "yes_no") {
    return (
      <label>
        {label}
        <select
          value={value}
          required={field.required}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Select</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </label>
    );
  }

  return (
    <label>
      {label}
      <input
        value={value}
        type={field.inputType === "number" ? "number" : "text"}
        inputMode={field.inputType === "number" ? "decimal" : undefined}
        placeholder={field.label}
        required={field.required}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
