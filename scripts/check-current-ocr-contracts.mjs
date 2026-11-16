// Current operational references only. Dated audits, migrations, compatibility types and
// explicit retired-deployment guards are intentionally not rewritten as current architecture.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const activeDocuments = [
  ".env.example",
  "THIRD_PARTY_NOTICES.md",
  "docread.md",
  "docs/receipt-ocr.md",
  "docs/ocr-data-lifecycle.md",
  "docs/ocr-licensing.md",
  "docs/data-pipeline-audit.md",
  "docs/offline/contract-inventory.md",
  "docs/architecture/resource-isolation.md",
  "docs/runbooks/resource-exhaustion.md"
];
const retiredReferences = [
  "services/receipt-ocr-service",
  "services/api/src/cp2/ocr-provider.ts",
  "OCR_WORKER_URL",
  "OCR_ENGINE_PRIMARY",
  "OCR_ENGINE_VERSION",
  "OCR_MODEL_VERSION",
  "OCR_LANGUAGE_HINTS",
  "OCR_PROFILE",
  "OCR_CONCURRENCY",
  "OCR_QUEUE_MAX",
  "OCR_MAX_RETRIES",
  "OCR_RETRY_INITIAL_DELAY_MS",
  "OCR_RETRY_MAX_DELAY_MS",
  "OCR_TEMP_IMAGE_TTL_HOURS",
  "OCR_FAILED_IMAGE_TTL_HOURS",
  "OCR_DELETE_AFTER_CONFIRM"
];
export async function checkCurrentOcrContracts({ read = readFile } = {}) {
  const violations = [];
  for (const path of activeDocuments) {
    const content = await read(path, "utf8");
    for (const reference of retiredReferences) {
      if (content.includes(reference))
        violations.push(`${path}: retired operational reference ${reference}`);
    }
  }
  for (const path of [
    "services/api/src/cp2/domains/suppliers/shared.ts",
    "services/api/src/cp2/domains/suppliers/store.ts"
  ]) {
    const content = await read(path, "utf8");
    for (const reference of [
      "readReceiptOCRConfig",
      "receiptOCRDefaultPrimaryEngine",
      "paddleocr-2.8.1"
    ]) {
      if (content.includes(reference)) violations.push(`${path}: retired OCR default ${reference}`);
    }
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = await checkCurrentOcrContracts();
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      `Current OCR contracts verified in ${activeDocuments.length} operational documents and 2 source modules. Historical metadata and offline extraction remain supported.`
    );
  }
}
