# Push notification on Render deploy

Every time `grogoni` (which runs `db:migrate` and builds the frontend as part of its build,
so this also covers schema and web deploys) finishes successfully, subscribed browsers get a
web push notification telling them to refresh. This reuses the existing VAPID/web-push
infrastructure (`services/api/src/cp2/push.ts`, `apps/web/public/sw.js`) — there is no separate
notification channel to operate.

Scope: web PWA only. The native Android app (`apps/android`) has no push channel at all today (no
Firebase/FCM), so it receives nothing from this. Wiring FCM into the Android app is a separate,
larger piece of work (new Firebase project, `google-services.json`, native receiver, device-token
registration) and is not part of this feature.

## How it works

1. Render sends a [Standard Webhooks](https://www.standardwebhooks.com/) `deploy_ended` event to
   `POST https://grogoni.com/internal/render/deploy-webhook` whenever a deploy finishes.
2. `services/api/src/render-deploy-webhook.ts` verifies the `webhook-id` / `webhook-timestamp` /
   `webhook-signature` headers with the `standardwebhooks` library, using `RENDER_DEPLOY_WEBHOOK_SECRET`.
3. It ignores anything that isn't `status: "succeeded"` or isn't for `grogoni`, and
   deduplicates by `data.id` so a Render retry never double-notifies.
4. On a match it calls `Cp2Store.broadcastAppUpdateAvailable`, which sends an
   `app.update_available` push payload to every stored push subscription
   (`services/api/src/cp2/domains/messaging/store.ts`), pruning subscriptions the push service
   reports as expired (404/410).
5. `apps/web/public/sw.js`'s `push` handler shows an "Grogoni update available" notification and
   calls `self.registration.update()` so the next reload actually picks up the new build; clicking
   the notification focuses (or opens) the app.

## One-time setup (Render dashboard — cannot be scripted from this repo)

Render webhooks are workspace-level, not per-service, and can only be created by a workspace admin
in the dashboard:

1. Render Dashboard → your workspace → **Integrations → Webhooks → Add Webhook**.
2. Endpoint URL: `https://grogoni.com/internal/render/deploy-webhook`.
3. Events: select `deploy_ended` (and, if you also want it, `build_ended`; the handler ignores
   anything that isn't `deploy_ended`, so enabling extra events is harmless, just noisier in logs).
4. Save, then open the new webhook's **Settings** page and copy its signing secret
   (`whsec_...`).
5. Set that value as `RENDER_DEPLOY_WEBHOOK_SECRET` on the `grogoni` service's environment
   (`render.yaml` already declares the key with `sync: false`, so it must be entered by hand in the
   dashboard — it is a secret and is never committed).
6. Redeploy `grogoni` (or wait for the next deploy) so it picks up the env var. Until the
   var is set, `POST /internal/render/deploy-webhook` is never registered — `app.ts` only wires the
   route when `renderDeployWebhookSecret` is present — so an unconfigured environment is inert, not
   broken.

Restart required: yes — `grogoni` needs a restart/redeploy after setting
`RENDER_DEPLOY_WEBHOOK_SECRET` for the first time.

## Verifying it end to end

1. Subscribe a browser to push: open grogoni, allow notifications (this hits
   `POST /v1/push/subscriptions`).
2. Push any commit to `main` and let a deploy finish.
3. Render calls the webhook; check the API logs for
   `event: "render.deploy_webhook_broadcast"` with `sent >= 1`.
4. The subscribed browser should show a "Grogoni update available" notification within a few seconds
   of the deploy finishing.

## Tests

`tests/render-deploy-notifications.test.ts` covers:

- `Cp2Store.broadcastAppUpdateAvailable` sending to every subscription and pruning expired ones.
- The webhook route: valid-signature happy path, invalid-signature rejection, ignoring events that
  aren't a successful `deploy_ended`, ignoring services outside the notified allowlist, and
  deduping a replayed `webhook-id`.
