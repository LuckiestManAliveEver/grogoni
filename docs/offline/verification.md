# Verification record

Validated in an isolated copy of the Grogoni checkout using its installed dependencies. Source changes preserve the supplied root implementation plan and do not alter secrets or Git metadata.

- 43 tests passed across 14 files: five offline-runtime suites plus existing CP7 offline sync, CP21 client sync, invoice/inventory, product fields, API persistence acknowledgements, store persistence, Postgres persistence boundary and service-worker suites.
- SQLite constraints and native transaction tests executed against Node 22.19.0's real SQLite engine.
- Settings component test verifies explicit confirmation, installation and no upload on a connectivity event. Browser adapter test verifies persistent consent and account isolation. No physical Android, iOS or browser radio test is claimed.
- Offline package build, API TypeScript check and web TypeScript check passed.
- ESLint with zero warnings and Prettier passed on changed code.
- Vite production build passed and emits an offline shell manifest. Existing bundle budgets passed (initial JavaScript about 82 KiB gzip, owner route about 129 KiB gzip). Vite's advisory about an individual uncompressed chunk exceeding 500 kB remains; it is within this repository's compressed-size budgets.
- Architecture boundaries, ESM relative imports, retired-runtime and retired-device-model checks passed.
- The final Settings recovery adjustment was followed by another targeted Settings/browser test run.

No shared database migration, deployment, feature-flag enablement or real AI artifact download was performed. Runtime pin/inference tests use a compatible test adapter; the PWA has no executable local model engine. The peer transport is a tested prototype with an injected transport, not production BLE.

Before deployment, use the repository's documented database migration procedure for migration 082, then enable the two enrollment flags only for internal testing. Current production has not been changed.

## Offline commerce (order intents over BLE and SMS)

- Full repo suite: `pnpm typecheck` clean across all 11 workspace packages/services; `pnpm lint`
  (`eslint . --max-warnings=0`) clean; `pnpm test` (vitest) - 252 files passed, 5 pre-existing
  skips, 1267 tests passed, 0 failed.
- New/changed suites specific to this feature: `tests/offline-runtime-order-intents.test.ts`
  (client-side intent recording/sync), `tests/offline-runtime-peer.test.ts` (BLE
  `catalogue_digest`/`order_intent` envelopes, extending the existing suite),
  `tests/offline-runtime-sqlite.test.ts` (extended: `pending_offline_orders` table persistence and
  constraints), `tests/offline-order-planning.test.ts` (deterministic SMS text parser, including
  every ambiguous/unmatched/zero-quantity case), `tests/offline-order-reconciliation.test.ts`
  (server-side oversell/partial-fulfillment logic, idempotent replay, account-claim customer
  resolution, and the required integration test: BLE and SMS racing for the last unit of the same
  product resolve to exactly one confirmed order and one rejected order, never both).
- No new eval suite: SMS order parsing is deliberately deterministic (regex + string matching, no
  model call), so there is no latent-space output to evaluate - the gate tests above are
  exhaustive for it.
- Not exercised: real BLE hardware (the Web Bluetooth transport, `apps/web/src/peer-bluetooth-transport.ts`,
  is unchanged and passes its own existing suite; PeerProvider's new envelope kinds are tested
  against an injected transport, same as the existing conversation-message path), and cross-process
  durability of order-intent idempotency after a server restart (documented gap, see
  `docs/offline/offline-commerce.md`).
- `OFFLINE_RUNTIME_ENABLED`/`VITE_OFFLINE_RUNTIME_ENABLED` were not touched. No new database
  migration was required - the reconciliation endpoint reuses the existing in-memory/Postgres-snapshot
  CP2 persistence and the existing `createInvoice`/`confirmInvoice` stock guard verbatim.
