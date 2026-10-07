#!/usr/bin/env python3
"""Build the Kenyan commerce v1 seed dataset from the Kwa Jane XLSX workbook."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET


WORKBOOK = Path("/home/kiariejane/Downloads/Kwa Jane Shop - Full Product Catalog.xlsx")
OUT_DIR = Path("data/kenyan-commerce/v1")
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def text_from_shared_string(node: ET.Element) -> str:
    return "".join(
        text_node.text or ""
        for text_node in node.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")
    )


def cell_text(cell: ET.Element, shared_strings: list[str]) -> str:
    value_node = cell.find("m:v", NS)
    value = "" if value_node is None else (value_node.text or "")
    if cell.attrib.get("t") == "s" and value:
        return shared_strings[int(value)]
    if cell.attrib.get("t") == "inlineStr":
        return "".join(
            text_node.text or ""
            for text_node in cell.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")
        )
    return value


def slugify(value: str, fallback: str) -> str:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", normalized.lower()).strip("-")
    return slug or fallback


def parse_money(value: str) -> int | None:
    if not value:
        return None
    try:
        return int(float(value))
    except ValueError:
        return None


def parse_date(value: str) -> str | None:
    if not value:
        return None
    for fmt in ("%d/%m/%y", "%d/%m/%Y"):
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def maybe_int(value: str) -> int | None:
    if not value:
        return None
    try:
        numeric = float(value)
    except ValueError:
        return None
    return int(numeric) if numeric.is_integer() else None


def department_for(category: str, name: str) -> str:
    haystack = f"{category} {name}".lower()
    rules = [
        ("food_and_grocery", ["flour", "rice", "tea", "sugar", "beans", "biscuit", "wafers", "sweets"]),
        ("household_and_cleaning", ["soap", "detergent", "softcare", "tissue", "blue band"]),
        ("lighting_and_electrical", ["torch", "flashlight", "led", "converter", "battery"]),
        ("personal_care", ["diaper", "softcare", "sanitary"]),
    ]
    for department, terms in rules:
        if any(term in haystack for term in terms):
            return department
    return "general_retail"


def read_rows() -> list[dict[str, str]]:
    with ZipFile(WORKBOOK) as archive:
        shared_strings: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared_strings = [text_from_shared_string(si) for si in root.findall("m:si", NS)]

        sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        rows: list[dict[str, str]] = []
        for row in sheet.find("m:sheetData", NS).findall("m:row", NS):
            values: dict[str, str] = {}
            for cell in row.findall("m:c", NS):
                column = re.match(r"[A-Z]+", cell.attrib["r"]).group(0)
                values[column] = cell_text(cell, shared_strings).strip()
            rows.append(values)

    headers = rows[0]
    return [
        {headers[column]: value for column, value in row.items() if column in headers}
        for row in rows[1:]
        if row.get("C")
    ]


def build_catalog(rows: list[dict[str, str]]) -> dict:
    products = []
    aliases: dict[str, set[str]] = {}
    seen_ids: dict[str, int] = {}

    for index, row in enumerate(rows, start=1):
        name = row.get("Product Name", "").strip()
        category = row.get("Product Category", "").strip()
        base_id = slugify(f"{category}-{name}" if category else name, f"product-{index}")
        sequence = seen_ids.get(base_id, 0) + 1
        seen_ids[base_id] = sequence
        product_id = base_id if sequence == 1 else f"{base_id}-{sequence}"
        source = row.get("Source", "").strip()

        aliases.setdefault(name.lower(), set()).add(name)
        if category:
            aliases.setdefault(category.lower(), set()).add(category)

        products.append(
            {
                "id": product_id,
                "sourceRow": maybe_int(row.get("No.", "")) or index,
                "name": name,
                "category": category or None,
                "department": department_for(category, name),
                "country": "KE",
                "marketContext": "kenyan-commerce",
                "currency": "KES",
                "packaging": {
                    "outerQuantity": maybe_int(row.get("Packaging", "")),
                    "outerUnit": row.get("Packaging Name", "").strip() or None,
                    "innerQuantity": maybe_int(row.get("Package Bought", "")),
                    "innerUnit": row.get("Qty Package Bought", "").strip() or None,
                },
                "prices": {
                    "wholesaleBuyingPriceKes": parse_money(row.get("WH. Buying Price", "")),
                    "recommendedRetailPriceKes": parse_money(row.get("R.R.P", "")),
                    "wholesaleResalePriceKes": parse_money(row.get("W.R.P", "")),
                },
                "supplier": row.get("Supplier Name", "").strip() or None,
                "lastUpdated": parse_date(row.get("Date of Update", "")),
                "source": source or None,
                "enrichment": {
                    "status": "seed" if source == "Updated list" else "needs-review",
                    "canLearnFromShopInteractions": True,
                    "missingFields": [
                        field
                        for field, value in {
                            "category": category,
                            "packaging": row.get("Packaging", ""),
                            "wholesaleBuyingPriceKes": row.get("WH. Buying Price", ""),
                            "supplier": row.get("Supplier Name", ""),
                        }.items()
                        if not value
                    ],
                },
            }
        )

    workbook_hash = hashlib.sha256(WORKBOOK.read_bytes()).hexdigest()
    return {
        "dataset": {
            "id": "kenyan-commerce-v1",
            "name": "Kenyan Commerce Seed Catalog",
            "version": "1.0.0",
            "country": "KE",
            "identityScope": "shops registered with Kenyan identity",
            "sourceWorkbook": WORKBOOK.name,
            "sourceWorkbookSha256": workbook_hash,
            "license": "internal-seed; derived from Kwa Jane Shop workbook provided by the user",
        },
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "products": products,
        "agentRecognition": {
            "datasetId": "kenyan-commerce-v1",
            "tasks": [
                "catalog.bootstrap",
                "catalog.product-recognition",
                "catalog.product-classification",
                "catalog.price-and-packaging-enrichment",
            ],
            "signals": ["country=KE", "marketContext=kenyan-commerce", "currency=KES"],
            "updatePolicy": "New product facts learned through shop/customer interactions should be stored as candidates and promoted into future dataset versions after review.",
        },
        "vocabulary": [
            {"surfaceForm": surface, "canonicalForms": sorted(forms)}
            for surface, forms in sorted(aliases.items())
        ],
    }


def main() -> None:
    rows = read_rows()
    catalog = build_catalog(rows)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "catalog.json").write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n")

    summary = {
        "datasetId": catalog["dataset"]["id"],
        "version": catalog["dataset"]["version"],
        "productCount": len(catalog["products"]),
        "withCategory": sum(1 for product in catalog["products"] if product["category"]),
        "withWholesaleBuyingPrice": sum(
            1 for product in catalog["products"] if product["prices"]["wholesaleBuyingPriceKes"] is not None
        ),
        "withSupplier": sum(1 for product in catalog["products"] if product["supplier"]),
        "sourceWorkbookSha256": catalog["dataset"]["sourceWorkbookSha256"],
    }
    (OUT_DIR / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
