do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'cp2_accounts',
    'cp2_users',
    'cp2_businesses',
    'cp2_memberships',
    'cp2_products',
    'cp2_customers',
    'cp2_suppliers',
    'cp2_sales_agents',
    'cp2_supplier_contact_links',
    'cp2_purchase_receipts',
    'cp2_receipt_line_items',
    'cp2_receipt_ocr_jobs',
    'cp2_invoices',
    'cp2_payments',
    'cp2_logistics',
    'cp2_data_exports',
    'cp2_account_deletion_requests',
    'cp2_verification_tiers',
    'cp2_tax_configs',
    'cp2_device_trust',
    'cp2_beta_access',
    'cp2_beta_feature_flags',
    'cp2_beta_device_tests',
    'cp2_beta_support_tickets',
    'cp2_beta_telemetry_events',
    'cp2_launch_settings',
    'cp2_launch_checklist',
    'cp2_launch_incidents',
    'cp2_document_imports',
    'cp2_document_import_sources',
    'cp2_notifications',
    'cp2_runtime_sessions',
    'cp2_runtime_turns',
    'cp2_inventory_movements',
    'cp2_sync_queue_items',
    'cp2_otp_challenges',
    'cp2_sessions',
    'cp2_user_identities',
    'cp2_oauth_sessions',
    'cp2_account_pin_hashes',
    'cp2_network_nodes',
    'cp2_network_edges',
    'cp2_network_sources',
    'cp2_network_permissions',
    'cp2_network_routes',
    'cp2_contact_hashes',
    'cp2_external_identities',
    'cp2_grogoni_identity_links',
    'cp2_audit_events'
  ]
  loop
    execute format(
      'create table if not exists %I (
        entity_id text primary key,
        business_id text,
        account_id text,
        user_id text,
        parent_id text,
        record jsonb not null,
        updated_at timestamp with time zone not null default now()
      )',
      table_name
    );

    execute format(
      'create index if not exists %I on %I (business_id) where business_id is not null',
      table_name || '_business_idx',
      table_name
    );
    execute format(
      'create index if not exists %I on %I (account_id) where account_id is not null',
      table_name || '_account_idx',
      table_name
    );
    execute format(
      'create index if not exists %I on %I (user_id) where user_id is not null',
      table_name || '_user_idx',
      table_name
    );
    execute format(
      'create index if not exists %I on %I (parent_id) where parent_id is not null',
      table_name || '_parent_idx',
      table_name
    );
  end loop;
end $$;
