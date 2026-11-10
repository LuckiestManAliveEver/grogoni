# Canonical browser application

`apps/web` is Grogoni's canonical user-facing application. It serves ordinary browser visits
and installed PWAs from the same React/Vite build. Installation is optional. Android and iOS
hosts are optional capability adapters; they must not become prerequisites for authentication,
onboarding, messaging, catalogues, workspaces, or supported commerce actions.

## Development and delivery

Run `pnpm dev:web` for the browser application and `pnpm dev:api` for its backend, or
`pnpm dev:local` for both with local runtime configuration. Build the browser with
`pnpm --filter @grogoni/web build`. The production workspace build includes this web build;
it does not require an Android SDK, Xcode, a SIM, contacts access, or an app store.

`apps/web/index.html` is the entry point. `apps/web/public/manifest.webmanifest` defines
installation identity and scope. `apps/web/public/sw.js` provides browser caching and push
handling. Server authorization and durable commerce records remain authoritative regardless
of the host. Offline drafts and pending actions must never be displayed as confirmed payments
or inventory reservations before server acknowledgment.

## Capability boundaries

Use browser feature detection and an explicit user action before requesting optional permissions.
An unavailable camera must permit file upload or manual entry. Missing push or installation APIs
must preserve browser access and in-app status. Native SMS, SIM selection, dialer, contacts and
linked-device services are optional transports, separate from internet-based Grogoni messaging.
Inference credentials and payment-provider secrets belong on the server.

Browser support, device performance, crash recovery, and real transaction completion require
their own verification. This architecture decision does not claim those acceptance tests pass.
The implementation and evidence ledger is `../testing/pwa-commerce-readiness-progress.md`.
