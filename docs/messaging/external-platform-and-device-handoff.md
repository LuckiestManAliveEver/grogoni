# External platform and device message handoff

Grogoni messages use the device's active internet connection, including Wi-Fi, cellular data, or
another IP connection. Human Grogoni-to-Grogoni chats remain end-to-end encrypted. The composer also
offers two explicit ways to reach recipients outside Grogoni:

- **Share to apps** opens the operating-system share sheet. The user can choose any installed
  messaging, email, social, nearby-share, or connected-device target exposed by the operating
  system. If no share sheet exists, Grogoni copies the text to the clipboard when permitted.
- **Send as SMS** opens the selected phone SMS application with a reviewed E.164 recipient and
  text body. This supports feature-phone recipients without requesting restricted SMS permissions.

These are user-controlled handoffs. Grogoni does not choose the network interface, messaging app,
SIM, or external recipient and does not upload the message body, recipient, or platform choice to
handoff telemetry. The operating system and selected app decide whether to use Wi-Fi, cellular
data, carrier SMS, nearby sharing, or a connected-device service.

External platforms do not inherit Grogoni's end-to-end encryption or delivery receipts. A completed
share handoff means only that the selected app accepted the share action. Grogoni does not label the
message as sent, delivered, or read. Attachments stay in Grogoni for now; external handoff is
text-only.

The audit endpoint records only the authenticated account, optional business and conversation,
handoff channel (`platform_share_sheet` or `sms_external_app`), normalized status/error, and
timestamp. This provides operational visibility without storing external message content or phone
numbers.

Direct unattended delivery through WhatsApp Business, Telegram bots, Messenger, Instagram
Messaging, RCS Business Messaging, or email still requires an official provider adapter,
credentials, verified recipient identifiers, consent, and provider-specific policy approval. Grogoni
must not silently downgrade an encrypted direct message into one of those transports.
