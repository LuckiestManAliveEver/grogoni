-- Daemon lanes (docs/deployment/daemon-lanes.md). Tasks with an owner belong to one signed-in
-- user: their open browser runs them first, and a server worker takes over only once a task has
-- waited past the takeover delay. Tasks without an owner are operator work, run by the server.
alter table grogoni_daemon_tasks add column if not exists owner_user_id text
  check (owner_user_id is null or length(owner_user_id) between 1 and 200);
-- Which lane ran the latest attempt: 'browser' or 'server'. Evidence for the takeover rule.
alter table grogoni_daemon_tasks add column if not exists lane text
  check (lane is null or lane in ('browser','server'));
-- A user's own due work, newest first in listings.
create index if not exists grogoni_daemon_tasks_owner
  on grogoni_daemon_tasks (owner_user_id, updated_at desc)
  where owner_user_id is not null;
