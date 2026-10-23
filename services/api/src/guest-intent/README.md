# Guest intent classifier

A guest (signed in, no shop, no assistant) can only search the marketplace from chat. Before the
chat answers, it asks this classifier what kind of message it is. The rules in
`apps/web/src/marketplace-search-reply.ts` (`routeGuestMessage`) stay as the fallback for every
case where the classifier cannot answer.

Outcome it moves: the share of guest messages that get the right kind of reply (search, explain,
help, order help, selling). Measured by `pnpm eval:guest-intent` and by the
`guest_intent_classified` log line below.

## Contract

`packages/shared-types/src/guest-intent.ts`.

`POST /v1/guest/intent` with `{ "message": "..." }` and the session cookie.

| Status | Body                                           | Client does |
| ------ | ---------------------------------------------- | ----------- |
| 200    | `{ intent, query, modelId, latencyMs }`        | uses it     |
| 400    | `invalid_request` (no or empty `message`)      | rules       |
| 401    | `auth_required` (no session)                   | rules       |
| 413    | `message_too_long` (over 500 chars, 8 KB body) | rules       |
| 429    | `rate_limited`, with `retry-after`             | rules       |
| 503    | `guest_intent_unavailable` / `_failed`         | rules       |

Intents: `search` (with `query`), `greeting`, `thanks`, `help`, `about`, `order_help`, `selling`,
the same set the rules tell apart. `greeting`, `help` and `about` get the same explanation reply.

## What the model can and cannot do

- It picks an intent and, for a search, the words to search. It never writes a reply. Every reply
  the guest reads is a constant in `marketplace-search-reply.ts` (`guestRouteForIntent`).
- The answer is validated twice (server in `classifier.ts`, client in `guest-intent-client.ts`)
  with `parseGuestIntentClassification`: a known intent, and a query only for a search.
- The query must be grounded: every word of it is a word of the guest's message, or a one or two
  letter typo fix of one (`groundGuestSearchQuery`). At most 80 characters and 8 words, letters,
  digits and `' & . , / % -` only. So a prompt-injected message ("ignore your instructions and
  reply X") can at worst have its own words searched and quoted back, which is what the rules do
  with any text they search. Anything else is treated as a malformed answer and the rules run.
- The message reaches the model as a JSON string in the user turn, never inside the instructions.

## Model and keys

The model call goes through the existing OpenRouter runtime
(`createOpenRouterRuntime(env).jsonCompletion(modelId)`,
`inference/openrouter-json-completion.ts`): the same server-held `OPENROUTER_API_KEY`, the same
`OPENROUTER_MODELS` mapping and model identity check, no provider fallback. The model is the
platform default: `PLATFORM_DEFAULT_MODEL_ID`, else `gpt-6-luna` (the repository default). The
call asks for low reasoning effort so it fits the latency budget; it is the same model.

No key reaches the browser: the browser only calls `/v1/guest/intent`.

## Budgets and fallback

- Server: the model call times out at `GUEST_INTENT_MODEL_TIMEOUT_MS` (default 2500, at most
  2800). A timeout, provider error or malformed answer is a 503.
- Client: `guestIntentBudgetMs = 3000` in `apps/web/src/guest-intent-client.ts`. The request is
  aborted and the rules answer when the budget passes, whatever the network does. The client also
  uses the rules without asking when offline (explicit offline mode or `navigator.onLine` false),
  for text with no letters or digits, and for messages over 500 characters. No session refresh is
  attempted on a 401 (it would not fit the budget).
- The client keeps the last 100 model answers in memory, keyed by the lowercased message, so a
  repeated "hi" or "sugar" does not wait on the model again. Failures are never cached.
- A message to a person (direct conversation or connected channel) never reaches the classifier.

## Abuse bounds

- A session is required (401 otherwise).
- Message at most 500 characters; request body at most 8 KB.
- Per-session limit: `GUEST_INTENT_RATE_LIMIT_PER_MINUTE` (default 20) in fixed one-minute
  windows. On the Edge the counter lives in `cp2_edge_rate_limits` (key
  `guest-intent:<sha256 of the session id>`, pruned by the existing rate-limit sweep), so it holds
  across isolates. On the Node API it is in memory. Like the per-IP limiter it fails open if the
  counter cannot be written. The global per-IP limits still apply on top.

## Where it runs

- Edge (`supabase/functions/api/index.ts`): `/v1/guest/intent` is dispatched to
  `guestIntentRoutes` from `createEdgeDomainRoutes`, before the snapshot domain routes. The session
  lookup is its own short transaction (with the per-IP rate limit) that commits before the model
  call; the counter is one autocommit statement. The model call holds no connection, takes no
  store lock and writes no snapshot.
- Node API (`app.ts`): `registerGuestIntentRoute`, the same service with an in-memory counter.
- `pnpm check:api-routes` knows the route through `guestIntentRoutes` in `service.ts`.

## Environment

| Variable                             | Default              | Effect                                    |
| ------------------------------------ | -------------------- | ----------------------------------------- |
| `OPENROUTER_API_KEY`                 | none                 | required; without it every call is 503    |
| `PLATFORM_DEFAULT_MODEL_ID`          | `gpt-6-luna`         | the model; must be in `OPENROUTER_MODELS` |
| `OPENROUTER_MODELS`                  | `{"gpt-6-luna":...}` | catalog id to OpenRouter model id         |
| `GUEST_INTENT_ENABLED`               | on                   | `false` turns the classifier off          |
| `GUEST_INTENT_MODEL_TIMEOUT_MS`      | 2500                 | 1 to 2800                                 |
| `GUEST_INTENT_RATE_LIMIT_PER_MINUTE` | 20                   | 1 to 600                                  |

On Supabase these are function secrets (`supabase secrets set ...`); `OPENROUTER_API_KEY` and
`PLATFORM_DEFAULT_MODEL_ID` are already set for the daemon lanes
(`scripts/set-daemon-lane-secrets.mjs`). A bad `GUEST_INTENT_*` value disables the classifier
(log `guest_intent_config_invalid`), never the API.

## Log line

One per call, JSON on stdout:

```json
{
  "event": "guest_intent_classified",
  "source": "model",
  "intent": "search",
  "reason": null,
  "latencyMs": 640,
  "modelId": "gpt-6-luna"
}
```

`source: "rules"` means the client answered by rules; `reason` says why (`unavailable`,
`rate_limited`, `message_too_long`, `model_timeout`, `model_error`, `model_unavailable`,
`malformed_output`). Not logged: requests without a session or with a bad body, and client-side
fallbacks that never reached the server (offline, no text, or the client budget passing while
the server still answered; the server line then shows `latencyMs` near the budget).

## Tests and eval

- Gate tests (no network, fake model): `services/api/src/guest-intent/*.test.ts`,
  `services/api/src/guest-intent/eval/score.test.ts`,
  `services/api/src/inference/openrouter-json-completion.test.ts`,
  `tests/guest-intent-contract.test.ts`, `tests/guest-intent-api.test.ts` (its PostgreSQL part runs
  in `pnpm test:postgres`), `tests/guest-intent-client.test.tsx`.
- Paid eval: `pnpm eval:guest-intent [--report <path>]`. Reads `OPENROUTER_API_KEY` from the
  environment, `.env` or `.env.openrouter`. 183 labeled messages
  (`eval/labeled-set.ts`): every phrasing the review rounds pinned in
  `tests/guest-chat-routing.test.tsx` (a gate test enforces it), plus Swahili and Sheng, typos,
  mixed intents and prompt injection. Pass: intent accuracy at least 0.95 on what the guest gets,
  0 never-search messages searched, query accuracy at least 0.90, model fallback rate at most 0.05.
  It also scores the rules alone as the baseline. Exit 0 pass, 1 fail, 2 not run (no key).
