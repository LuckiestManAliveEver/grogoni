# Environment Conventions

CP1 uses explicit environment variables with safe local defaults documented in `.env.example`.

## Local Services

- PostgreSQL: `postgres://grogoni:grogoni_dev_password@127.0.0.1:5432/grogoni_market`
- Redis: `redis://127.0.0.1:6379`
- API: `http://127.0.0.1:4000`
- Web frontend: `http://127.0.0.1:5173`

Start local infrastructure with:

```bash
pnpm dev:stack
```

Start the API watcher and Vite frontend dev server with:

```bash
pnpm dev
```

Run only the Vite frontend with:

```bash
pnpm dev:web
```

Stop local infrastructure with:

```bash
pnpm dev:stack:down
```

## Variable Rules

- Never commit `.env` files with secrets.
- Keep `.env.example` complete enough for a fresh clone.
- Services must validate required variables at startup.
- Business-changing feature switches must be explicit and auditable.
- AI or model provider configuration must remain outside business-core packages.

## Browser-local inference

`VITE_BROWSER_LOCAL_INFERENCE_ENABLED=false` is the safe default. Setting it to `true` only exposes
the browser-local model controls; it does not download or activate a model. Each authenticated user
must explicitly opt in from Agent model settings. No frontend API key is used.

## Binary upload malware scanning

Malware scanning is disabled by default so a local API can boot without an external scanner:

```text
MALWARE_SCANNER_ENABLED=false
MALWARE_SCANNER_URL=
MALWARE_SCANNER_SECRET=
```

When `MALWARE_SCANNER_ENABLED=true`, both the scanner URL and a secret of at least 32 characters are
required. With scanning disabled, binary uploads use the local passthrough pipeline.

## Authentication channels

Social OAuth login is disabled in the frontend and API, so OAuth client credentials are not
required. Phone account access uses the Grogoni PIN routes, email verification uses the configured
email provider, and first-shop phone capture uses no SMS or external phone-auth provider.

There are no Firebase phone-auth environment variables. Owner phone parsing is local to the web and
API packages through `libphonenumber-js`.

Phone-plus-PIN signup returns a high-entropy recovery code once. The user must save it before
continuing. Only its SHA-256 hash is persisted, successful recovery consumes and rotates the code,
and phone recovery does not send an SMS or use an OTP provider.

## Account-deletion processors

The production account-purge cron requires:

- `ACCOUNT_DELETION_PROCESSORS_JSON`: non-empty JSON array of processor IDs and HTTPS deletion
  webhook URLs.
- `ACCOUNT_DELETION_WEBHOOK_SECRET`: randomly generated shared signing secret with at least 32
  characters.

Do not put credentials in processor URLs or commit the secret. Each processor must validate the
HMAC signature and timestamp, handle the request ID idempotently, delete every supplied subject it
owns, and return an opaque `externalReference`. The purge worker keeps local account data when any
processor fails, then retries incomplete processors on its next run.
