import {
  type DocumentImportDraft,
  type DocumentImportPreviewRow,
  type ProductImportDraft,
  type SupplierImportDraft
} from "./grogoni-application-shared";

export interface ImportRowEditorProps {
  importJobId: string;
  row: DocumentImportPreviewRow;
  disabled: boolean;
  onRowChange: (input: {
    importJobId: string;
    rowNumber: number;
    mapped: DocumentImportDraft;
    selected: boolean;
  }) => void;
  onSave: () => void;
}

export function SupplierImportRowEditor(props: ImportRowEditorProps) {
  const mapped = asSupplierImportDraft(props.row.mapped);

  function updateMapped(mapped: SupplierImportDraft, selected = props.row.selected) {
    props.onRowChange({
      importJobId: props.importJobId,
      rowNumber: props.row.rowNumber,
      mapped,
      selected
    });
  }

  return (
    <article className="import-row">
      <div className="import-row-header">
        <label className="inline-check">
          <input
            checked={props.row.selected}
            disabled={props.disabled}
            type="checkbox"
            onChange={(event) =>
              props.onRowChange({
                importJobId: props.importJobId,
                rowNumber: props.row.rowNumber,
                mapped,
                selected: event.target.checked
              })
            }
          />
          Row {props.row.rowNumber}
        </label>
        <span>{props.row.errors.length === 0 ? "Valid" : "Needs correction"}</span>
      </div>
      <div className="form-row">
        <label>
          Name
          <input
            value={mapped.name}
            disabled={props.disabled}
            onChange={(event) => updateMapped({ ...mapped, name: event.target.value })}
          />
        </label>
        <label>
          Phone
          <input
            value={mapped.phone ?? ""}
            disabled={props.disabled}
            onChange={(event) => updateMapped({ ...mapped, phone: event.target.value || null })}
          />
        </label>
      </div>
      <div className="form-row">
        <label>
          Email
          <input
            value={mapped.email ?? ""}
            disabled={props.disabled}
            onChange={(event) => updateMapped({ ...mapped, email: event.target.value || null })}
          />
        </label>
        <label>
          Notes
          <input
            value={mapped.notes ?? ""}
            disabled={props.disabled}
            onChange={(event) => updateMapped({ ...mapped, notes: event.target.value || null })}
          />
        </label>
      </div>
      {props.row.errors.length > 0 ? <p>{props.row.errors.join(" ")}</p> : null}
      <button type="button" onClick={props.onSave} disabled={props.disabled}>
        Save row
      </button>
    </article>
  );
}

export function ProductImportRowEditor(props: ImportRowEditorProps) {
  const mapped = asProductImportDraft(props.row.mapped);

  function updateMapped(mapped: ProductImportDraft, selected = props.row.selected) {
    props.onRowChange({
      importJobId: props.importJobId,
      rowNumber: props.row.rowNumber,
      mapped,
      selected
    });
  }

  return (
    <article className="import-row">
      <div className="import-row-header">
        <label className="inline-check">
          <input
            checked={props.row.selected}
            disabled={props.disabled}
            type="checkbox"
            onChange={(event) =>
              props.onRowChange({
                importJobId: props.importJobId,
                rowNumber: props.row.rowNumber,
                mapped,
                selected: event.target.checked
              })
            }
          />
          Row {props.row.rowNumber}
        </label>
        <span>{props.row.errors.length === 0 ? "Valid" : "Needs correction"}</span>
      </div>
      <div className="form-row">
        <label>
          Name
          <input
            value={mapped.name}
            disabled={props.disabled}
            onChange={(event) => updateMapped({ ...mapped, name: event.target.value })}
          />
        </label>
        <label>
          SKU
          <input
            value={mapped.sku ?? ""}
            disabled={props.disabled}
            onChange={(event) => updateMapped({ ...mapped, sku: event.target.value || null })}
          />
        </label>
      </div>
      <div className="form-row">
        <label>
          Unit
          <input
            value={mapped.unit}
            disabled={props.disabled}
            onChange={(event) => updateMapped({ ...mapped, unit: event.target.value || "unit" })}
          />
        </label>
        <label>
          Quantity
          <input
            min="0"
            type="number"
            value={mapped.quantity}
            disabled={props.disabled}
            onChange={(event) =>
              updateMapped({ ...mapped, quantity: Number.parseFloat(event.target.value) || 0 })
            }
          />
        </label>
      </div>
      <div className="form-row">
        <label>
          Buying price
          <input
            min="0"
            type="number"
            value={mapped.buyingPrice ?? ""}
            disabled={props.disabled}
            onChange={(event) =>
              updateMapped({
                ...mapped,
                buyingPrice:
                  event.target.value === "" ? null : Number.parseFloat(event.target.value)
              })
            }
          />
        </label>
        <label>
          Selling price
          <input
            min="0"
            type="number"
            value={mapped.sellingPrice ?? ""}
            disabled={props.disabled}
            onChange={(event) =>
              updateMapped({
                ...mapped,
                sellingPrice:
                  event.target.value === "" ? null : Number.parseFloat(event.target.value)
              })
            }
          />
        </label>
      </div>
      {props.row.errors.length > 0 ? <p>{props.row.errors.join(" ")}</p> : null}
      <button type="button" onClick={props.onSave} disabled={props.disabled}>
        Save row
      </button>
    </article>
  );
}

export function asSupplierImportDraft(mapped: DocumentImportDraft): SupplierImportDraft {
  return {
    name: mapped.name,
    phone: "phone" in mapped ? mapped.phone : null,
    email: "email" in mapped ? mapped.email : null,
    notes: "notes" in mapped ? mapped.notes : null
  };
}

export function asProductImportDraft(mapped: DocumentImportDraft): ProductImportDraft {
  return {
    name: mapped.name,
    sku: "sku" in mapped ? mapped.sku : null,
    unit: "unit" in mapped ? mapped.unit : "unit",
    quantity: "quantity" in mapped ? mapped.quantity : 0,
    buyingPrice: "buyingPrice" in mapped ? mapped.buyingPrice : null,
    sellingPrice: "sellingPrice" in mapped ? mapped.sellingPrice : null
  };
}
