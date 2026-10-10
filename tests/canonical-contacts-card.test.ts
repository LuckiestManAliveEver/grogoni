import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const card = readFileSync("apps/web/src/CanonicalContactsCard.tsx", "utf8");
const networkSurface = readFileSync("apps/web/src/NetworkSurface.tsx", "utf8");
const ownerWorkspace = readFileSync("apps/web/src/OwnerWorkspace.tsx", "utf8");
const normalizedCard = card.replace(/\s+/gu, " ");
const normalizedOwnerWorkspace = ownerWorkspace.replace(/\s+/gu, " ");

describe("canonical contacts directory card", () => {
  it("is a self-contained card that fetches its own data from businessId alone", () => {
    expect(card).toContain(
      "export default function CanonicalContactsCard(props: { businessId: string; contactId?: string })"
    );
    expect(card).toContain("const contactsPath = `/businesses/${props.businessId}/contacts`;");
    expect(card).toContain("useAsyncActions");
    expect(card).toContain("useApiMutationRevision");
    expect(card).toContain("getUserFacingErrorMessage");
  });

  it("imports the canonical contact types from shared-types rather than redefining them", () => {
    expect(card).toContain(
      'import type { CanonicalContactSummary, ContactSource } from "@grogoni/shared-types";'
    );
  });

  it("lists contacts and triggers an import/sync against the real endpoints", () => {
    expect(card).toContain("getJson<CanonicalContactSummary[]>(contactsPath)");
    expect(card).toContain("`${contactsPath}/${endpoint}`");
    expect(card).toContain('"import" | "sync"');
  });

  it("lets an owner view a contact's linked sources and link/unlink a Grogoni account", () => {
    expect(card).toContain("View sources");
    expect(normalizedCard).toContain(
      "postJson<CanonicalContactSummary>(`${contactsPath}/${contact.id}/link`"
    );
    expect(normalizedCard).toContain(
      "deleteJson<CanonicalContactSummary>(`${contactsPath}/${contact.id}/link`)"
    );
  });

  it("is mounted inside the existing, already-approved network ShellView, not a new one", () => {
    expect(networkSurface).toContain(
      'import CanonicalContactsCard from "./CanonicalContactsCard";'
    );
    expect(networkSurface).toContain("<CanonicalContactsCard businessId={props.businessId} />");
    expect(networkSurface).toContain("businessId: string | null;");
    expect(networkSurface).toContain("props.businessId === null ? null");
  });

  it("OwnerWorkspace passes the in-scope businessId into NetworkSurface", () => {
    expect(normalizedOwnerWorkspace).toContain("<NetworkSurface businessId={businessId}");
  });
});
