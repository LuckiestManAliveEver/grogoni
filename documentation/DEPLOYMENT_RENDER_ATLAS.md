# Legacy Atlas deployment note

MongoDB Atlas is no longer the deployed application datastore. This note is retained only so old
links do not silently point to obsolete setup instructions.

The production API uses the Postgres adapter with `CP2_STORE=postgres`. The Render Blueprint now:

- provisions `grogoni-db` as Render Postgres;
- injects its private `connectionString` as `DATABASE_URL` and `DIRECT_DATABASE_URL`;
- runs SQL migrations before the API starts; and
- exposes database diagnostics at `/health/db`.

Follow the current instructions in `deployment.md`, especially **Activate Render Postgres**.
