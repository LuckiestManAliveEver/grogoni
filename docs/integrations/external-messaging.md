# External messaging from chat

Chat has two explicit routes:

- **Send via** uses a provider identity verified for the selected customer and shop. Replies enter that customer's canonical conversation. `#messaging.send` proposes the same operation and requires confirmation.
- **Share to apps** opens WhatsApp, Telegram, Messenger, Instagram, TikTok, or X in a new tab and copies the draft when clipboard access is available. The picker retains a selectable draft if clipboard access fails. The user chooses the recipient and sends in that app. Opening an app is never recorded as delivery.

Normal message explicitly selects Grogoni. Refreshing endpoints does not replace that choice with email or another provider. A disconnected explicitly selected provider produces an error and retains the draft; the server does not substitute a different app.

## Provider support

| Provider      | Direct transport                                         | Incoming messages                                              | Activation                                                                                  |
| ------------- | -------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| WhatsApp      | Meta Cloud API text replies                              | Signed Meta message batches                                    | Business account, app authorization, verified phone, linked customer                        |
| Messenger     | Meta Send API text replies                               | Signed Page messages/referrals                                 | Page authorization and linked customer                                                      |
| Instagram     | Instagram Login Send API text replies                    | Signed professional-account messages                           | Professional account authorization and linked customer                                      |
| X             | X API v2 user-authorized DMs                             | Signed Account Activity DM events                              | User token, Account Activity access, linked customer                                        |
| Telegram      | Bot API                                                  | Secret-authenticated bot updates                               | Bot token, webhook secret, bot username, linked customer                                    |
| Gmail/Outlook | Existing connected-mailbox APIs                          | Existing mailbox history sync                                  | OAuth client configuration and mailbox owner authorization                                  |
| SMS           | Twilio Messages API or existing Android device transport | Signed Twilio inbound forms or authenticated Android ingestion | Sender account/number or an SMS-capable registered Android device                           |
| TikTok        | Explicit app handoff                                     | Replies remain in TikTok                                       | Direct Business Messaging requires approved partner access; it is not advertised as enabled |

Meta free-text replies require a recent inbound message (24 hours). This implementation does not send approved-template campaigns outside that window. Document attachments use connected email; other direct transports reject attachments instead of discarding them. Provider acceptance is recorded as sent/queued, not delivered. An ambiguous timeout is not automatically resent. Recipient STOP/UNSUBSCRIBE messages revoke SMS and WhatsApp opt-in.

## Shop-bound credentials

Configure secrets on the API/Edge runtime, never in Vite variables or browser storage. No external provider credentials are included in the repository. Supabase deployment forwards only nonempty explicitly supplied messaging secrets and leaves already installed credentials untouched.

For one shop, set `EXTERNAL_MESSAGING_SHOP_ID` to its canonical business UUID alongside the relevant keys below. A credential does not enable messaging for any other shop.

For multiple shops, set the secret `EXTERNAL_MESSAGING_CONNECTIONS_JSON` to an object mapping business UUIDs to their provider environment settings. Each sender account must belong to the specified shop. Example shape (all values below are placeholders):

```json
{
  "business-uuid": {
    "WHATSAPP_ACCESS_TOKEN": "provider-token",
    "WHATSAPP_PHONE_NUMBER_ID": "provider-phone-id",
    "WHATSAPP_PHONE_NUMBER": "+442079460000",
    "WHATSAPP_APP_SECRET": "provider-app-secret",
    "WHATSAPP_VERIFY_TOKEN": "random-subscription-verification-token"
  }
}
```

| Provider                | Required settings                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| WhatsApp                | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_PHONE_NUMBER`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` |
| Messenger               | `MESSENGER_ACCESS_TOKEN`, `MESSENGER_PAGE_ID`, `MESSENGER_APP_SECRET`, `MESSENGER_VERIFY_TOKEN`                              |
| Instagram               | `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_ACCOUNT_ID`, `INSTAGRAM_USERNAME`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_VERIFY_TOKEN`     |
| X                       | `X_USER_ACCESS_TOKEN`, `X_USER_ID`, `X_CONSUMER_SECRET`                                                                      |
| Twilio SMS              | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_URL`                                        |
| Telegram (platform bot) | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`                                                     |
| Gmail                   | `MAILBOX_GOOGLE_CLIENT_ID`, `MAILBOX_GOOGLE_CLIENT_SECRET`                                                                   |
| Outlook                 | `MAILBOX_MICROSOFT_CLIENT_ID`, `MAILBOX_MICROSOFT_CLIENT_SECRET`                                                             |

`META_GRAPH_VERSION` defaults to `v25.0`; it can be set per shop. `TWILIO_WEBHOOK_URL` must exactly match the public callback URL configured at Twilio, including any query string, because it participates in signature verification. X uses a **user** access token with DM authorization, not an application-only bearer token. Account Activity must be authorized separately.

Do not use browser automation to bypass provider permissions, account challenges, or access restrictions. The app handoff is available for user-controlled sending; the computer runtime is not a substitute for a provider authorization.

## Webhooks and linking

Callbacks use `https://grogoni.com/api/v1/webhooks/channels/{provider}`. The same route supports Meta GET subscription verification and X CRC verification. Telegram uses its existing secret header. Meta and X validate HMACs over original bytes. Twilio validates its exact configured URL and sorted form fields.

The Edge loader verifies the callback before loading a shop's channel state. Authenticated sender-account bindings, existing linked threads, or hashed one-time customer grants determine the scope; a caller-supplied business ID does not. Invalid signatures load no tenant records.

In chat, open **More message actions → Share to apps → Business messaging connections**. Connect Gmail/Outlook through OAuth. For an authorized business channel, choose an existing customer and create a verification link. Give that link and the displayed `link <token>` message to the customer; they must send it from their provider account. Grants expire after 15 minutes. Instagram and X may require the customer to paste the verification message manually. A registered login email alone does not authorize a mailbox.

API callers can use:

1. `GET /businesses/{businessId}/channels/readiness`
2. `POST /businesses/{businessId}/customers/{customerId}/channel-link-grants`
3. `GET /businesses/{businessId}/channel-endpoints?customerId=...`
4. `#messaging.send {"customerId":"...","provider":"whatsapp","text":"Your order is ready"}` and its confirmation

## Official contracts

- [Meta WhatsApp messages](https://www.postman.com/meta/whatsapp-business-platform/folder/13382743-ba8d099d-007e-4b52-b9f2-3cf3c60e4fbc)
- [Meta Messenger Send API](https://www.postman.com/meta/messenger-platform-api/folder/vilwbh4/send-api)
- [Meta Instagram Login messaging](https://www.postman.com/meta/instagram/request/scob1z4/text-message)
- [X DM quickstart and authorization](https://docs.x.com/x-api/direct-messages/manage/quickstart)
- [Twilio Messages API](https://www.twilio.com/docs/messaging/api/message-resource)
- [TikTok Business Messaging access](https://business-api.tiktok.com/portal/docs/business-messaging-api-get-started/v1.3)
