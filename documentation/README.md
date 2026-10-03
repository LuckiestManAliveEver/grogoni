# Grogoni Documentation Readme

This folder contains the planning, architecture, runtime, product, and control documents for Grogoni.

Grogoni is a mobile-first, offline-capable, AI-assisted business operating system for informal and small businesses. The core product goal is to let merchants manage products, customers, invoices, payments, inventory, debt, reports, and eventually marketplace skills through a chat-first interface that still exposes clear mobile screens for confirmation and review.

## Optional malware scanning

Binary upload malware scanning is opt-in. The default development configuration uses a passthrough
pipeline, so the API boots without an external scanner:

```text
MALWARE_SCANNER_ENABLED=false
MALWARE_SCANNER_URL=
MALWARE_SCANNER_SECRET=
```

Set `MALWARE_SCANNER_ENABLED=true` only when both scanner values are configured. The URL and secret
are validated at startup in that mode, and uploads continue to use the signed scanning protocol
documented in `docs/data-pipeline-infrastructure.md`.

## Document Authority

When documents disagree, follow this order:

1. `Grogoni doc 5 June ctrl .pdf` and the matching `Grogoni_Master_Control_Document_v1*.docx` files
   - Master Control Document.
   - Highest authority.
   - Resolves conflicts across Docs 1 to 3.
   - Defines unified sprint map, AI entry strategy, Definition of Done, sync conflict rules, performance targets, team model, and remaining gap fills.

2. `Grogoni doc 2 June .pdf`
   - Technical Architecture Specification.
   - Engineering implementation blueprint.
   - Defines repository layout, services, APIs, database schema, sync protocol, AI integration, tools, payments, documents, testing, deployment, and observability.

3. `Grogoni doc 3 june.pdf`
   - Product Requirements Document and Development Blueprint.
   - Defines users, product goals, epics, stories, backlog, QA, releases, success metrics, and team structure.

4. `Grogoni doc 1 june.pdf`
   - Master Architecture Document.
   - Defines vision, platform model, runtime separation, data models, business logic, AI architecture, sync, compliance, pricing, marketplace, and long-term roadmap.

5. `Grogoni doc 4 June  (1).pdf`
   - Grogoniclaw Runtime Specification.
   - Defines the AI runtime lifecycle, components, state machine, model routing, memory, skills, tool execution, verification, telemetry, and deployment modes.

6. `Grogoni doc 1.0 june (1).pdf`
   - Trusted Identity Execution Layer base specification.
   - Defines Identity Authority, Trusted Identity Module, device trust levels, identity lifecycle, attestation, identity roaming, and AI agent identities.

7. `Grogoni doc 1,1 june.pdf`
   - TIEL implementation supplement.
   - Adds trust degradation handling, key recovery, federated Identity Authority, offline session tokens, local IA cache, and acceptance criteria.

8. `Grogoni_Global_Shop_ID_Concept.docx` and `CP18_GLOBAL_SHOP_ID.md`
   - CP18 frontend concept and kickoff brief.
   - Defines the Grogoni Global Shop ID as the permanent Business Agent storefront identity.

9. `Grogoni_Continuous_Learning_Architecture_v1.pdf` and `CP19_CONTINUOUS_LEARNING.md`
   - Future expansion concept.
   - Defines continual learning through runtime traces, memory, skills, evaluation, and production feedback rather than direct model fine-tuning.

10. `CP20_UNIFIED_SESSION_FOUNDATION.md`

- Active cross-platform foundation checkpoint.
- Defines account/shop lifecycle, typed conversations, and server-authoritative session context.

11. `CP25_FULL_MESSAGING_PLATFORM.md`

- Active direct-messaging implementation checkpoint.
- Defines inbox behavior, cross-account participation, message lifecycle, offline outbox, media,
  realtime typing/read state, closed-browser VAPID Web Push, human direct-message E2EE, API
  contracts, security boundaries, and verification.

12. `CP26_ANDROID_RELEASE_IDENTITY.md`

- Active Google Play readiness checkpoint.
- Defines the proposed permanent Android namespace, Play account identity, production origins,
  version floor, signing boundary, accountable owners, approval gate, and subsequent CP27–CP34
  release sequence.

13. `CP27_PLAY_LEGAL_IDENTITY_ACCOUNT_DELETION.md`

- Active Google Play legal-readiness checkpoint.
- Defines the production legal-identity approval gate, public and authenticated account-deletion
  paths, retention disclosures, fulfillment evidence, and Play policy verification baseline.

14. `POSTGRES_PRODUCTION_READINESS_PLAN.md`
    - Production persistence runbook.
    - Defines the Neon Postgres and Render deployment plan, persistence scope, migration workflow, rollback notes, and production safeguards.

15. `TERMS_OF_SERVICE.md`

- Publication and production-readiness record for the Terms of Service.
- Identifies the supplied Version 1.0 Draft Parts I–IV sources, public route, and legal completion gate.

16. `PRIVACY_POLICY.md`

- Publication and production-readiness record for the Privacy Policy.
- Identifies the supplied Version 1.0 Draft Parts I–IV and Annexes A–D, public route, placeholders,
  and privacy/legal completion gate.

17. `1000157660.png`, `1000157661.png`, `1000157662.png`
    - Mobile UI references.
    - Show the desired operational style: clean cards, large tap targets, green primary actions, M-Pesa familiarity, quick actions, and payment confirmation screens.

18. `Grogoni doc 4 June .pdf`
    - Broken placeholder.
    - Contains only `Grogoni.markeyl`.
    - Do not treat as authoritative. Use `Grogoni doc 4 June  (1).pdf` instead.

19. `COMMERCE_SETTLEMENT_DECISION.md`
    - Settlement-model decision record for the status-broadcast sell flow
      and unified-checkout buy flow (contacts and own catalogue as buy
      sources).
    - Records why unified checkout captures no payment today, and the
      recommended split-payment/no-change direction for once a live
      payment rail exists.

## Core Implementation Principles

These principles should govern all implementation decisions:

1. Mobile first
   - The reference device is a low-end Android phone.
   - The app shell must stay lightweight.
   - Tap targets must be large and workflows short.

2. Chat first, not chat only
   - Every important workflow must be reachable from chat.
   - Structured cards and forms are allowed for confirmation, review, correction, and fallback.

3. Offline first
   - Critical workflows must work without connectivity.
   - Local writes create local events.
   - Sync happens later through a controlled queue.

4. AI assisted, not AI controlled
   - AI can interpret, plan, draft, summarize, recommend, and prepare actions.
   - Business-changing actions must go through tools, permission checks, deterministic business rules, and confirmation where required.

5. Deterministic business runtime
   - Products, invoices, payments, inventory, tax, credit, and reports must not depend on model output for correctness.
   - The AI proposes; the Business Runtime validates and executes.

6. Event driven and auditable
   - Every important mutation emits an immutable event.
   - Events power sync, audit logs, reports, notifications, and knowledge generation.

7. Replaceable AI infrastructure
   - Grogoniclaw should be model-agnostic.
   - A Pi/OpenClaw-style agent harness may implement the orchestration loop.
   - llama.cpp may provide local inference through a model adapter.
   - Neither should own business data or bypass Grogoni tools.

## Target System Shape

```text
Mobile PWA / optional native shell
  -> Application Runtime
      -> chat UI
      -> support screens
      -> local storage
      -> offline queue
      -> sync status

  -> Grogoniclaw Runtime
      -> conversation manager
      -> context builder
      -> intent router
      -> planner
      -> task scheduler
      -> model router
      -> memory engine
      -> skill manager
      -> tool executor
      -> verification engine
      -> response generator

  -> Business Runtime
      -> products
      -> customers
      -> suppliers
      -> invoices
      -> payments
      -> inventory
      -> credit
      -> logistics
      -> tax
      -> reports

  -> Data and Sync Runtime
      -> local database
      -> event log
      -> sync queue
      -> cloud PostgreSQL
      -> object storage
      -> audit logs
```

## AI and Model Integration Position

### Model Templates and executable expertise

The current recursive expertise architecture is indexed in
[`docs/README.md`](../docs/README.md). Start with the
[Model Template flywheel](../docs/architecture/model-template-flywheel.md) and canonical
[`.grogoni.com` v1 specification](../docs/specs/grogoni-model-template-v1.md). These documents supersede the
older assumption that a marketplace model asset is only weights or a prompt; the existing native
agent/model/runtime architecture remains authoritative for execution.

Use a clean adapter boundary:

```text
Grogoniclaw Runtime API
  -> AgentHarnessAdapter
      -> Pi/OpenClaw-style harness, if adopted

  -> ModelProviderAdapter
      -> rule-based parser
      -> llama.cpp server
      -> cloud model fallback

  -> ToolRegistry
      -> Grogoni business tools only
```

Rules:

- Do not fork llama.cpp unless a specific missing feature requires it.
- Prefer `llama-server` or a thin native/mobile adapter behind `ModelProviderAdapter`.
- Do not expose shell, browser, filesystem, or arbitrary host tools to merchant-facing agents.
- Expose only Grogoni-owned tools such as `create_invoice`, `add_product`, `record_payment`, `check_stock`, `generate_report`, `import_document`, `send_invoice`, and `queue_sync`.
- Keep all sensitive actions behind confirmation and audit logging.

## UI Direction

The PNG screenshots define the expected mobile feel:

- White or light background.
- Green primary action color.
- Rounded but restrained cards.
- Large touch targets.
- Bottom primary action button for confirmation screens.
- Quick action grid for common operations.
- Simple item cards with price, label, and one obvious action.
- M-Pesa and phone-number flows should feel familiar to users in Kenya.

The correct product pattern is:

```text
User starts from chat or quick action
  -> agent interprets or opens structured support screen
  -> preview card appears
  -> user confirms or edits
  -> Business Runtime executes
  -> event is recorded
  -> sync queue updates
  -> agent reports result
```

## Development Roadmap

The roadmap below harmonizes the Master Control Document, Technical Specification, PRD, Architecture Document, and Grogoniclaw Runtime Specification.

Each checkpoint is a rollback point. A checkpoint is not passed until its exit criteria are met, tagged, backed up, and documented.

### CP0: Planning Baseline

Goal:

- Establish the source of truth before implementation begins.

Deliverables:

- Documentation hierarchy agreed.
- MVP scope agreed.
- Technology choices recorded.
- Repository initialized.
- Branching and release strategy defined.
- Environment strategy defined for local, staging, and production.
- Initial risk register created.

Exit criteria:

- This README exists.
- Master Control Document is treated as authoritative.
- Broken placeholder Document 4 is ignored.
- The team can explain what is in scope for MVP, Beta, Public Launch, and post-launch.

Rollback point:

- Tag: `checkpoint/cp0-planning-baseline`
- Backup: documentation folder snapshot.
- Rollback action: restore docs and roadmap to this baseline if planning diverges.

### CP1: Repository and Engineering Foundation

Goal:

- Create a stable engineering base before product features begin.

Deliverables:

- Monorepo structure:
  - `apps/web`
  - `services/api`
  - `services/sync`
  - `services/ai-runtime`
  - `packages/business-core`
  - `packages/shared-types`
  - `packages/event-core`
  - `packages/sync-core`
  - `packages/tool-core`
  - `packages/ui`
  - `infra`
  - `tests`
- Local Docker Compose or equivalent dev setup.
- PostgreSQL and Redis available locally.
- Code formatting, linting, type checking, and test runner configured.
- CI pipeline skeleton.
- Environment variable conventions.

Exit criteria:

- Fresh clone can boot the local stack.
- Health check endpoint works.
- CI runs lint, type check, and unit test placeholders.
- No business feature code depends on AI infrastructure.

Rollback point:

- Tag: `checkpoint/cp1-engineering-foundation`
- Backup: database schema version `000_initial`.
- Rollback action: revert to working skeleton if later infrastructure choices fail.

### CP2: Account, Auth, and Business Creation

Goal:

- Let an owner create and access a business account.

Deliverables:

- Phone-plus-PIN and email OTP authentication flows.
- Account table.
- User table.
- Business creation.
- Language selection.
- Basic role model: owner, manager, sales agent, cashier, view-only.
- Audit log foundation.

Exit criteria:

- User can create an account in under 3 minutes.
- Owner can create a business.
- Auth state survives refresh.
- Role checks exist even if most features are not built yet.

Rollback point:

- Tag: `checkpoint/cp2-auth-business`
- Backup: auth config, migration state, seed data.
- Rollback action: disable new account creation and restore last known auth flow.

### CP3: Mobile Shell and Chat Shell

Goal:

- Establish the mobile-first product surface.

Deliverables:

- Installable PWA shell.
- Mobile dashboard inspired by the PNG references.
- Chat screen.
- Quick actions grid.
- Offline status indicator.
- Sync status placeholder.
- Empty states for products, customers, invoices, and payments.

Exit criteria:

- App shell loads in under 3 seconds on reference device conditions.
- All primary screens fit small Android viewport.
- Main workflows are reachable from chat or quick action.
- UI uses large tap targets and clear confirmation actions.

Rollback point:

- Tag: `checkpoint/cp3-mobile-chat-shell`
- Backup: UI baseline screenshots.
- Rollback action: revert UI shell if later flows make navigation confusing or slow.

### CP4: Rule-Based AI Entry Point

Goal:

- Deliver chat-first behavior without depending on a model.

Deliverables:

- Rule-based parser.
- Initial intent taxonomy:
  - add product
  - add customer
  - create invoice
  - record payment
  - check debt
  - show products
  - show invoices
- Confidence scoring.
- Clarification behavior.
- Structured-form fallback after repeated failures.
- AI evaluation dataset started under `tests/ai-eval`.

Exit criteria:

- At least 50 internal test commands exist.
- Parser handles predefined product and customer commands with at least 80 percent accuracy.
- Low-confidence behavior does not execute business actions.
- User can complete one simple command from chat.

Rollback point:

- Tag: `checkpoint/cp4-rule-parser`
- Backup: AI eval dataset version 1.
- Rollback action: route chat to structured forms if parser behavior regresses.

### CP5: Business Core Records

Goal:

- Replace the paper ledger for basic records.

Deliverables:

- Product CRUD.
- Customer CRUD.
- Supplier CRUD, minimal.
- Inventory quantity.
- Inventory movements.
- Local business validation.
- Business events:
  - ProductCreated
  - ProductUpdated
  - CustomerCreated
  - StockAdjusted

Exit criteria:

- Owner can add, edit, and view products and customers.
- Stock changes always create inventory movement events.
- Product quantity cannot silently become invalid.
- Unit tests cover core business rules.

Rollback point:

- Tag: `checkpoint/cp5-business-core-records`
- Backup: database migration and event schema.
- Rollback action: freeze writes and restore previous schema if stock/accounting state becomes inconsistent.

### CP6: Invoice and Inventory Flow

Goal:

- Support the first real commerce workflow.

Deliverables:

- Invoice creation.
- Invoice items.
- Invoice number generation.
- Inventory check during invoice creation.
- Tax line placeholder/configurable tax calculation.
- Invoice preview card.
- PDF or printable invoice output.
- Chat-driven invoice creation.

Exit criteria:

- End-to-end flow works: chat -> invoice preview -> confirmation -> invoice saved.
- Invoice creation completes in under 2 seconds for local/draft action.
- Inventory movement is emitted for confirmed sale.
- Invoice total is deterministic and test-covered.

Rollback point:

- Tag: `checkpoint/cp6-invoice-inventory`
- Backup: invoice migration, invoice numbering state, test invoice fixtures.
- Rollback action: disable invoice confirmation while preserving draft creation.

### CP7: Offline Local Data and Sync Queue

Goal:

- Make the app useful when internet fails.

Deliverables:

- IndexedDB or equivalent local store.
- Local event queue.
- Pending sync state.
- Retry-safe writes.
- Sync cursor model.
- Push-pull sync endpoint.
- Conflict detection.
- Authoritative conflict rules from the Master Control Document.

Exit criteria:

- Create invoice offline.
- Reconnect.
- Sync succeeds with no data loss.
- Payment, invoice total, tax, discount, and product quantity conflicts block auto-resolution.
- Duplicate offline records are flagged, not merged silently.

**Implementation note (added after the original exit criteria above were found to be only
partially built):** `SyncConflict` (`packages/shared-types/src/index.ts`) carries an explicit
`category` field — `"money"`, `"product_quantity"`, `"duplicate"`, or `"generic"` — computed by
`classifySyncConflict` (`packages/sync-core/src/index.ts`) from the business-error code a replay
failed with, so a conflict's kind is inspectable rather than only inferred from "conflict vs.
retryable." There is no `"tax"` or `"discount"` category: tax is a single server-validated rate
with no client-trusted value to ever conflict over, and invoices have no discount field in this
codebase at all — adding one would be a new product feature, not a sync-conflict fix, so this
document no longer claims tax/discount conflict handling exists. Duplicate offline records ARE now
detected and blocked, not silently created twice: `Cp2Store.replaySyncMutation`
(`services/api/src/cp2/store.ts`) rejects a `product.create`, `customer.create`, or
`payment.record` replay as a `"duplicate"` conflict when it matches an existing record (product:
same business + name, case-insensitive; customer: same business + name + phone, phone required to
avoid false positives on common first names; payment: same business + invoice + amount + method).
This runs only on the sync-replay path, not on direct REST creation, and the duplicate mutation is
never applied — it is surfaced as a conflict in the sync queue for the owner to resolve, rather than
"created both and flagged," since this codebase has no side-by-side conflict-resolution UI to show
two versions of a record. Covered by `tests/cp7-offline-sync.test.ts`.

Rollback point:

- Tag: `checkpoint/cp7-offline-sync` — not actually created; see the Git Directory Note in
  `documentation/checkpoints/CHECKPOINT_LOG.md`.
- Backup: server database dump, local-store schema version, sync cursor state.
- Rollback action: stop accepting sync pushes, preserve queued events, restore server snapshot if conflicts corrupt state.

### CP8: Payments and Debt Tracking

Goal:

- Track money safely.

Deliverables:

- Manual payment recording.
- Payment table.
- Invoice payment status.
- Debt tracking.
- M-Pesa webhook integration.
- Payment confirmation UI modeled after PNG references.
- Payment audit events:
  - PaymentRecorded
  - PaymentReceived
  - InvoicePaid

Exit criteria:

- Manual payment can mark invoice partially paid or paid.
- M-Pesa webhook updates invoice within 30 seconds in staging.
- Client-side payment status is never trusted.
- Duplicate payments are prevented by transaction reference/idempotency key.

Rollback point:

- Tag: `checkpoint/cp8-payments-debt`
- Backup: payment provider config, webhook signing secrets location, payment fixture data.
- Rollback action: disable webhook processing and fall back to manual recording while retaining payment audit logs.

### CP9: Document Import

Goal:

- Reduce manual data entry from existing business records.

Deliverables:

- File upload.
- CSV/XLSX import.
- PDF import.
- DOCX import, if needed.
- Field extraction.
- Template mapping.
- Preview and confirmation flow.
- Document import events.

Exit criteria:

- Supplier CSV can be uploaded, previewed, corrected, and saved.
- No extracted data is saved permanently without confirmation.
- Failed import does not corrupt existing records.

Rollback point:

- Tag: `checkpoint/cp9-document-import`
- Backup: object storage bucket state, document parser config, import mapping fixtures.
- Rollback action: disable imports and preserve uploaded originals for later reprocessing.

### CP10: Grogoniclaw Runtime Full Adapter

Goal:

- Move from simple parser to structured AI runtime.

Deliverables:

- Grogoniclaw Runtime API.
- Conversation Manager.
- Context Builder.
- Intent Router.
- Planner.
- Tool Executor Adapter.
- Verification Engine.
- Response Generator.
- Runtime telemetry.
- Agent action rate limits.
- AI evaluation dataset expanded.
- Optional Pi/OpenClaw-style harness adapter behind `AgentHarnessAdapter`.

Exit criteria:

- AI task completion rate exceeds the configured gate on evaluation set.
- High and critical risk tools require confirmation.
- No model can directly mutate business data.
- Runtime logs every state transition needed for debugging.

Rollback point:

- Tag: `checkpoint/cp10-grogoniclaw-runtime`
- Backup: runtime config, prompt/tool registry, AI eval dataset version.
- Rollback action: switch feature flag back to rule-based parser while preserving business tools.

### CP11: llama.cpp Local Model Adapter

Goal:

- Add local/offline model capability without binding the product to one inference engine.

Deliverables:

- `ModelProviderAdapter` interface.
- llama.cpp server adapter.
- Model registry table.
- GGUF model metadata.
- Device capability detection.
- Cloud fallback policy.
- Cost and fallback metrics.

Exit criteria:

- The same runtime call can use rule parser, llama.cpp, or cloud fallback.
- Local inference is optional.
- If local model is unavailable, the app degrades gracefully.
- Cloud fallback is rate-limited by plan.

Rollback point:

- Tag: `checkpoint/cp11-local-model-adapter`
- Backup: model registry, model config, eval results per model.
- Rollback action: disable local model provider and route to rule parser or cloud fallback.

### CP12: Reports, Notifications, and Knowledge Layer

Goal:

- Turn event history into useful business answers.

Deliverables:

- Sales summary.
- Debt report.
- Stock report.
- Low stock notification.
- Payment received notification.
- Sync failure notification.
- Knowledge entries:
  - top products
  - slow-moving stock
  - credit risk
  - weekly sales trend

Exit criteria:

- Owner can ask for a monthly sales report from chat.
- Reports derive from events/business records, not free-form AI memory.
- Notifications respect user settings and role permissions.

Rollback point:

- Tag: `checkpoint/cp12-reports-knowledge`
- Backup: reporting query snapshots, event fixtures.
- Rollback action: disable generated insights and keep deterministic reports only.

### CP13: Logistics

Goal:

- Support delivery and product movement beyond the shop counter.

Deliverables:

- Delivery records.
- Vehicle records.
- Driver records.
- Route field.
- Delivery status.
- Customer delivery contact.
- Quantity and weight tracking.
- Delivery notifications.

Exit criteria:

- Delivery can move from draft to dispatched to completed.
- Customer can be notified.
- Logistics events update reports and audit logs.

Rollback point:

- Tag: `checkpoint/cp13-logistics`
- Backup: logistics schema and status transition fixtures.
- Rollback action: disable logistics module and preserve existing delivery records read-only.

### CP14: Security, Compliance, and TIEL Preparation

Goal:

- Harden the system before broader release.

Deliverables:

- RBAC enforcement review.
- Audit log review.
- Sensitive data logging scan.
- Data export.
- Account deletion/anonymization workflow.
- Verification tiers.
- Tax configuration by country.
- TIEL design alignment, without blocking MVP.
- Device trust level placeholder if TIEL is deferred.

Exit criteria:

- Owner can export account data.
- Account deletion deactivates immediately and schedules anonymization.
- Business records required for compliance are retained in anonymized form.
- All high-risk actions have confirmation and audit logs.

Rollback point:

- Tag: `checkpoint/cp14-security-compliance`
- Backup: policy config, audit log schema, export fixtures.
- Rollback action: disable new high-risk features until compliance checks pass.

### CP15: Beta Release Hardening

Goal:

- Prepare for selected merchant usage.

Deliverables:

- Closed beta onboarding.
- Device testing on 1 GB and 2 GB Android phones.
- Offline testing.
- Payment testing.
- Sync stress testing.
- UX refinement.
- Support process.
- Crash/error telemetry.

Exit criteria:

- 10 selected merchants can use the app daily.
- Sync success rate meets beta target.
- Crash-free sessions meet beta target.
- Payment reconciliation works in staging and controlled production.

Rollback point:

- Tag: `checkpoint/cp15-closed-beta`
- Backup: production database snapshot before beta onboarding, feature flag state.
- Rollback action: pause onboarding, disable risky flags, restore last stable production build if needed.

### CP16: Public Launch

Goal:

- Launch the core product without marketplace complexity.

**Scope correction (added after implementation):** the deliverables and exit criteria originally
planned below were not all built. `documentation/checkpoints/cp16/CP16_BASELINE.md` narrowed CP16's
actual scope to a launch-readiness gate/report (public onboarding toggle, beta/support/telemetry
health aggregation, production readiness _documentation_) without flagging the drop against this
list, and `CHECKPOINT_LOG.md` still marked CP16 "passed" against the original list below. Status of
each original deliverable, verified against code:

- Regional tax config — delivered (CP14/CP16 tax configuration exists).
- Production readiness documentation for config/secrets/backup/monitoring/deploy — delivered as
  documentation, per `CP16_BASELINE.md`.
- Performance hardening — **not delivered**. No performance work or measurement against the exit
  criteria below was found.
- Accessibility pass — **not delivered**. No accessibility audit or fixes were found.
- SMS fallback — **not delivered**. No SMS-fallback code exists anywhere in the repository.
- USSD stub — **not delivered**. No USSD code exists anywhere in the repository.
- Production observability (real monitoring, not readiness docs) — **not verified as delivered**
  beyond the documented readiness checklist; no monitoring/alerting integration was found.
- Backup and restore testing (an actual executed test, not a checklist item) — **not delivered**.
- Incident response runbook — **not delivered**. No incident runbook exists under `docs/runbooks/`
  or elsewhere.

These six items remain outstanding and should be tracked as explicit follow-up work before treating
public launch as fully hardened, rather than being carried forward as silently "done."

Deliverables (as actually implemented; see `CP16_BASELINE.md` for the authoritative scope):

- Reversible public-onboarding launch gate, auditable.
- Launch readiness report combining CP15 beta status, support state, telemetry health, sync health,
  payment reconciliation, and rollback state.
- Launch support process, incident severity, and escalation documentation.
- Launch-safe telemetry contracts that avoid exposing raw sensitive data.
- Production readiness checklist (documentation only — see scope correction above).
- Regional tax configuration.

Exit criteria (as actually implemented — the original numeric performance/accessibility/backup
targets below were never measured and should not be treated as met):

- Public launch gate exists, is reversible, and is covered by tests.
- Launch readiness report and rollback controls are implemented and tested.
- CP1 through CP15 checks continue to pass.

Original, unverified exit criteria (kept for traceability; do not treat as satisfied):

- App shell cold start under 3 seconds.
- Local actions under 500 ms where applicable.
- Core API p95 under 500 ms under expected load.
- Payment webhook processing under 30 seconds.
- Crash-free session rate above target.
- Restore test completed.

Rollback point:

- Tag: `checkpoint/cp16-public-launch` — not actually created; see the Git Directory Note in
  `documentation/checkpoints/CHECKPOINT_LOG.md`.
- Backup: full production snapshot, object storage manifest, deployment artifact.
- Rollback action: blue/green or previous-release rollback, database migration rollback only if tested and safe.

### CP17: Marketplace Foundation

Goal:

- Prepare extensibility without compromising safety.
- Status: deferred on 2026-07-07 while CP18 starts.

Prerequisite:

- Marketplace is deferred until post-launch triggers are met:
  - 500 or more active businesses for 60 consecutive days.
  - Sync success rate above 98 percent for 30 consecutive days.
  - At least 3 external developers requesting API access.

Deliverables:

- Skill package format.
- Permission model.
- Signature verification.
- First-party skills.
- Skill sandbox design.
- Skill install preview.
- Skill rollback.

Exit criteria:

- First-party skill can be installed, disabled, and rolled back safely.
- Skills cannot access raw database or tokens.
- Skill actions use Grogoni tools and events.

Rollback point:

- Tag: `checkpoint/cp17-marketplace-foundation`
- Backup: skill registry, installed skill list, permission grants.
- Rollback action: disable all non-core skills and restore prior tool registry.

### CP18: Global Shop ID

Goal:

- Establish a permanent Grogoni Global Shop ID as the customer-facing identity for every Business Agent storefront.

Source:

- `documentation/Grogoni_Global_Shop_ID_Concept.docx` — original concept only. Superseded on format; see below.
- `documentation/CP18_GLOBAL_SHOP_ID.md`
- `docs/architecture/grogoni-id-slug-system.md` — current authoritative spec for the implemented `grogoniId` format and resolver.

Core concept (as originally proposed, not what shipped):

```text
The BigFish grogoni: 254A12567835
```

Where the original concept defined:

- `254` as the country namespace.
- `A` as the Business Agent identifier prefix.
- `12567835` as the unique global shop identifier.

**Implemented format differs from the concept above.** `Cp2Store.createGlobalShopId`
(`services/api/src/cp2/store.ts`) generates IDs as `grogoni.<handle>` (for example `grogoni.mama-mboga`,
with numeric-suffix collision handling: `grogoni.mama-mboga-2`), where `<handle>` is a slugified
business name, not a country-code/numeric identifier. `tests/grogoniid-and-storefront.test.ts`
explicitly asserts the original `254A########` shape is now invalid (`isGrogoniId("254A00000001")` is
`false`). The country-namespace concept was dropped during implementation and never reconciled back
into this document or `CP18_GLOBAL_SHOP_ID.md` until now. Treat `docs/architecture/grogoni-id-slug-system.md`
as authoritative for the current format, collision/rename/cooldown rules, and resolver behavior.

Deliverables:

- Stable global shop ID generation using the implemented `grogoni.<handle>` slug format (not the
  originally proposed `countryA########` format — see note above).
- Business Agent identity display in owner storefront/profile surfaces.
- Public storefront display of the shop ID.
- Customer conversation entry by Grogoni ID.
- Copy/share affordances for packaging, receipts, QR codes, and storefront sharing.
- Collision handling and audit events for ID creation.
- Tests for ID creation, uniqueness, lookup, and storefront routing.

Exit criteria:

- Every business has a stable Grogoni Global Shop ID.
- Owner UI and public storefront UI both present the ID prominently.
- Customers can use the ID to find or resume a storefront conversation.
- Phone numbers remain contact details rather than primary shop identity.
- Generated IDs are unique, auditable, and covered by tests.
- Legacy storefront slugs continue to resolve while new URLs use the Grogoni ID.

Rollback point:

- Tag: `checkpoint/cp18-global-shop-id`
- Backup: generated shop IDs, storefront routing map, and audit events.
- Rollback action: hide Grogoni ID surfaces while preserving generated IDs and keeping existing storefront URLs/contact workflows active.

### CP19: Continuous Learning Architecture

Goal:

- Prepare a future continual learning layer for Grogoni and the Grogoniclaw runtime without making model fine-tuning the primary path for improvement.
- Status: planned future expansion.

Source:

- `documentation/Grogoni_Continuous_Learning_Architecture_v1.pdf`
- `documentation/CP19_CONTINUOUS_LEARNING.md`

Core concept:

- The intelligence of Grogoni lives primarily in the runtime rather than the language model.
- Runtime traces, memory, skills, evaluation, and production feedback should improve the platform while deterministic business tools remain authoritative.

Deliverables:

- Trace capture for execution graphs, tool calls, outcomes, corrections, latency, and errors.
- Unified memory engine for shop, customer, supplier, inventory, market, and runtime memories.
- Outcome classification for success, failure, and partial success.
- Skill candidate detection and promotion workflow.
- GrogoniBench commerce evaluation suite.
- Human review queue for runtime improvement proposals.
- Production intelligence dashboard for clustered failures and improvement candidates.

Exit criteria:

- Tenant data remains isolated and privacy-controlled.
- Runtime improvements cannot bypass Grogoni business validators, confirmation gates, RBAC, audit logging, or rollback rules.
- Promoted skills are versioned, tested, permissioned, and reversible.
- Every runtime improvement passes GrogoniBench before production deployment.
- Human review is required before approved improvements benefit stores.

Rollback point:

- Tag: `checkpoint/cp19-continuous-learning`
- Backup: learning configuration, trace schema, memory promotion rules, skill registry, evaluation baselines, and approved improvement manifests.
- Rollback action: disable learning-derived runtime changes and restore the previous deterministic runtime configuration while preserving traces according to retention policy.

## Standard Checkpoint Procedure

Every checkpoint must follow the same procedure:

1. Freeze scope.
   - No unrelated work enters the checkpoint branch.

2. Run verification.
   - Lint.
   - Type check.
   - Unit tests.
   - Integration tests.
   - Offline tests if applicable.
   - AI eval if runtime behavior changed.
   - Device/performance checks if UI or sync changed.

3. Capture evidence.
   - Test output.
   - Screenshots for UI checkpoints.
   - API examples for backend checkpoints.
   - Migration version.
   - Feature flag state.

4. Create a rollback tag.
   - Use the checkpoint tag names in this README.

5. Snapshot state.
   - Database schema.
   - Seed data or fixtures.
   - Object storage manifest where applicable.
   - Runtime/tool/model config.

6. Record known risks.
   - List what is not covered by tests.
   - List any feature flags left off.
   - List any manual recovery steps.

## Rollback Strategy

Rollback should prefer feature flags and previous deployment artifacts over destructive database reversions.

Use this order:

1. Disable the feature flag.
2. Route traffic back to previous service version.
3. Preserve new writes in an isolated queue or read-only state.
4. Restore from checkpoint snapshot only when data corruption is confirmed and recovery has been rehearsed.
5. Never silently discard payment, invoice, tax, or inventory events.

Data rollback rules:

- Payments: never overwrite silently; preserve both versions and require owner/admin resolution.
- Invoice totals, tax, and discount: block auto-resolution. In practice, invoice totals are always
  computed server-side from items and never trusted from a client, and there is no discount field
  in this codebase, so there is no client-supplied total/discount value that could ever conflict —
  see the CP7 implementation note above.
- Product quantity: block auto-resolution (`SyncConflict.category === "product_quantity"`, from the
  `stock_insufficient` business error).
- Duplicate offline records: blocked from applying and flagged as a sync conflict
  (`SyncConflict.category === "duplicate"`) for owner review, rather than silently created twice.
  Not "create both" — see the CP7 implementation note above for why.
- Delete/edit conflict: prefer edit and log deletion attempt.

## MVP Scope

MVP includes:

- Account creation.
- Owner login.
- Business setup.
- Mobile PWA shell.
- Chat shell.
- Rule-based command parser.
- Products.
- Customers.
- Invoices.
- Inventory movements.
- Local storage.
- Offline queue.
- Basic sync.
- Manual payments.
- M-Pesa payment tracking.
- Audit events.
- Basic reports.

MVP excludes:

- Third-party marketplace.
- Full TIEL.
- Autonomous procurement.
- Cross-business collaboration.
- Full digital twin simulations.
- Complex forecasting.
- General-purpose agent tools.

## Beta Scope

Beta adds:

- Document import.
- Full Grogoniclaw runtime adapter.
- Cloud fallback.
- Expanded Swahili support.
- Payment webhook hardening.
- Reports.
- Notifications.
- Logistics.
- Device testing.
- Sync conflict UX.

## Public Launch Scope

Public Launch adds:

- Performance hardening.
- Accessibility review.
- Regional tax configuration.
- SMS fallback.
- USSD stub.
- Backup/restore validation.
- Production observability.
- Support process.

## Post-Launch Scope

Post-launch adds:

- Marketplace foundation.
- Continuous learning architecture.
- First-party skills.
- Third-party skill onboarding.
- Trusted Identity Execution Layer.
- Advanced logistics.
- Digital twin.
- Forecasting.
- Multi-agent collaboration.
- Voice-first workflows.

## Definition of Done

A feature is complete only when:

- Code is implemented and reviewed.
- No new lint or type errors exist.
- Unit tests cover new business logic.
- Integration tests cover new API routes.
- Offline behavior is tested where applicable.
- AI evaluation passes where applicable.
- RBAC and confirmation rules are enforced.
- Sensitive data is not logged in plaintext.
- Performance targets are not violated.
- Feature is reachable from chat or quick action.
- English and Swahili user-facing paths are considered.
- Documentation is updated.

## Planning Decision Status

The original CP1/CP2 planning list has been resolved or assigned to later checkpoints:

| Item                                          | Status                                                                                                       | Source                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Final monorepo tooling                        | Resolved: `pnpm` workspace.                                                                                  | `documentation/checkpoints/cp1/DECISION_LOG.md` |
| First frontend framework                      | Resolved: React.                                                                                             | `documentation/checkpoints/cp1/DECISION_LOG.md` |
| Local data wrapper                            | Deferred to CP3/CP7.                                                                                         | `documentation/checkpoints/cp1/DECISION_LOG.md` |
| Pi/OpenClaw-style harness path                | Deferred to CP10.                                                                                            | `documentation/checkpoints/cp1/DECISION_LOG.md` |
| llama.cpp first integration path              | Deferred to CP11; local model provider remains behind `ModelProviderAdapter`.                                | `documentation/checkpoints/cp1/DECISION_LOG.md` |
| Initial model candidates and device class     | Resolved: Qwen3-1.7B GGUF Q4 primary local text candidate, Qwen3-4B higher-end candidate, Gemma 3n research. | `documentation/checkpoints/cp0/DECISION_LOG.md` |
| Production hosting choice                     | Resolved: AWS CloudFront/S3, ECS on Fargate, RDS PostgreSQL, ElastiCache, S3, CloudWatch.                    | `documentation/checkpoints/cp0/DECISION_LOG.md` |
| SMS provider                                  | Deferred to CP16.                                                                                            | `documentation/checkpoints/cp2/DECISION_LOG.md` |
| M-Pesa integration provider and webhook rules | Deferred to CP8.                                                                                             | `documentation/checkpoints/cp2/DECISION_LOG.md` |
| Tax rules for first launch country            | Deferred to CP6/CP14.                                                                                        | `documentation/checkpoints/cp1/DECISION_LOG.md` |

## Recommended Immediate Next Step

Open CP10:

1. Create the CP10 baseline and decision log.
2. Define the Grogoniclaw Runtime adapter contract around existing deterministic business tools.
3. Keep model output behind confirmation and server-side validators.
