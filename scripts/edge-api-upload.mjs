// The exact set of files POSTed to the Supabase management API for the `api`
// Edge function, and the size budget that upload must stay under.
//
// Supabase rejects uploads over its "maximum deployment size (5 MB)" with HTTP
// 413. On 2026-11-17 a 4,791,393-byte upload was rejected three times in a row
// after byte-identical sources had been accepted 13 minutes earlier, so the
// enforced threshold is not a stable 5,000,000 bytes of uploaded source. The
// budget keeps a 20% margin below the nominal limit and fails the build, not
// the production deploy, when a change pushes the upload over it.
//
// npm: dependencies (pg, fastify, mammoth, pdfjs-dist, ...) are resolved by
// Supabase on its side and are not part of this upload.
import { stat } from "node:fs/promises";
import { join } from "node:path";

export const edgeUploadBudgetBytes = 4_000_000;

export const edgeApiUploadFiles = Object.freeze([
  "index.ts",
  "database-connection.ts",
  "handler.ts",
  "session-routes.ts",
  "auth-routes.ts",
  "application-routes.ts",
  "public-routes.ts",
  "rate-limit.ts",
  "job-transaction.ts",
  "store-coordination.ts",
  "domain-bundle.mjs",
  "credentials.ts"
]);

export function checkEdgeUploadBudget(sizes, budget = edgeUploadBudgetBytes) {
  const totalBytes = Object.values(sizes).reduce((sum, size) => sum + size, 0);
  const largest = Object.entries(sizes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([file, size]) => `${file} ${size}`)
    .join(", ");
  return {
    ok: totalBytes <= budget,
    totalBytes,
    budget,
    message: `Edge upload is ${totalBytes} bytes against a ${budget}-byte budget (largest: ${largest}).`
  };
}

export async function measureEdgeUpload(functionDir, files = edgeApiUploadFiles) {
  const sizes = {};
  for (const file of files) sizes[file] = (await stat(join(functionDir, file))).size;
  return sizes;
}
