# Browser review of chat # commands — 2026-10-18

The canonical registry contains 66 runtime tools, plus the local `#pos` command. Every runtime tool was submitted using the browser's Message composer and Send button against a stable production frontend build. The browser called the real API handlers through an isolated in-memory store; API responses and tool execution were not mocked. The connected OpenRouter runtime was available, but explicit # commands correctly bypass model interpretation.

Results:

- All 66 # names reached the intended command path. Empty-input checks returned 16 completed reads/no-ops, 49 clarification prompts, and one computer-provider prerequisite error.
- Valid-input journeys reached completed status for 46 distinct tools, including confirmations. Persisted product, customer, supplier, payment and receipt effects were checked. `#workspace.deliver` returned a file attachment.
- Contact identity proposal, confirmation, manual attachment, unlinking and rejection passed with disposable identities.
- Buyer chat exposes all 66 tools plus POS, asks for a shop when none is selected, and executes authorized shop reads when a shop is selected. `#pos` opens the point-of-sale terminal.
- Browser runs continued across multiple 20-turn sessions, including confirmations at the boundary.
- 67 targeted automated tests passed; web/API type checks, builds, lint and architecture boundaries were checked.

A clarification is expected behavior when required data is absent. The 13 computer tools need a configured worker and a real computer session; procurement's four tools need durable task/order context; checkout needs canonical cart items; messaging needs an authorized connected recipient/channel; network routing needs a reachable matching contact. These 20 tools were checked for # routing and prerequisite behavior, not successful external execution. The isolated harness does not establish production integration availability. No external messages or orders were sent.

## Fixes found by the review

- Explicit # commands bypass the buyer general-assistant route and remain subject to shop authorization.
- Explicit reads and chat confirmations retain the chat surface; product and invoice controls render inline.
- All seven generated management-card types parse and persist through the HTTP messaging API.
- Read responses contain bounded returned data, with credentials and internal runtime/OCR metadata omitted.
- Exhausted sessions renew, including after confirmations and restoration; unrelated missing-resource errors do not trigger session retries.
- Computer actions request the missing session before invoking a provider. The picker includes the upload file reference.
- Inherited object names such as `#constructor` are rejected safely.

## Repeat the routing sweep

Build the workspace packages and the frontend with `VITE_API_BASE_URL=/api`, serve the frontend preview on port 5176, then run:

```sh
node --env-file-if-exists=.env.openrouter --import tsx scripts/review-chat-hashtags.mjs
```

Set `BROWSER_REVIEW_ORIGIN` to use another frontend origin. The script starts a disposable API store, intercepts browser API requests into its actual handlers, and writes its report/screenshot under `.test-tmp/chat-hashtag-review/`. Playwright Chromium must be installed. It does not use or mutate the production database.

## Per-tool coverage

“Completed” means the valid-input browser journey returned completed status. “Prerequisite” means routing and missing-context behavior were checked; external success was not established.

| Command                     | Valid-input browser coverage |
| --------------------------- | ---------------------------- |
| `#products.list`            | Completed                    |
| `#invoices.list`            | Completed                    |
| `#reports.summary`          | Completed                    |
| `#notifications.list`       | Completed                    |
| `#compliance.review`        | Completed                    |
| `#network.route`            | Prerequisite                 |
| `#network.contacts.resolve` | Completed                    |
| `#network.identity.list`    | Completed                    |
| `#network.identity.propose` | Completed                    |
| `#network.identity.confirm` | Completed                    |
| `#network.identity.reject`  | Completed                    |
| `#network.identity.unlink`  | Completed                    |
| `#network.identity.add`     | Completed                    |
| `#commerce.search`          | Completed                    |
| `#commerce.checkout`        | Prerequisite                 |
| `#product.create`           | Completed                    |
| `#product.update`           | Completed                    |
| `#product.delete`           | Completed                    |
| `#product.stock_adjust`     | Completed                    |
| `#product.field.add`        | Completed                    |
| `#product.field.remove`     | Completed                    |
| `#customer.create`          | Completed                    |
| `#customer.update`          | Completed                    |
| `#supplier.create`          | Completed                    |
| `#supplier.update`          | Completed                    |
| `#contacts.search`          | Completed                    |
| `#supplier.contact.attach`  | Completed                    |
| `#purchase.record`          | Completed                    |
| `#purchase.price.change`    | Completed                    |
| `#purchase.history`         | Completed                    |
| `#sale.record`              | Completed                    |
| `#sales.history`            | Completed                    |
| `#route.record`             | Completed                    |
| `#route.history`            | Completed                    |
| `#procurement.submit`       | Prerequisite                 |
| `#procurement.respond`      | Prerequisite                 |
| `#procurement.quote.record` | Prerequisite                 |
| `#procurement.prepare`      | Prerequisite                 |
| `#invoice.draft`            | Completed                    |
| `#payments.debtors`         | Completed                    |
| `#payment.record`           | Completed                    |
| `#logistics.update_status`  | Completed                    |
| `#receipt.scan`             | Completed                    |
| `#receipt.review`           | Completed                    |
| `#receipt.confirm`          | Completed                    |
| `#receipt.correct`          | Completed                    |
| `#receipt.cancel`           | Completed                    |
| `#receipt.lookup`           | Completed                    |
| `#receipt.list`             | Completed                    |
| `#document_import.confirm`  | Completed                    |
| `#messaging.send`           | Prerequisite                 |
| `#workspace.deliver`        | Completed                    |
| `#computer.session.create`  | Prerequisite                 |
| `#computer.session.resume`  | Prerequisite                 |
| `#computer.navigate`        | Prerequisite                 |
| `#computer.observe`         | Prerequisite                 |
| `#computer.click`           | Prerequisite                 |
| `#computer.type`            | Prerequisite                 |
| `#computer.scroll`          | Prerequisite                 |
| `#computer.upload`          | Prerequisite                 |
| `#computer.control.take`    | Prerequisite                 |
| `#computer.control.release` | Prerequisite                 |
| `#computer.checkpoint`      | Prerequisite                 |
| `#computer.suspend`         | Prerequisite                 |
| `#computer.close`           | Prerequisite                 |
| `#unknown.clarify`          | Completed                    |
| `#pos`                      | Opened POS terminal          |
