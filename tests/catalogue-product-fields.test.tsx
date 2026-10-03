// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProductNestedEditor } from "../apps/web/src/CatalogueNestedCard";
import { emptyProductForm } from "../apps/web/src/grogoni-application-shared";

const fields = [
  { id: "name", label: "Name", inputType: "text" as const, required: true },
  { id: "color", label: "Color", inputType: "text" as const, required: true },
  { id: "notes", label: "Product notes", inputType: "textarea" as const, required: false }
];

describe("catalogue product fields", () => {
  it("renders saved catalogue fields in the add-product form", () => {
    const html = renderEditor(false, {});

    expect(html).toContain("Color *");
    expect(html).toContain('placeholder="Color"');
    expect(html).toContain("Product notes");
    expect(html).toContain("textarea");
  });

  it("renders persisted field values in the edit-product form", () => {
    const html = renderEditor(true, { color: "Blue", notes: "Summer collection" });

    expect(html).toContain('value="Blue"');
    expect(html).toContain("Summer collection");
  });
});

function renderEditor(isEdit: boolean, fieldValues: Record<string, string>): string {
  return renderToStaticMarkup(
    <ProductNestedEditor
      fields={fields}
      form={{ ...emptyProductForm, id: isEdit ? "product-1" : null, fieldValues }}
      isEdit={isEdit}
      products={[]}
      onAddField={() => undefined}
      onBack={() => undefined}
      onChangeForm={() => undefined}
      onEditProduct={() => undefined}
      onSave={() => Promise.resolve()}
    />
  );
}
