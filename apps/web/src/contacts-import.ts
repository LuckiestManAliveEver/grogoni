import { type ShellView } from "./app-shell";

import {
  type ContactPickerContact,
  type CustomerFormState,
  type CustomerSummary,
  type SupplierBusinessCardSummary
} from "./grogoni-application-shared";

import { escapeCsvCell } from "./formatters";

import { normalizeSearchText } from "./agent-command-engine";

export function contactPickerContactToCustomer(
  contact: ContactPickerContact
): Pick<CustomerFormState, "name" | "phone" | "email" | "notes"> | null {
  const name = contact.name?.[0]?.trim() ?? contact.tel?.[0]?.trim() ?? contact.email?.[0]?.trim();

  if (name === undefined || name.length === 0) {
    return null;
  }

  return {
    name,
    phone: contact.tel?.[0] ?? "",
    email: contact.email?.[0] ?? "",
    notes: "Imported from device contacts"
  };
}

export function parseContactImportContent(
  content: string
): Array<Pick<CustomerFormState, "name" | "phone" | "email" | "notes">> {
  if (/BEGIN:VCARD/i.test(content)) {
    return content
      .split(/END:VCARD/i)
      .map((card) => ({
        name: extractVcardValue(card, "FN") || extractVcardValue(card, "N"),
        phone: extractVcardValue(card, "TEL"),
        email: extractVcardValue(card, "EMAIL"),
        notes: "Imported from vCard"
      }))
      .filter((record) => record.name.trim().length > 0);
  }

  const rows = content
    .split(/\r?\n/)
    .map((line) => line.split(/,|\t/).map((cell) => cell.trim()))
    .filter((row) => row.some((cell) => cell.length > 0));
  const [headerRow, ...dataRows] = rows;
  const headers = (headerRow ?? []).map((header) => normalizeSearchText(header));

  return dataRows
    .map((row) => ({
      name: getContactCell(row, headers, ["name", "customer", "fullname"]) ?? row[0] ?? "",
      phone: getContactCell(row, headers, ["phone", "mobile", "tel"]) ?? row[1] ?? "",
      email: getContactCell(row, headers, ["email", "mail"]) ?? row[2] ?? "",
      notes: getContactCell(row, headers, ["notes", "note"]) ?? "Imported from contact file"
    }))
    .filter((record) => record.name.trim().length > 0);
}

export function extractVcardValue(card: string, field: string): string {
  const match = card.match(new RegExp(`^${field}(?:;[^:]*)?:(.*)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

export function getContactCell(
  row: string[],
  headers: string[],
  names: string[]
): string | undefined {
  const index = headers.findIndex((header) => names.includes(header));
  return index === -1 ? undefined : row[index];
}

export function createContactsCsv(customers: CustomerSummary[]): string {
  const rows = [
    ["name", "phone", "email", "notes"],
    ...customers.map((customer) => [
      customer.name,
      customer.phone ?? "",
      customer.email ?? "",
      customer.notes ?? ""
    ])
  ];

  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

export function createPhoneNetworkSeed(customers: CustomerSummary[]) {
  return customers.slice(0, 12).map((customer, index) => ({
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    connections: [
      {
        name: `${customer.name.split(" ")[0] || "Customer"} supplier ${index + 1}`
      }
    ]
  }));
}

export function isNetworkDiscoveryRequest(message: string): boolean {
  const normalized = normalizeSearchText(message);
  return (
    normalized.includes("through my network") ||
    normalized.includes("connected to") ||
    normalized.includes("contacts who") ||
    normalized.includes("friends know") ||
    normalized.includes("my network") ||
    (normalized.includes("find") && normalized.includes("supplier"))
  );
}

export function createSupplierChatReply(
  message: string,
  suppliers: SupplierBusinessCardSummary[]
): { body: string; view: ShellView } | null {
  const normalized = normalizeSearchText(message);

  if (normalized.includes("upload") && normalized.includes("receipt")) {
    return {
      view: "suppliers",
      body: "Open Suppliers, choose a supplier card, then tap Upload receipt. I will extract supplier, sales agent, items, quantities, prices, date, and total; after confirmation the receipt image is not stored."
    };
  }

  if (normalized.includes("add") && normalized.includes("supplier")) {
    return {
      view: "suppliers",
      body: "Opening Suppliers. Add the supplier name, phone, email, notes, or create one from a linked phone contact."
    };
  }

  if (normalized.includes("sales agent") || normalized.includes("sales agents")) {
    const supplier = suppliers.find((item) =>
      normalized.includes(
        item.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim()
      )
    );

    if (supplier !== undefined) {
      return {
        view: "suppliers",
        body:
          supplier.salesAgents.length === 0
            ? `${supplier.name} has no linked sales agents yet.`
            : [
                `${supplier.name} sales agents:`,
                ...supplier.salesAgents.map(
                  (agent) =>
                    `- ${agent.name}: ${agent.phone ?? "no phone"}, receipts ${agent.receiptsHandled}`
                )
              ].join("\n")
      };
    }
  }

  if (
    normalized.includes("show my suppliers") ||
    normalized === "suppliers" ||
    (normalized.includes("which supplier") && normalized.includes("sold"))
  ) {
    return {
      view: "suppliers",
      body:
        suppliers.length === 0
          ? "No suppliers yet. Add one manually, create one from a phone contact, or upload a purchase receipt."
          : [
              "Supplier cards:",
              ...suppliers.map(
                (supplier) =>
                  `- ${supplier.name}: ${supplier.phone ?? "no phone"}, agents ${supplier.salesAgentCount}, receipts ${supplier.purchaseReceiptCount}, last purchase ${
                    supplier.lastPurchaseDate === null
                      ? "none"
                      : new Date(supplier.lastPurchaseDate).toLocaleDateString()
                  }`
              )
            ].join("\n")
    };
  }

  return null;
}
