# Postgres Production Readiness Plan

This document defines the step-by-step plan to make Grogoni production-ready with an affordable persistent Postgres database.

## Goal

Move Grogoni from the current in-memory CP2 store to a persistent, auditable Postgres-backed runtime that can run safely on Render with Neon Postgres.

## Decision

Use Postgres as the production database.

Recommended environments:

- Staging/dev: Neon Free.
- Production launch: Neon Launch.
- Application hosting: Render API and Render static web app.

Rationale:

- The app already has `DATABASE_URL` and local Postgres conventions.
- Core Grogoni data is relational: accounts, businesses, memberships, products, customers, invoices, payments, logistics, sessions, audit events, runtime turns, and sync queue records.
- Postgres gives stronger transactional guarantees for business-changing workflows than a document database.
- Neon provides pooled Postgres connection strings suitable for hosted/serverless-style application runtimes.

## Phase 1: Create Database Environments

### 1. Create Neon staging database

1. Sign in to Neon.
2. Create a project named `grogoni-staging`.
3. Create a database named `grogoni_market_staging`.
4. Create an application role named `grogoni_app_staging`.
5. Copy the pooled connection string.
6. Store the value as `DATABASE_URL` in the staging API environment.

Required connection string type:

```text
Pooled Postgres connection string
```

Do not use the direct connection string for Render unless a specific migration or admin task needs it.

### 2. Create Neon production database

Create this when real users begin onboarding.

1. Create a Neon project named `grogoni-production`.
2. Create a database named `grogoni_market`.
3. Create an application role named `grogoni_app`.
4. Copy the pooled connection string.
5. Store the value as `DATABASE_URL` in the production API environment.
6. Keep the direct/admin connection string outside Render and use it only for controlled migration/admin work.

### 3. Separate environments

Use separate Neon projects or at least separate branches/databases for:

- local development
- staging
- production

Production must never share a database with staging or local development.

## Phase 2: Update Render Deployment Configuration

### 1. Add `DATABASE_URL` to Render API secrets

In Render:

1. Open the `grogoni` service.
2. Go to Environment.
3. Add secret:

```text
DATABASE_URL=<Neon pooled connection string>
```

4. Redeploy the API after persistence code is implemented.

### 2. Remove or deprioritize `MONGODB_URI`

`MONGODB_URI` exists in the earlier Render/Atlas test deployment note, but production persistence should use `DATABASE_URL`.

Update deployment config so:

- `DATABASE_URL` is required for production.
- `MONGODB_URI` is removed or clearly marked as legacy/test-only.
- Startup logs identify Postgres persistence mode without printing credentials.

### 3. Use pooled connections

For Render-hosted API services, use the Neon pooled connection string because hosted Node services can create multiple concurrent connections during deploys, restarts, and traffic bursts.

Rules:

- API runtime: pooled connection string.
- Migrations/admin: direct connection string.
- Never log the full database URL.
- Keep connection pool limits conservative until usage is measured.

## Phase 3: Implement Postgres Persistence

### 1. Define store boundary

Keep the existing route and business behavior stable by introducing a store interface.

Target shape:

```text
routes.ts
  -> Cp2Store interface
      -> InMemoryCp2Store for tests/local fallback
      -> PostgresCp2Store for staging/production
```

The API should choose the store implementation at startup:

```text
NODE_ENV=production + DATABASE_URL set -> PostgresCp2Store
local/test without DATABASE_URL -> InMemoryCp2Store or explicit test store
```

### 2. Persist core identity and auth records

Persist:

- accounts
- users
- owner profiles
- sessions
- OTP challenge deliveries
- PIN hashes
- social auth identities
- business memberships
- role checks

Requirements:

- Hash PINs before storage.
- Store sessions with expiry.
- Support session revocation.
- Do not store raw OTP values beyond development-only delivery records.
- Keep social provider IDs stable.

### 3. Persist business records

Persist:

- businesses
- Grogoni Global Shop IDs
- business settings
- language preference
- products
- customers
- suppliers
- stock movements
- invoices
- invoice items
- invoice confirmations
- payments
- payment summaries
- customer debt summaries
- logistics records
- import jobs and import rows

Requirements:

- Use database transactions for business-changing workflows.
- Invoice confirmation and inventory movement must commit atomically.
- Payment updates and invoice balance updates must commit atomically.
- Grogoni IDs must be unique.
- Business IDs must scope every tenant-owned record.

### 4. Persist runtime and storefront records

Persist:

- runtime sessions
- runtime turns
- runtime plans
- tool execution results
- runtime telemetry
- storefront agent IDs
- storefront public lookup data
- storefront CRM notes or customer requests
- checkout/contact request records

Requirements:

- Customer storefront requests must not require owner session credentials.
- Public storefront responses must only expose safe public fields.
- Runtime traces must not leak private business data across tenants.

### 5. Persist offline/sync records

Persist:

- sync queue items
- idempotency keys
- replay attempts
- conflict records
- offline cache metadata

Requirements:

- Replays must be idempotent.
- Conflict outcomes must be auditable.
- Failed items must retain enough metadata for owner/admin review.

### 6. Persist audit events

Persist every important mutation as an append-only audit event.

Minimum event groups:

- auth events
- business creation/update events
- Grogoni ID creation events
- product/customer/supplier mutations
- invoice draft/confirmation events
- payment events
- logistics events
- import events
- sync replay/conflict events
- runtime tool execution events
- security/compliance events

Audit event requirements:

- Include tenant/business ID when available.
- Include actor ID/session ID when available.
- Include event type.
- Include safe metadata.
- Include timestamp.
- Do not include plaintext secrets, OTPs, PINs, tokens, or full payment credentials.

## Phase 4: Add Migration Workflow

### 1. Add migration command

Add a package script:

```json
{
  "scripts": {
    "db:migrate": "..."
  }
}
```

The final command should run all pending SQL migrations against `DATABASE_URL`.

Expected usage:

```bash
DATABASE_URL=<direct-admin-url> pnpm db:migrate
```

For Render deploys, migrations should run as a controlled release step, not automatically from every API process unless a migration lock is implemented.

### 2. Migration structure

Use sequential migrations:

```text
infra/db/migrations/
  001_initial.sql
  002_auth_business.sql
  003_products_customers.sql
  ...
```

Each migration should be:

- idempotent where practical
- reviewed before production
- tested locally
- tested in staging
- backed by a rollback note

### 3. Production migration checklist

Before migration:

- Confirm production deploy window.
- Confirm latest backup/restore point.
- Confirm migration has passed locally.
- Confirm migration has passed staging.
- Confirm API version expected by migration is ready.
- Confirm rollback plan.
- Confirm no long-running jobs are active.
- Confirm `DATABASE_URL` points to production only when intentionally running production migration.

During migration:

- Put high-risk writes behind maintenance/feature flag if needed.
- Run migration with the admin/direct connection string.
- Capture migration output.
- Verify schema version.
- Run smoke tests.

After migration:

- Deploy API if not already deployed.
- Confirm `/health`.
- Confirm signup/login.
- Confirm business creation.
- Confirm product creation.
- Confirm storefront lookup by Grogoni ID.
- Confirm runtime turn can read business menu data.
- Confirm audit events are recorded.

### 4. Rollback notes

Rollback should prefer code rollback and feature flags over destructive schema rollback.

Rules:

- Never silently delete production payment, invoice, stock, or audit events.
- For additive migrations, rollback by deploying previous code and leaving unused columns/tables.
- For destructive migrations, require a tested backup restore procedure before production.
- If corruption is suspected, freeze writes before restore.
- Preserve failed migration logs.

Rollback checklist:

- Disable affected feature flag.
- Stop or scale down write paths if needed.
- Deploy previous API version.
- Verify old API can run against current schema.
- If schema restore is required, restore to a new database first and validate before switching traffic.
- Record incident notes and follow-up action.

## Phase 5: Production Safeguards

### 1. Backups and PITR

Enable provider-managed backups and point-in-time restore appropriate to the environment.

Minimum:

- Staging: short retention is acceptable.
- Production: enable PITR/restore window before onboarding real users.
- Test restore procedure before launch.

Restore test checklist:

- Restore backup to a separate database.
- Run migrations if required.
- Run API smoke test against restored DB.
- Verify sample business, products, invoices, payments, and audit events.
- Document restore time and issues.

### 2. Connection pooling

Use the Neon pooled connection string for the Render API.

Operational rules:

- Keep pool size conservative.
- Use short transaction durations.
- Avoid opening one database client per request without pooling.
- Monitor connection errors and saturation.

### 3. Audit log retention

Define retention by event type.

Initial recommendation:

- Security/auth audit events: at least 1 year.
- Business mutation events: at least 1 year.
- Runtime telemetry/debug traces: shorter retention, for example 30 to 90 days.
- Sensitive payload fragments: avoid storing; redact at write time.

Retention must respect account deletion and compliance rules.

### 4. Seed-free production startup

Production startup must not seed demo data automatically.

Rules:

- Demo/fixture data only runs in local/test.
- Production starts with empty tenant data.
- First real business is created through signup/onboarding.
- Startup validates required environment variables.
- Startup fails fast if `DATABASE_URL` is missing in production.

### 5. Smoke test after deployment

Run after every production deployment:

```bash
curl https://grogoni.com/health
```

Manual smoke test:

- Open `https://grogoni.com`.
- Create or log into an owner account.
- Confirm PIN login works.
- Create a test business only in staging, not production.
- Add a product.
- Open storefront by Grogoni ID.
- Send a storefront chat message.
- Add product to storefront receipt.
- Confirm audit event is stored.
- Confirm no secrets appear in logs.

## Phase 6: Implementation Order

Recommended order:

1. Create Neon staging database.
2. Add `DATABASE_URL` support to Render staging API.
3. Add schema migrations for auth, business, and audit events.
4. Implement `PostgresCp2Store` for auth/session/business creation.
5. Add tests comparing in-memory and Postgres behavior.
6. Persist products/customers/suppliers.
7. Persist invoices/payments/inventory.
8. Persist logistics/imports/sync queue.
9. Persist runtime turns/storefront CRM data.
10. Add `pnpm db:migrate`.
11. Run full staging migration and smoke test.
12. Create Neon production database.
13. Enable backups/PITR.
14. Deploy production with `DATABASE_URL`.
15. Run production smoke test.

## Acceptance Criteria

Production persistence is ready when:

- API can start in production only with `DATABASE_URL`.
- All CP2 through CP18 business data survives API restart.
- Tests cover Postgres-backed auth, business creation, products, invoices, payments, storefront lookup, runtime turns, and sync queue behavior.
- Migrations can be run locally and in staging.
- Staging and production database URLs are separate.
- Backups/PITR are enabled before real users.
- Smoke test passes after deploy.
- Production startup creates no seed/demo data.

## Open Decisions

- Exact migration tool: Drizzle migrations, node-pg-migrate, or a small internal SQL runner.
- Exact connection pool library and pool size.
- Whether production migrations run manually or through a locked release job.
- Audit retention periods by country and compliance requirement.
- Whether storefront CRM/contact requests become full customer records immediately or remain lead records until owner confirmation.
