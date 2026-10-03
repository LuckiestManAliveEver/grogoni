alter table grogoni_session_contexts
  add column if not exists account_id uuid references accounts (id) on delete cascade;

update grogoni_session_contexts as context
set account_id = session.account_id
from sessions as session
where session.id = context.session_id
  and context.account_id is null;

delete from grogoni_session_contexts as older
using grogoni_session_contexts as newer
where older.account_id = newer.account_id
  and (
    older.updated_at < newer.updated_at
    or (older.updated_at = newer.updated_at and older.session_id::text < newer.session_id::text)
  );

alter table grogoni_session_contexts
  alter column account_id set not null;

alter table grogoni_session_contexts
  drop constraint if exists grogoni_session_contexts_pkey,
  drop constraint if exists grogoni_session_contexts_session_id_fkey,
  add constraint grogoni_session_contexts_pkey primary key (account_id);

alter table grogoni_session_contexts
  drop column if exists session_id;
