# Business share links

The public-share identity for a shop: the links and addresses an owner hands out so customers can
reach the business, plus the owner-entered settings that govern how those links behave.

## Shape

`BusinessShareLinksSummary` (`packages/shared-types/src/business-settings.ts`) is what both the API
and the web app read:

| Field                     | Source                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `businessId`              | The business.                                                                                           |
| `storefrontUrl`           | Derived at read time from the canonical `grogoniId` via `getStoreLinks().universal` (`/s/<grogoniId>`). |
| `commerceAddress`         | Derived via `commerceAddressFromGrogoniId` (`<handle>@grogoni.com`).                                    |
| `whatsappUrl`             | Owner-entered, normalised click-to-chat link, or `null`.                                                |
| `publicNote`              | Owner-entered free-form note, or `null`.                                                                |
| `allowCustomerOrders`     | Owner decision; `null` = **not yet set** (never coerced to `false`).                                    |
| `updatedBy` / `updatedAt` | Who last saved the owner-entered fields, and when.                                                      |

Storefront and commerce addresses are **derived, never stored**, so they cannot drift from the
canonical `grogoniId` (see [grogoni-id-slug-system.md](grogoni-id-slug-system.md)).

## Owner-entered facts only

`allowCustomerOrders` distinguishes "not decided" (`null`) from an explicit "stop taking orders"
(`false`). The code never defaults it to `false`, mirroring the rule that business facts are set by
the owner, not the code (the same principle as the A11 timezone rule in corridor-fulfillment).

## WhatsApp links

`parseWhatsAppShareLink` (`packages/shared-types/src/whatsapp-link.ts`) accepts only:

- `https://wa.me/<digits>` and the `https://wa.me/?phone=<digits>` form,
- `https://api.whatsapp.com/send?phone=<digits>`,
- a bare phone number (`+254712345678`), normalised to `https://wa.me/<digits>`.

It rejects `tel:`, `javascript:`, arbitrary hosts and out-of-range numbers, so a stored link can
never be a disguised redirect or script URL. Both the API and the web app use the same function so
they cannot disagree.

## API

- `GET  /businesses/:businessId/share-links` — read (requires `business:read`).
- `PATCH /businesses/:businessId/share-links` — update (requires `business:create`); accepts any
  subset of `whatsappUrl`, `publicNote`, `allowCustomerOrders`. An invalid `whatsappUrl` returns
  `400 whatsapp_url_invalid`; an over-long note returns `400 value_too_long`.

Implemented in `services/api/src/cp2/domains/business-share-links/store.ts`.
