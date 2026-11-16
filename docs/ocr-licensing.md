# OCR dependencies and provenance

Verified from pinned repository package manifests on 2026-11-16. The current browser scanner uses these packages:

| Package                  | Version | Declared package license | Use                                          |
| ------------------------ | ------- | ------------------------ | -------------------------------------------- |
| `tesseract.js`           | 7.0.0   | Apache-2.0               | Browser worker and JavaScript OCR interface  |
| `tesseract.js-core`      | 7.0.0   | Apache-2.0               | Browser WASM engine                          |
| `@tesseract.js-data/eng` | 1.0.0   | MIT                      | Distribution package for cached English data |

Pinned assets are listed in `apps/web/src/offline-ocr-assets.ts`. The English data marker is `eng-4.0.0_best_int`; `apps/web/vite.config.ts` publishes the selected language, worker and WASM assets. Installation validates the generated manifest and SHA-256 hashes. Package license metadata is not a blanket legal determination about arbitrary replacement models or assets: preserve upstream license/provenance when changing them.

The old Python OCR worker, PaddlePaddle/PaddleOCR, pytesseract, Pillow, OpenCV and redis-py are not current receipt-worker dependencies. Do not add them to a deployment or infer that a historical PaddleOCR metadata label proves execution.

Online image reading uses the existing OpenRouter-backed Luna model rather than this browser OCR engine. Hosted inference requires the configured provider account and may incur charges; it is not covered by Tesseract's open-source package licenses.

Update [third-party notices](../THIRD_PARTY_NOTICES.md), pinned asset versions and the installer manifest together when changing scanner dependencies. See [receipt processing](receipt-ocr.md) for actual supported paths and limits.
