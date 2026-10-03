alter table businesses add column if not exists grogoni_id text;

create unique index if not exists businesses_grogoni_id_unique_idx
  on businesses (grogoni_id)
  where grogoni_id is not null;

create unique index if not exists products_business_sku_unique_idx
  on products (business_id, sku)
  where sku is not null and sku <> '';

create index if not exists products_business_updated_idx
  on products (business_id, updated_at);

create index if not exists customers_business_contact_idx
  on customers (business_id, phone, email);

alter table suppliers add column if not exists linked_phonebook_contact_id text;
alter table suppliers add column if not exists linked_phonebook_contact_name text;
alter table suppliers add column if not exists sales_agent_count integer not null default 0;
alter table suppliers add column if not exists purchase_receipt_count integer not null default 0;
alter table suppliers add column if not exists last_purchase_date timestamp with time zone;

create index if not exists suppliers_business_updated_idx
  on suppliers (business_id, updated_at);

create table if not exists sales_agents (
  id uuid primary key,
  business_id uuid not null references businesses(id),
  supplier_id uuid not null references suppliers(id),
  supplier_name text not null,
  name text not null,
  phone text,
  linked_phonebook_contact_id text,
  linked_phonebook_contact_name text,
  notes text,
  receipts_handled integer not null default 0,
  last_transaction_date timestamp with time zone,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null
);

create index if not exists sales_agents_business_supplier_idx
  on sales_agents (business_id, supplier_id, name);

create index if not exists sales_agents_business_phone_idx
  on sales_agents (business_id, phone)
  where phone is not null;

create table if not exists supplier_contact_links (
  id uuid primary key,
  business_id uuid not null references businesses(id),
  link_type text not null,
  supplier_id uuid references suppliers(id),
  sales_agent_id uuid references sales_agents(id),
  network_node_id text not null,
  contact_name text not null,
  linked_at timestamp with time zone not null,
  constraint supplier_contact_links_type_check
    check (link_type in ('supplier', 'sales_agent')),
  constraint supplier_contact_links_target_check
    check (
      (link_type = 'supplier' and supplier_id is not null and sales_agent_id is null)
      or
      (link_type = 'sales_agent' and sales_agent_id is not null)
    )
);

create unique index if not exists supplier_contact_links_supplier_unique_idx
  on supplier_contact_links (business_id, supplier_id, network_node_id)
  where supplier_id is not null;

create unique index if not exists supplier_contact_links_agent_unique_idx
  on supplier_contact_links (business_id, sales_agent_id, network_node_id)
  where sales_agent_id is not null;

create table if not exists receipt_ocr_jobs (
  id uuid primary key,
  business_id uuid not null references businesses(id),
  tenant_id text not null,
  shop_id text not null,
  uploaded_by text not null,
  status text not null,
  source_file_name text not null,
  content_type text not null,
  engine text not null,
  engine_version text not null,
  model_version text not null,
  profile text not null,
  fallback_used boolean not null default false,
  language_hints jsonb not null default '[]'::jsonb,
  full_text text not null default '',
  average_confidence numeric not null default 0,
  warnings jsonb not null default '[]'::jsonb,
  field_evidence jsonb not null default '[]'::jsonb,
  structured_extraction jsonb not null default '{}'::jsonb,
  contact_matching_result jsonb not null default '{}'::jsonb,
  supplier_candidates jsonb not null default '[]'::jsonb,
  sales_agent_candidates jsonb not null default '[]'::jsonb,
  supplier_name text,
  sales_agent_name text,
  phone text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists receipt_ocr_jobs_business_status_idx
  on receipt_ocr_jobs (business_id, status, updated_at);

create table if not exists purchase_receipts (
  id uuid primary key,
  business_id uuid not null references businesses(id),
  supplier_id uuid not null references suppliers(id),
  supplier_name text not null,
  sales_agent_id uuid references sales_agents(id),
  sales_agent_name text,
  receipt_date timestamp with time zone not null,
  total numeric not null,
  source_file_name text,
  ocr_job_id uuid references receipt_ocr_jobs(id),
  image_stored boolean not null default false,
  created_at timestamp with time zone not null
);

create index if not exists purchase_receipts_business_supplier_date_idx
  on purchase_receipts (business_id, supplier_id, receipt_date desc);

create index if not exists purchase_receipts_business_agent_date_idx
  on purchase_receipts (business_id, sales_agent_id, receipt_date desc)
  where sales_agent_id is not null;

create table if not exists receipt_line_items (
  id uuid primary key,
  receipt_id uuid not null references purchase_receipts(id) on delete cascade,
  name text not null,
  quantity numeric not null,
  unit_price numeric not null,
  total numeric not null
);

create index if not exists receipt_line_items_receipt_idx
  on receipt_line_items (receipt_id);

create index if not exists sessions_account_expiry_idx
  on sessions (account_id, expires_at, revoked_at);

create index if not exists payments_business_invoice_idx
  on payments (business_id, invoice_id, created_at);

alter table products
  add constraint products_quantity_nonnegative_check
  check (quantity >= 0) not valid;

alter table payments
  add constraint payments_amount_positive_check
  check (amount > 0) not valid;

alter table purchase_receipts
  add constraint purchase_receipts_total_nonnegative_check
  check (total >= 0) not valid;
