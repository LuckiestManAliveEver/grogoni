---
name: inventory-check
description: Check product availability and quantities when a customer or business owner asks about stock.
license: PolyForm-Noncommercial-1.0.0
compatibility: Requires an authorized Grogoni agent with the products.list capability.
allowed-tools: products.list
---

Use the authorized products.list capability to search the business catalogue for the requested product.
Check the returned unit, available quantity, and price before answering. Compare requested quantity
with actual stock. If there is insufficient stock, say so and report only the verified available amount.
If no product matches, ask for a product name or clarify the unit; do not invent stock or prices.
If the model or inventory service fails, report that availability could not be verified.
Do not reserve stock, place orders, contact anyone, or change records as part of checking availability.
