import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const card = readFileSync("apps/web/src/SupplierContactRolesCard.tsx", "utf8");
const supplierSurface = readFileSync("apps/web/src/SupplierSurface.tsx", "utf8");
const ownerWorkspace = readFileSync("apps/web/src/OwnerWorkspace.tsx", "utf8");
const normalizedCard = card.replace(/\s+/gu, " ");
const normalizedSupplierSurface = supplierSurface.replace(/\s+/gu, " ");
const normalizedOwnerWorkspace = ownerWorkspace.replace(/\s+/gu, " ");

describe("supplier contact roles card", () => {
  it("is a self-contained card that fetches its own data from businessId/supplierId alone", () => {
    expect(normalizedCard).toContain(
      "export default function SupplierContactRolesCard(props: { businessId: string; supplierId: string; })"
    );
    expect(card).toContain(
      "const relationshipsPath = `/businesses/${props.businessId}/suppliers/${props.supplierId}/contacts`;"
    );
    expect(card).toContain("useAsyncActions");
    expect(card).toContain("useApiMutationRevision");
    expect(card).toContain("getUserFacingErrorMessage");
  });

  it("imports the supplier-contact relationship types from shared-types rather than redefining them", () => {
    expect(normalizedCard).toContain(
      'import type { CanonicalContactSummary, SupplierContactRelationshipSummary, SupplierContactRole } from "@soko/shared-types";'
    );
  });

  it("lists, adds, and removes supplier-contact role assignments against the real endpoints", () => {
    expect(card).toContain("getJson<SupplierContactRelationshipSummary[]>(relationshipsPath)");
    expect(card).toContain("postJson<SupplierContactRelationshipSummary>(relationshipsPath");
    expect(normalizedCard).toContain(
      "deleteJson<SupplierContactRelationshipSummary>( `/businesses/${props.businessId}/supplier-contacts/${relationship.id}`"
    );
  });

  it("is mounted inside the existing, already-approved suppliers ShellView, not a new one", () => {
    expect(supplierSurface).toContain(
      'import SupplierContactRolesCard from "./SupplierContactRolesCard";'
    );
    expect(normalizedSupplierSurface).toContain(
      "<SupplierContactRolesCard businessId={props.businessId} supplierId={supplier.id} />"
    );
    expect(supplierSurface).toContain("businessId: string;");
  });

  it("OwnerWorkspace passes the in-scope businessId into SupplierSurface", () => {
    expect(normalizedOwnerWorkspace).toContain("<Screens.SupplierSurface businessId={businessId}");
  });
});
