# Shopping across connected shops and external websites

Customers use the ordinary marketplace chat without owning a shop. Shopping
messages go to `POST /buy/assistant`; reminders and delivery tracking keep their
existing paths. The assistant can search connected shops and open HTTPS retailer
websites on demand through the isolated computer worker. No retailer connector
registration is needed. Website observations are untrusted data, and the customer
assistant's tool allowlist only permits search, navigation, observation, scrolling
and preparation of a checkout review. It cannot click payment buttons, submit
external orders, or record payments.

The assistant combines selected connected-shop items and observed retailer product
URLs into one review. Connected-shop names and prices come from server records;
external prices are unconfirmed and excluded from the known total. Only URLs the
assistant actually observed in this shopping chat can enter its external review.

The customer replies **confirm checkout** or **cancel checkout**. Confirmation acts
on the stored review, never on model-generated confirmation arguments. Changed
prices require another review. A confirmed review creates the existing unified
checkout summary, with requested connected-shop orders and pending external website
checkout links. Repeating a confirmation request does not create duplicate orders.
The summary renders in the same chat using the unified receipt card. External lines
are clearly marked as pending, not purchased. Payment processing is excluded.

## Deployment

Apply migration `123_buyer_shopping_sessions.sql`. The existing configured default
model serves the shopping assistant. Set `COMPUTER_RUNTIME_URL` and
`COMPUTER_RUNTIME_SERVICE_TOKEN` on the API to connect its browser worker; both Node
and Edge entry points wire these settings. Missing browser providers are reported
as unavailable, never as a successful connection. Retailer authentication,
interactive challenges, or unsupported pages may require visiting the retailer
website directly.

Account-scoped reviews, bounded conversation history, browser references, and turn
idempotency results persist in `buyer_shopping_sessions`. They are included in
snapshot restore and account deletion. The browser's storage key contains only an
account/chat-scoped session ID. Credentials remain outside the chat protocol.

On Edge, model and browser calls run between short snapshot read/write transactions.
Optimistic snapshot writes reject concurrent updates. Exact confirmation/cancellation
commands run in the regular transactional path without making a model call.

The authorized business runtime also exposes `commerce.website.open`; its existing
skill bindings/model-template allowlists must enable it and the relevant computer
tools. Business-runtime computer actions retain their existing approval policy.
