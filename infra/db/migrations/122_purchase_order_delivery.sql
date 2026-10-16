create table business_purchase_orders (
  order_id text primary key,
  business_id text not null references cp2_businesses(entity_id) on delete cascade,
  draft_id text not null,
  actor_id text not null,
  draft_digest text not null check (draft_digest ~ '^[a-f0-9]{64}$'),
  channel text not null check (channel in ('grogoni','email','whatsapp')),
  recipient text not null,
  mailbox_id text,
  recipient_business_id text references cp2_businesses(entity_id) on delete cascade,
  snapshot jsonb not null,
  status text not null check (status in ('SUBMITTED_IN_APP','DISPATCHING','PROVIDER_ACCEPTED','DELIVERY_UNKNOWN','ACCEPTED','REJECTED')),
  revision integer not null default 0 check (revision >= 0),
  provider_message_id text,
  error_code text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (business_id,draft_id),
  foreign key (business_id,draft_id) references business_purchase_drafts(business_id,draft_id) on delete cascade,
  check ((channel='grogoni') = (recipient_business_id is not null)),
  check ((channel='email') = (mailbox_id is not null)),
  check (recipient_business_id is null or recipient_business_id <> business_id)
);
create index business_purchase_orders_inbox on business_purchase_orders(recipient_business_id,created_at desc);
create index business_purchase_orders_outgoing on business_purchase_orders(business_id,created_at desc);
