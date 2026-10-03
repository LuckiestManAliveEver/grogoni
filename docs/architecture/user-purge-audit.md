# Registered-user purge audit

## Status and scope

The Neon database has **not** been purged from this workspace. Neither `DIRECT_DATABASE_URL` nor
`DATABASE_URL` is configured here, so live counts and live deletion results are unavailable. The
reviewed script is [`scripts/purge-all-users.sql`](../../scripts/purge-all-users.sql). It requires
the direct PostgreSQL connection in `DIRECT_DATABASE_URL`; do not use a pooled application URL for
this maintenance transaction.

The audit is based on the Drizzle schema, migrations `000` through
`050_progressive_device_identity.sql`, the PostgreSQL persistence adapter, and foreign-key
metadata from a fresh database migrated through `050`. The script repeats the database-side audit
at execution time and refuses to write if migration `050` is absent or any `public` table is not in
its reviewed classification.

## Ownership and dependency audit

`accounts` is the canonical authentication root and `users.account_id` is the canonical human
identity relationship. `businesses` are user-created tenants connected through
`business_memberships`. No business rows in the current schema are global/system definitions, so
all businesses and their owned commerce data are in purge scope.

The principal dependency paths are:

```text
accounts
├── users ── business_memberships ── businesses
│                                      ├── products / inventory / customers / suppliers
│                                      ├── invoices / payments / receipts
│                                      ├── agents / runtime / context / model assignments
│                                      ├── imports / uploads / offline state / notifications
│                                      └── platform identities / channels / public commerce
├── sessions / credentials / PIN / passkeys / OAuth / MFA
├── conversations ── participants / messages / delivery attempts
├── account sync / MCP tokens / devices / contact network
└── CP2 normalized compatibility rows and cp2_store_snapshots
```

The application currently persists overlapping representations: canonical relational tables,
explicit `cp2_*` normalized compatibility tables, and `cp2_store_snapshots`. A complete purge must
clear all three. Deleting only `accounts` would leave JSON snapshots and several normalized tables
because those tables intentionally do not all have canonical foreign keys.

The script prints the live PostgreSQL FK graph before doing anything destructive. It then deletes
dependents in an explicit reviewed order and relies on normal constraints/cascades only where the
schema defines them. It does not disable constraints, truncate, drop, or alter schema objects.

## Classification

The SQL file is the canonical, exhaustive table list: its `purge_table_plan` contains 145 entries
for the current schema—140 `DELETE` and five `PRESERVE`. A listed table that is absent is reported
as `NOT APPLICABLE`. An existing `public` table missing from the list is reported as unclassified
and blocks destructive execution.

### DELETE — 140 user-owned/state tables

- Canonical identity/auth: `accounts`, `users`, `sessions`, `account_identities`,
  `password_credentials`, `account_pin_hashes`, `auth_transactions`, `mfa_factors`,
  `recovery_codes`, `user_identities`, `oauth_sessions`, `auth_accounts`, `otp_challenges`,
  `verification_challenges`, `sms_delivery_attempts`, `auth_audit_events`, and device/channel
  state.
- Canonical business/commerce: `businesses`, `business_memberships`, products, inventory,
  customers, suppliers, sales agents, receipts, invoices, payments, imports, offline caches and
  queues, business events, deletion archives, and sync records.
- Canonical conversations: `conversations`, `conversation_participants`,
  `conversation_messages`, delivery attempts, and session context.
- Platform chat commerce: `platform_identities`, `conversation_channels`,
  `provider_update_receipts`, `customer_runtime_capabilities`, `product_media`, and
  `product_capture_jobs`.
- Compatibility persistence: `cp2_store_snapshots` and every explicit normalized table used by
  `services/api/src/cp2/postgres-store.ts`, including account/user/business, auth, agents/models,
  runtime/context, public messages/orders, catalogue, finance, imports, notifications, contact
  graph, and audit collections.

Authentication challenges and audit records are cleared even when their account link is nullable:
they can retain destinations, hashes, or prior-user identifiers and can interfere with a clean
registration. Account/shop deletion proofs and archives are also user-associated development data,
not global configuration.

### PRESERVE — five global/system tables

- `grogoni_schema_migrations` — migration ledger.
- `identity_providers` — global login-provider definitions.
- `database_backup_runs`, `database_restore_drills`, `database_health_checks` — database operations
  metadata.

Global model definitions, system agent definitions, and application feature definitions are
code-defined in this version, not rows in PostgreSQL, so they are `NOT APPLICABLE` as database
purge targets. PostgreSQL schema, extensions, indexes, constraints, sequences, and migration files
are outside row-deletion scope and remain intact.

## Counts and verification

The dry run prints:

1. every table's `DELETE`, `PRESERVE`, or `NOT APPLICABLE` classification;
2. any unclassified live table;
3. actual foreign-key metadata involving affected tables;
4. a pre-purge count for every existing `DELETE` table;
5. baseline counts for all five preserved tables;
6. external object references.

The destructive path holds a serializable transaction plus an advisory lock, takes an
`ACCESS EXCLUSIVE` lock on every affected table, executes explicit `DELETE` statements, and then
checks all 140 affected tables for zero rows. It separately checks registered accounts/users and
orphans/residuals for sessions, credentials, conversations, messages, memberships, products,
invoices, runtime sessions, and model assignments. It also verifies preserved row counts did not
change. Any failure raises an exception and rolls back; only successful verification reaches
`COMMIT`.

Live pre/post counts are intentionally not recorded in this document because no Neon connection was
available. The script output from the actual maintenance run is the required live count report.

## Isolated validation result

The script was tested against an isolated PostgreSQL 16 database with the full fixture set through
migration 049, then re-run after migration 050 against persisted progressive device accounts,
bootstrap records, device recovery credentials, and a proof-gated account merge. This is validation
evidence, **not** a claim about Neon:

- all 145 current public tables were classified and zero were unclassified;
- PostgreSQL reported 87 foreign-key constraints involving purge-owned tables;
- representative account, user, business, membership, product, conversation/message, platform
  identity, normalized CP2, full snapshot, and progressive device-bootstrap rows were deleted;
- all 140 `DELETE` table post-counts and all explicit residual/orphan checks were zero;
- preserved counts remained unchanged; the latest run retained all 50 migration-ledger rows;
- after that purge, the real API/PostgreSQL store path returned HTTP 200 for fresh PIN signup,
  business creation, agent-profile provisioning, and agent-runtime provisioning;
- the smoke-test account was purged again successfully, leaving the isolated database at zero
  registered users.

## External storage

The script reports references but deliberately does not delete external objects:

- `shop_deletion_archives.archive_key`;
- `cp2_document_import_sources.record->>'originalStorageKey'`;
- `cp2_installed_agent_models.record->>'storageKey'`;
- preserved `database_backup_runs.backup_file` entries.

The binary upload pipeline accepts storage-provider keys but exposes no reviewed, provider-neutral
delete-object operation. Those keys must therefore be exported from the dry-run output and handled
through the configured provider's retention/deletion process. Database backups may also contain
pre-purge user data and remain subject to the backup provider's retention policy. Product media in
the current implementation is stored in PostgreSQL and is covered by `product_media` deletion.

## Neon execution runbook

1. Stop API, worker, webhook, and migration writers for the target Neon database.
2. Configure the direct target connection without printing the secret:

   ```bash
   export DIRECT_DATABASE_URL='postgresql://...direct Neon connection...'
   ```

3. Confirm the target and current schema:

   ```bash
   DIRECT_DATABASE_URL="$DIRECT_DATABASE_URL" pnpm db:verify-schema
   ```

4. Run the default read-only audit and save its output. Review the target identity, all live
   pre-counts, zero unclassified tables, FK metadata, preserved counts, and external references:

   ```bash
   psql "$DIRECT_DATABASE_URL" -v execute_purge=NO -f scripts/purge-all-users.sql
   ```

5. If a recovery point is required, create a Neon branch/backup before execution and record its
   retention implications. Keep all writers stopped.
6. Execute only after the audit has been reviewed:

   ```bash
   psql "$DIRECT_DATABASE_URL" -v execute_purge=YES -f scripts/purge-all-users.sql
   ```

7. Retain the complete output as the live pre-count, post-count, orphan-check, and commit report.
   Re-run `pnpm db:verify-schema`, reconnect the application, and perform the clean-registration
   smoke test. Prefer a disposable branch for a synthetic test account; if tested on the target,
   purge that synthetic account again before asserting the final zero-user state.

Do not run the destructive command until the connection has been independently confirmed as the
intended development database. A successful local validation does not substitute for reviewing the
live dry-run report.
