# Model-runtime verification

These checks cover the real deployed runtime: Render's API, Neon's Postgres and object storage, and
the Vercel inference deployment. Mocked tests do not satisfy live runtime verification.

## Prerequisites

Keep secrets in the shell or secret manager:

```bash
export GROGONI_API_URL=https://grogoni.com
export VERCEL_INFERENCE_URL=https://<your-vercel-deployment>.vercel.app
export GROGONI_TEST_TOKEN=<authenticated-session-token-or-cookie>
export GROGONI_TEST_SHOP_ID=<shop-id>
export GROGONI_MODEL_ID=smollm2-360m
```

`VERCEL_INFERENCE_URL` is a public HTTPS deployment (Vercel serves it directly), unlike the old
Render-private inference host - `/health` needs no bearer token, since it carries no model or
artifact context of its own. Any real model check must go through Render, which is the only party
that can mint a signed Neon artifact URL.

## Individual checks

```bash
curl --fail --silent --show-error "$VERCEL_INFERENCE_URL/health"

curl --fail --silent --show-error "$GROGONI_API_URL/health/ai"
```

The second command performs a real generation (Render resolves the runtime binding, signs a Neon
artifact URL, calls Vercel, and waits for a real inference response) and must return
`status: "ready"` with `model.status: "ready"` and `model.model` equal to `$GROGONI_MODEL_ID`.
Vercel's own `/health` liveness alone is not a model probe.

Public API readiness:

```bash
curl --fail --silent --show-error "$GROGONI_API_URL/health/ready"
```

Resolve the inherited default through the authenticated canonical API, then send a turn. The test
shop must have no explicit runtime override. If `GROGONI_TEST_TOKEN` is only a token value, use the
application's actual cookie name as shown by the login flow:

```bash
curl --fail --silent --show-error \
  -H "Cookie: $GROGONI_TEST_TOKEN" \
  "$GROGONI_API_URL/businesses/$GROGONI_TEST_SHOP_ID/runtime/effective"

curl --fail --silent --show-error -X POST \
  -H "Content-Type: application/json" \
  -H "Cookie: $GROGONI_TEST_TOKEN" \
  --data '{"message":"Reply briefly and identify the selected model."}' \
  "$GROGONI_API_URL/businesses/$GROGONI_TEST_SHOP_ID/runtime/turns"
```

The effective runtime must report Pi, the configured model, execution type `vercel`, a non-empty
host id, `source: "default"`, and `ready: true`. The chat result must identify that same model,
`vercel`, and a non-empty inference request ID.

## One-command gate

After the variables above are set:

```bash
pnpm verify:production-runtime
```

The script checks API/Neon readiness, Vercel liveness, a real end-to-end probe through
`/health/ai`, the canonical effective default runtime, and one real chat request. It exits non-zero
at the first failed stage and emits `DEFAULT_RUNTIME_UNAVAILABLE` when the default graph or adapter
is not executable.

The equivalent opt-in Vitest flow also performs activation and reload verification:

```bash
RUN_LIVE_MODEL_RUNTIME_TEST=true pnpm test:live-model-runtime
```

Individual liveness/probe checks are also available standalone:

```bash
pnpm inference:health   # VERCEL_INFERENCE_URL - Vercel deployment liveness only
pnpm inference:probe    # GROGONI_API_URL - real end-to-end inference through Render
```

## Final deployment sequence

1. Apply Neon-compatible migrations (`pnpm db:migrate`, includes `079_vercel_inference_artifacts`).
2. Upload the GGUF artifact to Neon object storage at the object key
   `cp2_runtime_model_artifacts` expects for the model being deployed.
3. Deploy `services/ai-runtime` to Vercel. Confirm liveness with `pnpm inference:health`.
4. Configure the Render API's `VERCEL_INFERENCE_URL`, `GROGONI_INFERENCE_SERVICE_TOKEN` (identical to
   Vercel's), and `NEON_MODEL_STORAGE_*` credentials, then deploy the API.
5. Confirm database readiness (`/health/ready`).
6. Confirm the real end-to-end model probe (`pnpm inference:probe`, or `/health/ai` directly).
7. Resolve the default runtime and require Pi + SmolLM + `vercel` + `ready: true`.
8. Open the PWA and confirm settings show the same effective runtime.
9. Send one real chat message and verify response metadata (`executionTarget: "vercel"`).

Record each live result separately. A structural build cannot be reported as a live Neon,
activation, probe, or chat pass.
