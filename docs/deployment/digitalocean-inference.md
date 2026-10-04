# Move Vercel inference to DigitalOcean

This runbook moves `services/ai-runtime` to a DigitalOcean App Platform container. The repository
currently configures the website and API on Render and stores application data and model artifacts
in Neon. Those services are separate from the Vercel inference deployment.

## Compatibility

The container serves the existing `/health`, `/ready`, and authenticated `/v1/inference` endpoints.
It uses the same artifact verification, CPU-only llama.cpp runtime, and NDJSON streaming protocol.
Only one generation runs per container; overlapping requests receive retryable HTTP 503 with
`Retry-After: 1`. Health checks remain available during generation. Client disconnects cancel work,
and SIGTERM gives active requests up to 25 seconds to finish.

The existing `VERCEL_INFERENCE_URL`, `VERCEL_MAX_ARTIFACT_BYTES`, execution target `vercel`, and
database host IDs remain compatibility names. They do **not** require requests to reach Vercel:
pointing `VERCEL_INFERENCE_URL` at DigitalOcean changes the remote host. Do not rename database
bindings or re-run historical migrations for this hosting change.

## 1. Prepare and verify the image

Use Node 22 and pnpm 10.28.2 from the repository root:

```sh
pnpm --filter @grogoni/ai-runtime build
pnpm exec vitest run tests/inference-http-server.test.ts tests/vercel-inference-service.test.ts
pnpm check:render-inference-boundaries
docker build --platform linux/amd64 -f services/ai-runtime/Dockerfile -t grogoni-inference .
```

To smoke-test locally, create a private environment file outside the repository containing
`GROGONI_INFERENCE_SERVICE_TOKEN` (at least 32 characters) and `MODEL_ARTIFACT_ALLOWED_HOSTS`:

```sh
docker run --rm --env-file /path/to/private/inference.env -p 127.0.0.1:8080:8080 grogoni-inference
```

In another terminal, check `http://127.0.0.1:8080/health` and `/ready`. Neither check loads a model.
Verify the actual model separately with the existing `pnpm inference:live-probe` instructions in
[the inference runbook](vercel-inference.md#verification).

## 2. Create the DigitalOcean app

1. Push the reviewed migration commit to the branch DigitalOcean will deploy.
2. Connect `LuckiestManAliveEver/grogoni` in DigitalOcean App Platform. Import
   [`.do/inference.yaml`](../../.do/inference.yaml) as the app specification, or enter its settings
   in the dashboard: repository root build context, Dockerfile
   `services/ai-runtime/Dockerfile`, HTTP port `8080`, health check `/ready`.
3. Review the region (`nyc`) against the actual API/storage region before creating the app.
4. Set these runtime environment variables before deployment:

   | Variable                          | Value                                                                |
   | --------------------------------- | -------------------------------------------------------------------- |
   | `GROGONI_INFERENCE_SERVICE_TOKEN` | Copy the existing API's value; store as an encrypted secret.         |
   | `MODEL_ARTIFACT_ALLOWED_HOSTS`    | Copy the existing Vercel allowlist: hostnames only, comma separated. |
   | `VERCEL_MAX_ARTIFACT_BYTES`       | `450000000`, matching the existing limit.                            |
   | `INFERENCE_MAX_INPUT_CHARACTERS`  | `64000`                                                              |
   | `INFERENCE_MAX_OUTPUT_TOKENS`     | `512`                                                                |
   | `INFERENCE_RUNTIME_CACHE_ENTRIES` | `1`                                                                  |

   The template deliberately leaves the token and host allowlist empty. It cannot become ready
   until they are supplied. Do not copy database credentials or storage signing keys into this app.

5. Review the monthly charge and deploy. The template selects one shared CPU with 2 GiB RAM
   (`apps-s-1vcpu-2gb`), currently $25/month. This is a starting allocation for the existing small
   CPU model, not a performance guarantee. Check real cold/warm inference latency and memory use
   before increasing traffic. Automatic deployments are disabled for the initial migration.
6. Record the HTTPS `ondigitalocean.app` URL provided by DigitalOcean.

App Platform uses ephemeral container storage, with a 4 GiB writable filesystem limit and no
attached volumes. Models downloaded into `/tmp` must be fetched again after container replacement.
The existing artifact downloader retains old artifact files on disk independently of the in-memory
cache; monitor disk use and replace the container when changing many model versions. Larger model
collections or persistent model caches call for a Droplet/volume deployment and cache management.

References: [App specification](https://docs.digitalocean.com/products/app-platform/reference/app-spec/),
[pricing](https://docs.digitalocean.com/products/app-platform/details/pricing/), and
[platform limits](https://docs.digitalocean.com/products/app-platform/details/limits/).

## 3. Verify, then switch API traffic

1. Leave the Vercel deployment available and save the API's previous `VERCEL_INFERENCE_URL`.
2. Check the new DigitalOcean `/health` and `/ready` endpoints. `/ready` checks configuration;
   real native-model execution must still be proven on DigitalOcean.
3. Point a staging API with a test account and artifact metadata at the new URL, using the same
   shared service token. Run `pnpm inference:probe` with that API's `GROGONI_API_URL`. Check first-token
   latency, completed streamed output, and a second turn with `cacheHit: true` in the container logs.
   This also verifies native llama.cpp works inside App Platform's container sandbox.
4. Change **only** `VERCEL_INFERENCE_URL` on the production Render API to the new HTTPS base URL
   (without `/v1/inference`). Keep the shared token, model bindings, timeout, and Neon settings.
   Redeploy the API.
5. Run:

   ```sh
   VERCEL_INFERENCE_URL=https://YOUR-APP.ondigitalocean.app pnpm inference:health
   GROGONI_API_URL=https://grogoni.com pnpm inference:probe
   pnpm verify:production-runtime
   ```

   The last command requires `GROGONI_API_URL`, the new `VERCEL_INFERENCE_URL`, `GROGONI_TEST_TOKEN`, and
   `GROGONI_TEST_SHOP_ID` in your private environment. Use a designated test shop/account.

6. Verify a complete chat turn from the website. Confirm streaming, a warm second request, and
   acceptable behavior under overlapping requests before routing normal traffic to the service.
7. Update `VERCEL_INFERENCE_URL` in GitHub Actions variables if the AI evaluation workflow uses it.
8. After a stable observation period, retire the old Vercel project in its dashboard.

No website DNS changes are needed for this scope: the API calls DigitalOcean's HTTPS URL directly.

## Rollback

Restore the previous `VERCEL_INFERENCE_URL` on the Render API and redeploy it. Keep the original
Vercel deployment and shared token valid until the migration is verified. No database restore or
binding migration is needed. Deleting Vercel before verification removes this quick rollback path.
