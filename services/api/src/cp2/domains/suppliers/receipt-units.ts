/**
 * Stock units for receipt posting. A delivery receipt line's quantity is added to a product's
 * stock only when the line is in the product's own unit: five cartons must never become five
 * packets (docs/audits/receipt-to-commerce-checklist-2026-11-16.md, P0 "unit mismatches"). Until a
 * verified pack conversion exists, a differing unit keeps the receipt pending for correction.
 */
const aliases: Record<string, string> = {
  pc: "piece",
  pcs: "piece",
  piece: "piece",
  pieces: "piece",
  each: "piece",
  ea: "piece",
  kg: "kg",
  kgs: "kg",
  kilo: "kg",
  kilos: "kg",
  kilogram: "kg",
  kilograms: "kg",
  g: "g",
  gm: "g",
  gms: "g",
  gram: "g",
  grams: "g",
  l: "l",
  ltr: "l",
  ltrs: "l",
  litre: "l",
  litres: "l",
  liter: "l",
  liters: "l",
  ml: "ml",
  ctn: "carton",
  ctns: "carton",
  carton: "carton",
  cartons: "carton",
  katoni: "carton",
  pkt: "packet",
  pkts: "packet",
  packet: "packet",
  packets: "packet",
  pakiti: "packet",
  doz: "dozen",
  dozen: "dozen",
  dozens: "dozen"
};

/**
 * Products saved without a unit get the placeholder "unit" (business-core normalizeProductInput):
 * that says nothing about how stock is counted, so it contradicts no receipt unit.
 */
const unstated = new Set(["unit", "units"]);

/** A comparable spelling of a unit, or null when the unit is not stated. */
export function normalizedStockUnit(unit: string | null | undefined): string | null {
  const text = (unit ?? "").trim().toLowerCase().replace(/\.$/u, "").replace(/\s+/gu, " ");
  if (!text || unstated.has(text)) return null;
  if (aliases[text]) return aliases[text]!;
  // Regular English plurals: bags → bag, boxes → box, bottles → bottle. Not "glass" → "glas".
  if (/(?:x|ch|sh)es$/u.test(text)) return text.slice(0, -2);
  if (text.length > 3 && text.endsWith("s") && !text.endsWith("ss")) return text.slice(0, -1);
  return text;
}

/** Whether a receipt line in `receiptUnit` may be added to stock kept in `stockUnit`. */
export function receiptUnitMatchesStock(
  receiptUnit: string | null | undefined,
  stockUnit: string | null | undefined
): boolean {
  const line = normalizedStockUnit(receiptUnit);
  const stock = normalizedStockUnit(stockUnit);
  // Either side unstated: nothing to contradict (the review step shows the unit to the user).
  return line === null || stock === null || line === stock;
}
