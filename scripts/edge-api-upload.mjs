// Exact deployment sources, including the locally minified PDF worker.
// Use the local Supabase CLI bundler if the server-side upload endpoint rejects
// a source upload under the nominal 5 MB limit.
// npm: dependencies (pg, fastify, mammoth, pdfjs-dist, ...) are resolved by
// Supabase on its side and are not part of this upload.
import { stat } from "node:fs/promises";
import { join } from "node:path";

export const edgeUploadBudgetBytes = 5_000_000;

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
  "pdf-worker.mjs",
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
