# CP2 compatibility retirement plan

The `cp2_*` tables are compatibility tables that store full records as JSONB. They should be retired in phases, not dropped in one migration.

## Collection classification

### Production core data

- `cp2_accounts`
- `cp2_users`
- `cp2_businesses`
- `cp2_memberships`
- `cp2_products`
- `cp2_customers`
- `cp2_suppliers`
- `cp2_sales_agents`
- `cp2_supplier_contact_links`
- `cp2_purchase_receipts`
- `cp2_receipt_line_items`
- `cp2_receipt_ocr_jobs`
- `cp2_invoices`
- `cp2_payments`

Status: core business collections are already projected into relational tables and hydrate from relational tables.

### Phase 1: auth, security, and sessions

- `cp2_otp_challenges`
- `cp2_sessions`
- `cp2_user_identities`
- `cp2_oauth_sessions`
- `cp2_account_pin_hashes`
- `cp2_device_trust`

Target relational tables:

- `otp_challenges`
- `sessions`
- `user_identities`
- `oauth_sessions`
- `account_pin_hashes`
- `device_trust`

Status: Phase 1 uses relational tables as the read source while continuing to dual-write compatibility tables for one release.

### Operational and audit data

- `cp2_audit_events`
- `cp2_data_exports`
- `cp2_account_deletion_requests`
- `cp2_notifications`
- `cp2_sync_queue_items`

### Temporary workflow data

- `cp2_document_imports`
- `cp2_document_import_sources`
- `cp2_runtime_sessions`
- `cp2_runtime_turns`
- `cp2_oauth_sessions`
- `cp2_otp_challenges`

### Cache or derived data

- `cp2_network_routes`
- `cp2_contact_hashes`
- `cp2_external_identities`
- `cp2_grogoni_identity_links`

### Admin, launch, and beta data

- `cp2_verification_tiers`
- `cp2_tax_configs`
- `cp2_beta_access`
- `cp2_beta_feature_flags`
- `cp2_beta_device_tests`
- `cp2_beta_support_tickets`
- `cp2_beta_telemetry_events`
- `cp2_launch_settings`
- `cp2_launch_checklist`
- `cp2_launch_incidents`

### Network graph data

- `cp2_network_nodes`
- `cp2_network_edges`
- `cp2_network_sources`
- `cp2_network_permissions`
- `cp2_network_routes`

## Retirement workflow

For each phase:

1. Add relational tables, constraints, and tenant-scoped indexes.
2. Backfill relational tables from `cp2_*` JSONB records.
3. Dual-write relational tables and compatibility tables for one release.
4. Switch reads to relational tables.
5. Add count/checksum health checks.
6. Stop writing the retired compatibility tables after production has run stable.
7. Drop retired compatibility tables only after a backup and restore drill pass.

## Phase order

1. Auth/security/session tables.
2. Network graph tables.
3. Document import/OCR workflow tables.
4. Notifications/runtime/chat tables.
5. Beta/launch/admin tables.
6. Drop retired `cp2_*` tables.

## Drop criteria

A `cp2_*` table can be dropped only when:

- no runtime code reads it;
- no runtime code writes it;
- production has run through at least one stable deploy cycle;
- a recent backup exists;
- a restore drill has passed;
- rollback SQL exists for the drop migration.
