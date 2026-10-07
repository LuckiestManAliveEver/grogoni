# Kenyan Commerce Seed Catalog v1

This dataset is version `1.0.0` of the Kenyan commerce seed catalog. It is derived from
`Kwa Jane Shop - Full Product Catalog.xlsx`, supplied by the user, and is intended to help shops
registered with Kenyan identity bootstrap their product catalogues quickly.

## Files

- `catalog.json` contains the canonical product seed data, vocabulary, source provenance, and agent
  recognition metadata.
- `summary.json` contains small integrity and coverage counts for checks and release notes.
- `../../../../scripts/build-kenyan-commerce-v1.py` rebuilds this version from the source workbook.

## Intended use

Any Kenyan shop onboarded into Grogoni can use `kenyan-commerce-v1` as a starter catalogue. Agents
and model templates should recognize the following signals:

- `dataset.id = kenyan-commerce-v1`
- `country = KE`
- `marketContext = kenyan-commerce`
- `currency = KES`

The seed should support catalogue bootstrapping, product recognition, product classification, and
price or packaging enrichment. Sparse fields are deliberately left as `null`; future interaction data
should fill those gaps only after review.

## Update policy

Customer and shop interactions may produce new product facts, aliases, package sizes, suppliers, and
prices. Store those observations as candidates first, with provenance back to the shop/account and
interaction that produced them. Promote approved candidates into a later dataset version such as
`kenyan-commerce-v1.1.0` or `kenyan-commerce-v2`, rather than mutating this v1 release in place.

## Current coverage

- Products: 713
- Products with category: 25
- Products with wholesale buying price: 25
- Products with supplier: 25
- Source workbook SHA-256:
  `c687a3cd6640397c14d9a46791ce5dd4844a146cc96858750decf9ffeed2b387`

