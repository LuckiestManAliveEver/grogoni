import type { ContactPickerContact } from "./grogoni-application-shared";

// Only the Phone Contacts card imports vCards, so this lives in its own module and loads with it.

/**
 * Contacts from a vCard (.vcf) export with every number and email each card has (TEL/EMAIL may
 * repeat, carry parameters like TYPE=CELL, or be item-grouped as "item1.TEL"). Null when the text
 * is not a vCard, so the caller can fall back to CSV.
 */
export function parseVcardContacts(content: string): ContactPickerContact[] | null {
  if (!/BEGIN:VCARD/iu.test(content)) return null;
  // Unfold continuation lines (RFC 6350 3.2) before reading properties.
  const unfolded = content.replace(/\r?\n[ \t]/gu, "");
  return unfolded
    .split(/END:VCARD/iu)
    .map((card) => {
      const values = (property: string) =>
        [...card.matchAll(new RegExp(`^(?:[\\w-]+\\.)?${property}(?:;[^:\\r\\n]*)?:(.*)$`, "gimu"))]
          .map((match) => match[1]!.trim())
          .filter((value) => value.length > 0);
      const name =
        values("FN")[0] ?? values("N")[0]?.split(";").filter(Boolean).reverse().join(" ");
      return {
        ...(name === undefined || name === "" ? {} : { name: [name] }),
        tel: values("TEL"),
        email: values("EMAIL")
      };
    })
    .filter(
      (contact) => contact.name !== undefined || contact.tel.length + contact.email.length > 0
    );
}
