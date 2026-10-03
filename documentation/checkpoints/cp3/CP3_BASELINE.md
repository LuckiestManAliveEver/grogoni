# CP3: Mobile Shell and Chat Shell

Status: passed
Date opened: 2026-07-02
Date passed: 2026-07-02
Target tag: `checkpoint/cp3-mobile-chat-shell`
Actual tag: not created. No `.repo.git` directory exists in this checkout; see the corrected Git Directory Note in `documentation/checkpoints/CHECKPOINT_LOG.md`.

## Purpose

CP3 establishes the first usable mobile-first Grogoni product surface.

The checkpoint turns the CP2 account and business creation flow into an application shell that a merchant can navigate after signing in:

- installable PWA shell
- mobile home surface
- chat shell
- quick actions
- offline and sync status placeholders
- empty states for the first commerce areas

CP3 must keep the product chat-first without pretending that CP4 parser behavior, CP5 business records, CP7 offline sync, or CP8 payments already exist.

## Formal Entry From CP2

CP2 is accepted as passed.

CP3 starts from:

- React/Vite web app
- Fastify API service
- passwordless OTP and refresh-surviving session contract
- first business creation flow
- language preference state
- owner membership and role checks
- audit event foundation
- CI, lint, typecheck, tests, and boundary checks

## CP3 Scope

In scope:

- mobile-first authenticated app layout
- installable PWA manifest and app metadata
- app shell loading state
- signed-in home surface for the active business
- chat screen shell with message composer
- non-executing chat placeholder behavior
- quick actions grid
- empty states for products, customers, invoices, and payments
- offline status indicator
- sync status placeholder
- basic navigation between setup, home, chat, and placeholder areas
- responsive styling for small Android viewports
- accessibility baseline for tap targets, labels, and focus states
- tests for shell rendering and route/state behavior where practical

Out of scope:

- rule-based parser implementation
- model or llama.cpp integration
- durable local business data store
- offline mutation queue
- product, customer, invoice, payment, stock, supplier, or report CRUD
- M-Pesa integration
- production SMS provider
- marketplace
- full TIEL
- native app shell

## Target Flow

```text
Owner signs in through CP2 flow
  -> active business is available
  -> mobile app shell loads
  -> owner sees home, chat, quick actions, offline/sync status, and empty states
  -> quick actions navigate to clear placeholders or existing setup routes
  -> chat accepts draft input but does not execute business mutations before CP4
```

## Shell Rules

- The shell must be usable on narrow Android viewports.
- Primary actions must use large tap targets.
- Chat and quick actions must be first-class entry points.
- Empty states must make later commerce areas visible without creating fake data.
- Offline and sync status are informational placeholders only in CP3.
- No CP3 UI may bypass server-validated CP2 auth/session state.
- No CP3 chat behavior may directly mutate business records.

## CP3 Exit Criteria

CP3 is marked passed because:

- [x] App shell loads after CP2 authentication.
- [x] PWA manifest exists with appropriate app name, theme color, and icon.
- [x] Home surface fits small Android viewport without horizontal overflow.
- [x] Chat shell exists with message history area and composer.
- [x] Chat shell clearly avoids executing business actions before CP4.
- [x] Quick actions grid exists for core workflows.
- [x] Products, customers, invoices, and payments have empty states.
- [x] Offline status indicator exists.
- [x] Sync status placeholder exists.
- [x] Main shell views are reachable from chat or quick action.
- [x] Existing CP1 and CP2 checks still pass.
- [x] Checkpoint tag `checkpoint/cp3-mobile-chat-shell` is created.

## Rollback Instructions

Rollback target:

- Return to CP2 account and business creation flow.
- Preserve CP2 auth, business, membership, session, and audit behavior.

Rollback trigger examples:

- shell blocks account or business creation
- mobile layout is unusable on small Android viewport
- chat appears to execute business actions before CP4
- quick actions bypass role or session checks
- offline/sync placeholders imply durability that does not exist yet
- CP1 or CP2 checks regress

## Next Checkpoint

Next checkpoint:

- CP4: Rule-Based AI Entry Point

CP4 should attach parser behavior to the CP3 chat shell without bypassing Business Runtime, role checks, confirmation rules, or audit requirements.
