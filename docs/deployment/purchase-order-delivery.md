# Approved Purchase Order Delivery

Business records and submission receipts use the existing Neon database. The
Supabase Edge API runs the same confirmation-gated procurement capabilities as
the Node API. No Railway service or second agent dispatcher is introduced.

Apply migration `122_purchase_order_delivery.sql` before deploying this section.
The supplier surface provides prepared drafts, exact submission review, outgoing
receipts and a supplier inbox. Only the original draft actor may submit a draft.
Both submission and supplier response require the existing high-risk, one-time,
exact-input approval. The immutable draft remains `NOT_SUBMITTED`; a separate
receipt records what actually happened.

## Channels

- **GroGoni:** the recipient must be the supplier's existing linked, directly
  visible, consented business in the buyer's network. Only authorized users of
  that recipient business can read and accept or reject the incoming order.
- **Email:** the buyer supplies the supplier's saved email and selects an exact
  buyer-connected, authorized Gmail or Outlook sending mailbox. Existing mailbox
  OAuth and provider clients are reused; supplier records are not converted into
  customers. No new SMTP credential or arbitrary callback URL is accepted.
- **WhatsApp:** the buyer supplies the supplier's saved E.164 number and confirms
  consent. An operator must configure a buyer-scoped sender and an approved
  utility template before the option becomes available. The template has one
  text body parameter containing the exact order summary, at most 1,024 characters.

WhatsApp configuration is server-only `PURCHASE_ORDER_WHATSAPP_SENDERS`, a JSON
object keyed by buyer business ID. Each entry contains `phoneNumberId`, `token`,
`apiVersion`, `templateName` and `language`. Supply an approved supported API
version explicitly. Never put this configuration in a `VITE_` variable or commit
it. For Supabase, configure it as an Edge Function secret through the owning
account. Missing configuration disables WhatsApp; there is no fallback channel.
Email remains disabled until a usable buyer mailbox is connected.

## Delivery Evidence

The order reservation commits before an external provider call. Concurrent or
replayed submissions cannot send the same draft twice or select another channel.
Provider acknowledgment is recorded as `PROVIDER_ACCEPTED`, never as delivered,
paid, stocked, or accepted by the supplier. A timeout or missing acknowledgment
becomes `DELIVERY_UNKNOWN`. A crash can leave `DISPATCHING`, which the UI labels
pending verification. Neither state is automatically retried. Reconcile with
the provider before considering any new business action.

Supplier acceptance/rejection currently applies to the authenticated GroGoni
inbox only. External email/WhatsApp replies do not automatically change the
order's supplier-response state. No webhook delivery or reply claim is inferred
from a send acknowledgment. No stock or payment mutation is performed.

New preparation drafts capture product names with their lines, so names are bound
to the immutable draft digest rather than looked up after approval. Older drafts
without captured names retain their canonical product identifiers as labels.
Supplier-visible snapshots contain only the order's own lines, units and totals;
internal forecasts, invoice evidence and competing supplier quotes are excluded.
Native deletion cascades remove scoped order records. Review retention obligations
before account deletion; backups follow the separately configured private policy.

Tests use synthetic businesses and provider mocks. No real orders are sent during
certification. Production channel readiness depends on buyer mailbox authorization
and approved WhatsApp credentials/template configuration, separately from code CI.

Provider references: [Meta message-template request](https://www.postman.com/meta/whatsapp-business-platform/request/o65u5m5/send-message-template-text),
[Meta template components](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/types/component_object/).
