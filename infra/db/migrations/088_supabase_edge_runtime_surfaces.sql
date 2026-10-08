do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'cp2_realtime_events',
    'cp2_background_jobs'
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
      'create index if not exists %I on %I (account_id) where account_id is not null',
      table_name || '_account_idx',
      table_name
    );
  end loop;
end $$;
