# Third-party notices

## Receipt OCR

The active on-device scanner uses these pinned packages (licenses from their package manifests):

- Tesseract.js 7.0.0: Apache-2.0.
- tesseract.js-core 7.0.0: Apache-2.0.
- @tesseract.js-data/eng 1.0.0: MIT package, distributing the selected English data assets.

Preserve upstream notices for worker/WASM/language assets when publishing them. Asset provenance and version markers live in `apps/web/src/offline-ocr-assets.ts` and `apps/web/vite.config.ts`; see `docs/ocr-licensing.md`.

The retired Python OCR-worker dependencies are no longer part of the receipt scanner. Online receipt images use the existing OpenRouter-backed model and may incur provider charges; its terms are separate from these open-source OCR packages.

## Authentication

- libphonenumber-js 1.13.9 — MIT — E.164 parsing and normalization.
- @simplewebauthn/server 13.3.2 — MIT — WebAuthn/passkey ceremony validation.
- @simplewebauthn/browser 13.3.0 — MIT — browser passkey ceremony support.

Phone numbers are normalized only; the authentication system does not perform SMS verification.

## Optional on-device AI models

Grogoni can download these optional GGUF weights directly from Hugging Face into private device
storage. The weights are not distributed in this repository or uploaded to Grogoni:

- HuggingFaceTB SmolLM2 360M Instruct GGUF — Apache License 2.0.
- Qwen Qwen2.5 0.5B Instruct GGUF — Apache License 2.0.
- Qwen Qwen2.5 1.5B Instruct GGUF — Apache License 2.0.

The in-app catalog links to each upstream model card and license. Custom models are user-supplied;
their licenses and commercial-use terms remain the user's responsibility.

## Android MMS PDU codec

The Android application vendors the AOSP ApiDemos MMS PDU codec under
`apps/android/app/src/main/java/com/example/android/mmslib`. Copyright (C) 2007–2008
Esmertec AG and The Android Open Source Project. Licensed under Apache License 2.0;
original source headers, the license and pinned provenance are included in that directory.

## Optional WhatsApp Linked Devices connector

- Baileys 7.0.0-rc14 — MIT — Copyright (c) 2025 Rajeh Taher/WhiskeySockets.
  Used only by the opt-in Node connector, with its dependency graph pinned in `pnpm-lock.yaml`.
  Upstream: <https://github.com/WhiskeySockets/Baileys>.
  License: `docs/licenses/Baileys-MIT.txt`.
  The package includes native protocol dependencies; Android ABI support is not certified.
- libsignal 6.0.0 — GPL-3.0 — transitive Baileys protocol dependency.
  Modified by Grogoni on November 7, 2026 to remove direct console logging of session/protocol
  internals. The source patch is `patches/libsignal@6.0.0.patch`, applied by pnpm; see `patches/README.md`.
  License: `docs/licenses/libsignal-GPL-3.0.txt`. Its distribution requirements must be assessed
  before shipping this optional connector; Baileys' MIT license does not cover every dependency.
- whatsapp-rust-bridge 0.5.4 — MIT — transitive native protocol dependency.

## Chat interaction patterns

- DeepSeek Chat Demo (https://github.com/deepseek-ai/chat-demo, commit 5d5dd754) — MIT, Copyright
  (c) 2026 DeepSeek — reference for the sibling reply-version pattern (previous / next, "n of m").
  No source code from that project is included in Grogoni: reply versions
  (`docs/architecture/conversation-reply-versions.md`) are an independent implementation with a
  different data model.
