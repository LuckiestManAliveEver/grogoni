# Receipt images in chat

Online assistant chats send uploaded receipt images to GPT-6 Luna through the authenticated `POST /v1/chat/images/read` route. No on-device scanner installation is required. The server holds the OpenRouter key and sends private image bytes as a base64 image input; it does not expose an image at a public URL. The configured `gpt-6-luna` mapping must accept image input. Provider fallback is disabled and returned model identity is checked.

The reader transcribes the image without tools. Its text is marked as untrusted reference data and added to the chat request **before** routing buyer messages to the daemon or seller messages to the shop runtime, including saved conversations. Reading an image alone does not create purchases or change stock. Messages addressed to other people are not sent to the reader.

Supported images: JPEG, PNG, WebP and GIF, up to 10 MB each. Image bytes are checked against the declared MIME type. Requests require a device/account session. The Node API limits this route to 12 requests per minute per IP through its HTTP rate limiter. The endpoint returns `Cache-Control: no-store` and does not persist the transcription; normal chat attachment/message storage still applies.

If Luna is unavailable or returns an incomplete reading, chat retains the draft and attachment for retry. Chat image reading requires an online connection. The separate offline receipt-capture scanner remains available for its existing offline workflow. PDFs and other text documents continue through the existing shop document extractor; scanned PDFs are not covered by this image endpoint.

Verification uses a synthetic receipt with values present only in its pixels: receipt ZXQ-4827, rice 360, soap 210, total KES 570, cash 600, change 30. Regression coverage lives in `chat-image-routes.test.ts`, `chat-attachment-extraction.test.ts`, and `chat-assistant-journeys.test.tsx`.
