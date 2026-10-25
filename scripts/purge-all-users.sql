\set ON_ERROR_STOP on

-- Grogoni registered-user purge.
--
-- Read-only audit (the default):
--   psql "$DIRECT_DATABASE_URL" -v execute_purge=NO -f scripts/purge-all-users.sql
--
-- Destructive execution, only after reviewing the audit output and stopping API writers:
--   psql "$DIRECT_DATABASE_URL" -v execute_purge=YES -f scripts/purge-all-users.sql
--
-- The script never drops/truncates schema objects and never disables constraints. It refuses to
-- execute when it discovers an unclassified public table.

\if :{?execute_purge}
\else
  \set execute_purge 'NO'
\endif

BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('grogoni.purge_all_registered_users'));

DO $$
BEGIN
  IF to_regclass('public.accounts') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.businesses') IS NULL
     OR to_regclass('public.grogoni_schema_migrations') IS NULL THEN
    RAISE EXCEPTION
      'Canonical account/user/business or migration tables are missing; refusing to audit or purge.';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.grogoni_schema_migrations
    WHERE filename = '051_single_identity_single_store.sql'
  ) THEN
    RAISE EXCEPTION
      'Migration 051_single_identity_single_store.sql is not applied; migrate the current schema before auditing or purging.';
  END IF;
END $$;

CREATE TEMP TABLE purge_table_plan (
  table_name text PRIMARY KEY,
  classification text NOT NULL CHECK (classification IN ('DELETE', 'PRESERVE')),
  delete_order integer,
  reason text NOT NULL
) ON COMMIT DROP;

-- Every CP2 normalized/snapshot record is application state owned by an account, user, business,
-- conversation, or user-created agent. These tables have no global registry definitions.
INSERT INTO purge_table_plan (table_name, classification, delete_order, reason) VALUES
  ('cp2_store_snapshots', 'DELETE', 10, 'Compatibility snapshot contains the complete user graph'),
  ('buyer_shopping_sessions', 'DELETE', 10, 'Account-owned shopping history and checkout reviews'),
  ('cp2_accounts', 'DELETE', 11, 'Normalized account compatibility records'),
  ('cp2_users', 'DELETE', 11, 'Normalized user compatibility records'),
  ('cp2_device_account_bootstraps', 'DELETE', 11, 'Short-lived device account bootstrap records'),
  ('cp2_device_recovery_credentials', 'DELETE', 11, 'Device-bound account recovery public keys'),
  ('cp2_businesses', 'DELETE', 11, 'Normalized business compatibility records'),
  ('cp2_memberships', 'DELETE', 11, 'Normalized business membership records'),
  ('cp2_session_contexts', 'DELETE', 11, 'Normalized session context records'),
  ('cp2_conversations', 'DELETE', 11, 'Normalized conversation records'),
  ('cp2_conversation_participants', 'DELETE', 11, 'Normalized participant records'),
  ('cp2_conversation_messages', 'DELETE', 11, 'Normalized message records'),
  ('cp2_conversation_attachment_blobs', 'DELETE', 11, 'Private conversation attachment bytes'),
  ('cp2_conversation_attachments', 'DELETE', 11, 'Private managed conversation attachments'),
  ('cp2_message_delivery_attempts', 'DELETE', 11, 'Normalized message delivery records'),
  ('cp2_message_notification_deliveries', 'DELETE', 11, 'Normalized notification delivery records'),
  ('cp2_e2ee_devices', 'DELETE', 11, 'Account E2EE devices'),
  ('cp2_push_subscriptions', 'DELETE', 11, 'Account push subscriptions'),
  ('cp2_marketplace_intro_states', 'DELETE', 11, 'Account onboarding state'),
  ('cp2_active_ai_models', 'DELETE', 11, 'Business model activation state'),
  ('cp2_agent_profiles', 'DELETE', 11, 'Business agent profiles'),
  ('cp2_agent_runtime_versions', 'DELETE', 11, 'Business agent runtime history'),
  ('cp2_agent_context_sources', 'DELETE', 11, 'Business agent context and memory'),
  ('cp2_agent_evaluation_events', 'DELETE', 11, 'Business agent evaluation history'),
  ('cp2_agent_owner_corrections', 'DELETE', 11, 'Owner correction records'),
  ('cp2_agent_skills', 'DELETE', 11, 'Business and account agent skills (agent-skills)'),
  ('cp2_runtime_experiences', 'DELETE', 11, 'Structured experience/recall records (experience-memory)'),
  ('cp2_installed_agent_models', 'DELETE', 11, 'Account-installed private model metadata'),
  ('cp2_template_evaluation_results', 'DELETE', 1, 'Per-case template evaluation results'),
  ('cp2_template_expert_corrections', 'DELETE', 1, 'Domain-expert corrections derived from production observations'),
  ('cp2_template_dataset_examples', 'DELETE', 1, 'Immutable template training and regression examples'),
  ('cp2_expertise_artifacts', 'DELETE', 1, 'Compiled expertise artifact descriptors and checksums'),
  ('cp2_template_promotions', 'DELETE', 1, 'Template promotion and rollback decisions'),
  ('cp2_template_runtime_bindings', 'DELETE', 1, 'Production template-to-runtime bindings'),
  ('cp2_template_production_observations', 'DELETE', 2, 'Redacted production observations and failure candidates'),
  ('cp2_template_evaluation_runs', 'DELETE', 2, 'Template evaluation run history'),
  ('cp2_template_evaluation_cases', 'DELETE', 2, 'Template benchmark and regression cases'),
  ('cp2_template_dataset_versions', 'DELETE', 2, 'Immutable versioned template datasets'),
  ('cp2_template_improvement_runs', 'DELETE', 2, 'Template improvement strategy executions'),
  ('cp2_model_template_versions', 'DELETE', 3, 'Immutable model-template lineage versions'),
  ('cp2_template_evaluation_suites', 'DELETE', 3, 'Versioned template evaluation suites'),
  ('cp2_model_templates', 'DELETE', 4, 'Business-owned portable expertise templates'),
  ('cp2_grogoni_id_history', 'DELETE', 11, 'Retired storefront ids (grogoni-id-slug-system)'),
  ('cp2_product_field_schemas', 'DELETE', 11, 'Business product schema settings'),
  ('cp2_products', 'DELETE', 11, 'Normalized product records'),
  ('cp2_contacts', 'DELETE', 11, 'Permissioned canonical contact records'),
  ('cp2_supplier_contact_relationships', 'DELETE', 11, 'Supplier contact role history'),
  ('cp2_purchase_price_history', 'DELETE', 11, 'Append-only product buying-price history'),
  ('cp2_purchase_records', 'DELETE', 11, 'Immutable supplier purchase history'),
  ('cp2_sale_records', 'DELETE', 11, 'Immutable customer sale history'),
  ('cp2_locations', 'DELETE', 11, 'Business route locations'),
  ('cp2_delivery_routes', 'DELETE', 11, 'Business delivery route history'),
  ('cp2_delivery_route_stops', 'DELETE', 11, 'Business delivery route stops'),
  ('cp2_customers', 'DELETE', 11, 'Normalized customer records'),
  ('cp2_suppliers', 'DELETE', 11, 'Normalized supplier records'),
  ('cp2_sales_agents', 'DELETE', 11, 'Normalized sales agent records'),
  ('cp2_supplier_contact_links', 'DELETE', 11, 'Normalized supplier contact links'),
  ('cp2_purchase_receipts', 'DELETE', 11, 'Normalized purchase receipts'),
  ('cp2_receipt_line_items', 'DELETE', 11, 'Normalized receipt line items'),
  ('cp2_receipt_ocr_jobs', 'DELETE', 11, 'Normalized OCR jobs'),
  ('cp2_invoices', 'DELETE', 11, 'Normalized invoice records'),
  ('cp2_payments', 'DELETE', 11, 'Normalized payment records'),
  ('cp2_logistics', 'DELETE', 11, 'Business logistics records'),
  ('cp2_data_exports', 'DELETE', 11, 'Account/business export records'),
  ('cp2_account_deletion_requests', 'DELETE', 11, 'Account deletion requests'),
  ('cp2_account_deletion_proofs', 'DELETE', 11, 'Account purge completion records'),
  ('cp2_shop_presences', 'DELETE', 11, 'Business public presence state'),
  ('cp2_network_invites', 'DELETE', 11, 'User/business invitations'),
  ('cp2_staff_invitations', 'DELETE', 11, 'Invitations to join a business with a role'),
  ('cp2_public_customer_care_requests', 'DELETE', 11, 'Business customer-care requests'),
  ('cp2_public_storefront_messages', 'DELETE', 11, 'Legacy public message records'),
  ('cp2_public_orders', 'DELETE', 11, 'Legacy public order request records'),
  ('cp2_verification_tiers', 'DELETE', 11, 'Business verification state'),
  ('cp2_tax_configs', 'DELETE', 11, 'Business tax settings'),
  ('cp2_device_trust', 'DELETE', 11, 'User/business device trust'),
  ('cp2_beta_access', 'DELETE', 11, 'Business beta access state'),
  ('cp2_beta_feature_flags', 'DELETE', 11, 'Business feature settings'),
  ('cp2_beta_device_tests', 'DELETE', 11, 'User/business device tests'),
  ('cp2_beta_support_tickets', 'DELETE', 11, 'Business support tickets'),
  ('cp2_beta_telemetry_events', 'DELETE', 11, 'Business telemetry'),
  ('cp2_launch_settings', 'DELETE', 11, 'Business launch settings'),
  ('cp2_launch_checklist', 'DELETE', 11, 'Business launch checklist'),
  ('cp2_launch_incidents', 'DELETE', 11, 'Business launch incidents'),
  ('cp2_document_imports', 'DELETE', 11, 'Business document imports'),
  ('cp2_document_import_sources', 'DELETE', 11, 'Business upload source metadata'),
  ('cp2_notifications', 'DELETE', 11, 'User/business notifications'),
  ('cp2_runtime_sessions', 'DELETE', 11, 'User/customer runtime sessions'),
  ('cp2_runtime_turns', 'DELETE', 11, 'User/customer runtime turns and context'),
  ('cp2_inventory_movements', 'DELETE', 11, 'Business inventory movements'),
  ('cp2_sync_queue_items', 'DELETE', 11, 'User/business offline sync work'),
  ('cp2_offline_receipts', 'DELETE', 11, 'Offline runtime device operation receipts'),
  ('cp2_offline_changes', 'DELETE', 11, 'Offline runtime business change log'),
  ('cp2_offline_metadata', 'DELETE', 11, 'Offline runtime sync sequence metadata'),
  ('cp2_otp_challenges', 'DELETE', 11, 'Authentication challenge compatibility records'),
  ('cp2_sms_delivery_attempts', 'DELETE', 11, 'Authentication delivery compatibility records'),
  ('cp2_sessions', 'DELETE', 11, 'Session compatibility records'),
  ('cp2_passkeys', 'DELETE', 11, 'Account passkeys'),
  ('cp2_passkey_ceremonies', 'DELETE', 11, 'Account passkey ceremonies'),
  ('cp2_account_identities', 'DELETE', 11, 'Account identity compatibility records'),
  ('cp2_password_credentials', 'DELETE', 11, 'Account password compatibility records'),
  ('cp2_auth_transactions', 'DELETE', 11, 'Account authentication transactions'),
  ('cp2_mfa_factors', 'DELETE', 11, 'Account MFA factors'),
  ('cp2_recovery_codes', 'DELETE', 11, 'Account recovery codes'),
  ('cp2_user_identities', 'DELETE', 11, 'Account OAuth identity compatibility records'),
  ('cp2_oauth_sessions', 'DELETE', 11, 'Account OAuth session compatibility records'),
  ('cp2_account_pin_hashes', 'DELETE', 11, 'Account PIN hashes'),
  ('cp2_network_nodes', 'DELETE', 11, 'Account contact graph nodes'),
  ('cp2_network_edges', 'DELETE', 11, 'Account contact graph edges'),
  ('cp2_network_sources', 'DELETE', 11, 'Account contact graph sources'),
  ('cp2_network_permissions', 'DELETE', 11, 'Account network permissions'),
  ('cp2_network_routes', 'DELETE', 11, 'Business agent network routes'),
  ('cp2_contact_hashes', 'DELETE', 11, 'Account contact hashes'),
  ('cp2_external_identities', 'DELETE', 11, 'Account external contact identities'),
  ('cp2_grogoni_identity_links', 'DELETE', 11, 'Account identity graph links'),
  ('cp2_identity_candidates', 'DELETE', 11, 'Account pending identity candidates'),
  ('cp2_network_connections', 'DELETE', 11, 'Account user-to-user network connections'),
  ('cp2_discovery_budgets', 'DELETE', 11, 'Account discovery budget spending'),
  ('cp2_audit_events', 'DELETE', 11, 'User/business audit events'),
  ('platform_identities', 'DELETE', 12, 'Business-scoped external commerce identities'),
  ('conversation_channels', 'DELETE', 12, 'External provider conversation mappings'),
  ('provider_update_receipts', 'DELETE', 12, 'External provider idempotency receipts'),
  ('channel_identity_link_grants', 'DELETE', 12, 'Hashed external identity link grants'),
  ('native_sms_devices', 'DELETE', 12, 'Authenticated Android SMS execution devices'),
  ('native_sms_device_commands', 'DELETE', 12, 'Queued Android SMS device commands'),
  ('connected_mailboxes', 'DELETE', 12, 'Business-scoped authorized email mailboxes'),
  ('connected_mailbox_oauth_sessions', 'DELETE', 12, 'Mailbox OAuth authorization sessions'),
  ('customer_runtime_capabilities', 'DELETE', 12, 'Hashed customer commerce capabilities'),
  ('product_media', 'DELETE', 12, 'Business product media'),
  ('product_capture_jobs', 'DELETE', 12, 'Business camera capture jobs'),
  ('status_broadcasts', 'DELETE', 12, 'Seller status broadcasts posted to contacts'),
  ('buy_orders', 'DELETE', 12, 'Authenticated-buyer catalogue orders from the unified checkout'),
  ('status_orders', 'DELETE', 12, 'Buyer pickup requests against a contact status broadcast'),
  ('unified_checkouts', 'DELETE', 12, 'Unified checkout records correlating buy_orders/status_orders'),
  ('sms_delivery_attempts', 'DELETE', 20, 'Authentication delivery attempts'),
  ('verification_challenges', 'DELETE', 21, 'Authentication challenges; cleared for clean registration'),
  ('otp_challenges', 'DELETE', 21, 'Authentication challenges; cleared for clean registration'),
  ('sync_queue', 'DELETE', 30, 'Outbox for user/business events'),
  ('business_events', 'DELETE', 31, 'User/business domain audit events'),
  ('message_delivery_attempts', 'DELETE', 40, 'Canonical message delivery history'),
  ('grogoni_session_contexts', 'DELETE', 41, 'Account conversation/session context'),
  ('conversation_messages', 'DELETE', 42, 'Canonical user/business messages'),
  ('conversation_participants', 'DELETE', 43, 'Canonical account/business participants'),
  ('conversations', 'DELETE', 44, 'Canonical account/business conversations'),
  ('cp2_runtime_task_heads', 'DELETE', 44, 'Runtime Handoff Protocol task-head pointers (runtime-handoff-protocol)'),
  ('cp2_runtime_task_instances', 'DELETE', 44, 'Runtime Handoff Protocol per-task runtime instance pointers (runtime-handoff-protocol)'),
  ('cp2_runtime_operation_dedup', 'DELETE', 44, 'Runtime Handoff Protocol idempotency dedup records (runtime-handoff-protocol)'),
  ('cp2_runtime_execution_events', 'DELETE', 44, 'Durable execution event log, per task (durable-execution-plane)'),
  ('cp2_runtime_transfers', 'DELETE', 42, 'Runtime transfer operations must be deleted before their checkpoints and hosts'),
  ('cp2_runtime_handoffs', 'DELETE', 45, 'Runtime Handoff Protocol immutable task checkpoints (runtime-handoff-protocol) - must delete after cp2_runtime_task_heads/cp2_runtime_task_instances (which reference it) and before cp2_native_runtime_agents/models/execution_hosts (which it references)'),
  ('cp2_computer_audits', 'DELETE', 44, 'Account browser-runtime action audit records'),
  ('cp2_computer_approvals', 'DELETE', 44, 'Account browser-runtime consequential-action approvals'),
  ('cp2_computer_sessions', 'DELETE', 45, 'Account isolated browser session state'),
  ('cp2_computer_profiles', 'DELETE', 46, 'Account encrypted browser profile state'),
  ('cp2_native_runtime_binding_models', 'DELETE', 45, 'Native runtime binding model-role assignments (native-runtime-bindings)'),
  ('cp2_native_runtime_bindings', 'DELETE', 45, 'Native runtime bindings joining an agent to its model roles (native-runtime-bindings)'),
  ('cp2_native_execution_hosts', 'DELETE', 46, 'Native runtime execution host records (native-runtime-bindings)'),
  ('cp2_native_model_installations', 'DELETE', 46, 'Native runtime model-to-host installation records (native-runtime-bindings)'),
  ('cp2_native_runtime_models', 'DELETE', 46, 'Native runtime model records (native-runtime-bindings)'),
  ('cp2_native_runtime_agents', 'DELETE', 47, 'Native runtime agent records (native-runtime-bindings)'),
  ('invoice_items', 'DELETE', 50, 'Business invoice line items'),
  ('payments', 'DELETE', 51, 'Business invoice payments'),
  ('invoices', 'DELETE', 52, 'Business invoices'),
  ('receipt_line_items', 'DELETE', 53, 'Business receipt line items'),
  ('purchase_receipts', 'DELETE', 54, 'Business purchase receipts'),
  ('receipt_ocr_jobs', 'DELETE', 55, 'Business receipt OCR state'),
  ('supplier_contact_links', 'DELETE', 56, 'Business supplier contact links'),
  ('sales_agents', 'DELETE', 57, 'Business sales agents'),
  ('suppliers', 'DELETE', 58, 'Business suppliers'),
  ('inventory_movements', 'DELETE', 59, 'Business inventory history'),
  ('products', 'DELETE', 60, 'Business catalogue'),
  ('customers', 'DELETE', 61, 'Business customers'),
  ('invoice_number_counters', 'DELETE', 62, 'Business invoice sequence state'),
  ('offline_sync_queue', 'DELETE', 63, 'User/business pending synchronization'),
  ('offline_cache_snapshots', 'DELETE', 64, 'Business offline cache'),
  ('document_import_rows', 'DELETE', 65, 'Business import preview rows'),
  ('document_import_jobs', 'DELETE', 66, 'Business import jobs'),
  ('document_import_sources', 'DELETE', 67, 'Business uploaded-file metadata'),
  ('mcp_access_tokens', 'DELETE', 70, 'Account/user MCP credentials'),
  ('account_sync_changes', 'DELETE', 71, 'Account sync journal'),
  ('device_trust', 'DELETE', 72, 'User/business device trust'),
  ('connected_channels', 'DELETE', 73, 'Legacy account/business channel links'),
  ('shop_deletion_archives', 'DELETE', 74, 'Account/business deletion archive metadata'),
  ('auth_audit_events', 'DELETE', 75, 'Authentication telemetry may retain user identifiers'),
  ('oauth_sessions', 'DELETE', 76, 'Account OAuth sessions'),
  ('auth_accounts', 'DELETE', 77, 'Legacy account OAuth identities'),
  ('user_identities', 'DELETE', 78, 'Account OAuth identities and encrypted tokens'),
  ('account_identities', 'DELETE', 79, 'Account login identities'),
  ('password_credentials', 'DELETE', 79, 'Account password hashes'),
  ('auth_transactions', 'DELETE', 79, 'Account authentication transactions'),
  ('mfa_factors', 'DELETE', 79, 'Account MFA secrets'),
  ('recovery_codes', 'DELETE', 79, 'Account recovery codes'),
  ('account_pin_hashes', 'DELETE', 79, 'Account PIN hashes'),
  ('cp2_platform_operators', 'DELETE', 79, 'Platform-operator grants for a purged account (platform-catalog)'),
  ('sessions', 'DELETE', 80, 'Account sessions and refresh hashes'),
  ('cp2_model_catalog', 'PRESERVE', NULL, 'Global deployment model catalog, not registered-user data (platform-catalog)'),
  ('cp2_agent_catalog', 'PRESERVE', NULL, 'Global deployment agent catalog, not registered-user data (platform-catalog)'),
  ('business_memberships', 'DELETE', 90, 'User-to-business ownership and roles'),
  ('users', 'DELETE', 91, 'Canonical registered users'),
  ('businesses', 'DELETE', 92, 'All businesses are application user-created tenants'),
  ('accounts', 'DELETE', 93, 'Canonical registered accounts'),
  ('grogoni_schema_migrations', 'PRESERVE', NULL, 'Migration ledger'),
  ('identity_providers', 'PRESERVE', NULL, 'Global OAuth provider definitions'),
  ('database_backup_runs', 'PRESERVE', NULL, 'Global database operations metadata'),
  ('database_restore_drills', 'PRESERVE', NULL, 'Global database operations metadata'),
  ('database_health_checks', 'PRESERVE', NULL, 'Global database health metadata');

CREATE TEMP TABLE purge_unclassified_tables ON COMMIT DROP AS
SELECT tablename AS table_name
FROM pg_catalog.pg_tables
WHERE schemaname = 'public'
  AND tablename NOT IN (SELECT table_name FROM purge_table_plan);

\echo '=== TABLE CLASSIFICATION (NOT APPLICABLE means absent at this migration level) ==='
SELECT
  p.table_name,
  CASE
    WHEN to_regclass(format('public.%I', p.table_name)) IS NULL THEN 'NOT APPLICABLE'
    ELSE p.classification
  END AS classification,
  p.reason
FROM purge_table_plan p
ORDER BY p.classification, p.delete_order NULLS LAST, p.table_name;

\echo '=== UNCLASSIFIED PUBLIC TABLES (must be empty before execution) ==='
TABLE purge_unclassified_tables;

\echo '=== FOREIGN-KEY DEPENDENCY METADATA FOR AFFECTED TABLES ==='
SELECT
  con.conname AS constraint_name,
  con.conrelid::regclass::text AS child_table,
  con.confrelid::regclass::text AS parent_table,
  pg_get_constraintdef(con.oid) AS definition
FROM pg_catalog.pg_constraint con
WHERE con.contype = 'f'
  AND (
    con.conrelid IN (
      SELECT to_regclass(format('public.%I', table_name))
      FROM purge_table_plan
      WHERE classification = 'DELETE'
    )
    OR con.confrelid IN (
      SELECT to_regclass(format('public.%I', table_name))
      FROM purge_table_plan
      WHERE classification = 'DELETE'
    )
  )
ORDER BY child_table, parent_table, constraint_name;

CREATE TEMP TABLE purge_counts (
  stage text NOT NULL,
  table_name text NOT NULL,
  row_count bigint NOT NULL,
  PRIMARY KEY (stage, table_name)
) ON COMMIT DROP;

DO $$
DECLARE
  planned record;
  current_count bigint;
BEGIN
  FOR planned IN
    SELECT table_name
    FROM purge_table_plan
    WHERE classification = 'DELETE'
      AND to_regclass(format('public.%I', table_name)) IS NOT NULL
    ORDER BY delete_order, table_name
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', planned.table_name) INTO current_count;
    INSERT INTO purge_counts(stage, table_name, row_count)
    VALUES ('PRE', planned.table_name, current_count);
  END LOOP;
END $$;

CREATE TEMP TABLE purge_preserved_counts ON COMMIT DROP AS
SELECT p.table_name, 0::bigint AS row_count
FROM purge_table_plan p
WHERE false;

CREATE TEMP TABLE purge_preserved_post_counts (LIKE purge_preserved_counts INCLUDING ALL)
ON COMMIT DROP;

DO $$
DECLARE
  planned record;
  current_count bigint;
BEGIN
  FOR planned IN
    SELECT table_name
    FROM purge_table_plan
    WHERE classification = 'PRESERVE'
      AND to_regclass(format('public.%I', table_name)) IS NOT NULL
    ORDER BY table_name
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', planned.table_name) INTO current_count;
    INSERT INTO purge_preserved_counts(table_name, row_count)
    VALUES (planned.table_name, current_count);
  END LOOP;
END $$;

\echo '=== PRE-PURGE ROW COUNTS FOR EVERY AFFECTED TABLE ==='
SELECT table_name, row_count FROM purge_counts WHERE stage = 'PRE' ORDER BY table_name;

\echo '=== PRESERVED GLOBAL/SYSTEM ROW COUNTS ==='
TABLE purge_preserved_counts;

CREATE TEMP TABLE purge_external_references (
  source_table text NOT NULL,
  owner_scope text,
  reference_type text NOT NULL,
  external_reference text NOT NULL
) ON COMMIT DROP;

DO $$
BEGIN
  IF to_regclass('public.shop_deletion_archives') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO purge_external_references
      SELECT 'shop_deletion_archives', business_id::text, 'archive_key', archive_key
      FROM public.shop_deletion_archives
      WHERE archive_key IS NOT NULL
    $sql$;
  END IF;
  IF to_regclass('public.cp2_document_import_sources') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO purge_external_references
      SELECT 'cp2_document_import_sources', business_id, 'originalStorageKey', record->>'originalStorageKey'
      FROM public.cp2_document_import_sources
      WHERE nullif(record->>'originalStorageKey', '') IS NOT NULL
    $sql$;
  END IF;
  IF to_regclass('public.cp2_installed_agent_models') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO purge_external_references
      SELECT 'cp2_installed_agent_models', coalesce(account_id, user_id), 'storageKey', record->>'storageKey'
      FROM public.cp2_installed_agent_models
      WHERE nullif(record->>'storageKey', '') IS NOT NULL
    $sql$;
  END IF;
  IF to_regclass('public.database_backup_runs') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO purge_external_references
      SELECT 'database_backup_runs', NULL, 'backup_file', backup_file
      FROM public.database_backup_runs
      WHERE backup_file IS NOT NULL
    $sql$;
  END IF;
END $$;

\echo '=== EXTERNAL REFERENCES (reported only; no external objects are deleted) ==='
TABLE purge_external_references;

SELECT upper(:'execute_purge') = 'YES' AS purge_confirmed \gset

\if :purge_confirmed
  \echo '=== EXECUTION CONFIRMED: beginning explicit transactional DELETE operations ==='
\else
  \echo '=== DRY RUN COMPLETE: no rows were deleted. Re-run with -v execute_purge=YES only after review. ==='
  ROLLBACK;
  \quit
\endif

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM purge_unclassified_tables) THEN
    RAISE EXCEPTION 'Unclassified public tables exist; update and review the purge plan first.';
  END IF;
END $$;

-- Lock every affected table before the first write so an application instance cannot repopulate a
-- table midway through the transaction. Stop API/worker writers before running this script.
DO $$
DECLARE
  planned record;
BEGIN
  FOR planned IN
    SELECT table_name
    FROM purge_table_plan
    WHERE classification = 'DELETE'
      AND to_regclass(format('public.%I', table_name)) IS NOT NULL
    ORDER BY table_name
  LOOP
    EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', planned.table_name);
  END LOOP;
END $$;

DO $$
DECLARE
  planned record;
BEGIN
  FOR planned IN
    SELECT table_name
    FROM purge_table_plan
    WHERE classification = 'DELETE'
      AND to_regclass(format('public.%I', table_name)) IS NOT NULL
    ORDER BY delete_order, table_name
  LOOP
    EXECUTE format('DELETE FROM public.%I', planned.table_name);
  END LOOP;
END $$;

DO $$
DECLARE
  planned record;
  current_count bigint;
BEGIN
  FOR planned IN
    SELECT table_name
    FROM purge_table_plan
    WHERE classification = 'DELETE'
      AND to_regclass(format('public.%I', table_name)) IS NOT NULL
    ORDER BY table_name
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', planned.table_name) INTO current_count;
    INSERT INTO purge_counts(stage, table_name, row_count)
    VALUES ('POST', planned.table_name, current_count);
  END LOOP;
END $$;

\echo '=== POST-PURGE ROW COUNTS FOR EVERY AFFECTED TABLE ==='
SELECT table_name, row_count FROM purge_counts WHERE stage = 'POST' ORDER BY table_name;

\echo '=== REQUIRED ORPHAN/RESIDUAL CHECKS ==='
SELECT 'registered_accounts' AS check_name, count(*) AS row_count FROM accounts
UNION ALL SELECT 'registered_users', count(*) FROM users
UNION ALL SELECT 'registered_businesses', count(*) FROM businesses
UNION ALL SELECT 'orphan_sessions', count(*) FROM sessions s LEFT JOIN accounts a ON a.id = s.account_id WHERE a.id IS NULL
UNION ALL SELECT 'orphan_account_identities', count(*) FROM account_identities i LEFT JOIN accounts a ON a.id = i.account_id WHERE a.id IS NULL
UNION ALL SELECT 'orphan_conversations', count(*) FROM conversations c LEFT JOIN accounts a ON a.id = c.account_id WHERE a.id IS NULL
UNION ALL SELECT 'orphan_messages', count(*) FROM conversation_messages m LEFT JOIN conversations c ON c.id = m.conversation_id WHERE c.id IS NULL
UNION ALL SELECT 'orphan_memberships', count(*) FROM business_memberships m LEFT JOIN users u ON u.id = m.user_id WHERE u.id IS NULL
UNION ALL SELECT 'orphan_products', count(*) FROM products p LEFT JOIN businesses b ON b.id = p.business_id WHERE b.id IS NULL
UNION ALL SELECT 'orphan_invoices', count(*) FROM invoices i LEFT JOIN businesses b ON b.id = i.business_id WHERE b.id IS NULL
UNION ALL SELECT 'orphan_runtime_records', count(*) FROM cp2_runtime_sessions
UNION ALL SELECT 'residual_auth_credentials',
  (SELECT count(*) FROM password_credentials)
  + (SELECT count(*) FROM account_identities)
  + (SELECT count(*) FROM mfa_factors)
  + (SELECT count(*) FROM recovery_codes)
UNION ALL SELECT 'residual_pin_passkeys',
  (SELECT count(*) FROM account_pin_hashes)
  + (SELECT count(*) FROM cp2_account_pin_hashes)
  + (SELECT count(*) FROM cp2_passkeys)
  + (SELECT count(*) FROM cp2_passkey_ceremonies)
UNION ALL SELECT 'residual_agents',
  (SELECT count(*) FROM cp2_agent_profiles)
  + (SELECT count(*) FROM cp2_agent_runtime_versions)
  + (SELECT count(*) FROM cp2_native_runtime_bindings)
UNION ALL SELECT 'residual_orders', count(*) FROM cp2_public_orders
UNION ALL SELECT 'residual_context_memory',
  (SELECT count(*) FROM grogoni_session_contexts)
  + (SELECT count(*) FROM cp2_session_contexts)
  + (SELECT count(*) FROM cp2_agent_context_sources)
  + (SELECT count(*) FROM cp2_runtime_turns)
ORDER BY check_name;

DO $$
DECLARE
  residual record;
  preserved record;
  current_count bigint;
BEGIN
  SELECT table_name, row_count
  INTO residual
  FROM purge_counts
  WHERE stage = 'POST' AND row_count <> 0
  ORDER BY table_name
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Residual rows remain in %: %', residual.table_name, residual.row_count;
  END IF;

  FOR preserved IN SELECT table_name, row_count FROM purge_preserved_counts LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', preserved.table_name) INTO current_count;
    INSERT INTO purge_preserved_post_counts(table_name, row_count)
    VALUES (preserved.table_name, current_count);
    IF current_count <> preserved.row_count THEN
      RAISE EXCEPTION
        'Preserved table % changed from % rows to % rows',
        preserved.table_name,
        preserved.row_count,
        current_count;
    END IF;
  END LOOP;
END $$;

\echo '=== PRESERVED TABLE VERIFICATION ==='
SELECT p.table_name, p.row_count AS pre_count,
       post.row_count AS verified_post_count
FROM purge_preserved_counts p
JOIN purge_preserved_post_counts post USING (table_name)
ORDER BY p.table_name;

COMMIT;
\echo '=== PURGE COMMITTED: registered accounts/users and all classified user-owned state are zero. ==='
