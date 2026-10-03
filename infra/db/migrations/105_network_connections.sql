-- Network connections (docs/architecture/phonebook-identity-resolution.md): one record per pair of
-- Grogoni users who asked to connect after finding each other through the phonebook. Same generic Cp2
-- collection shape as the other snapshot collections (023_storefront_interaction_contracts.sql):
-- the record is the NetworkConnectionRecord JSON.
create table if not exists cp2_network_connections (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now()
);

-- One record per pair of users, whichever of them asked first. Rows are replaced delete-first by
-- the snapshot writer, so re-creating a pair within one flush does not trip this.
create unique index if not exists cp2_network_connections_pair_idx
  on cp2_network_connections (
    least(record ->> 'requesterUserId', record ->> 'recipientUserId'),
    greatest(record ->> 'requesterUserId', record ->> 'recipientUserId')
  );

create index if not exists cp2_network_connections_requester_idx
  on cp2_network_connections ((record ->> 'requesterUserId'));

create index if not exists cp2_network_connections_recipient_idx
  on cp2_network_connections ((record ->> 'recipientUserId'));

comment on table cp2_network_connections is
  'Grogoni user-to-user connection requests and accepted connections discovered through the phonebook.';
