import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const businessCoreRoot = "packages/business-core/src";
const forbiddenPatterns = [
  "@grogoni/ai-runtime",
  "services/ai-runtime",
  "llama",
  "openclaw",
  "grogoniclaw"
];

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listSourceFiles(path) : path;
    })
  );

  return files.flat().filter((path) => path.endsWith(".ts") || path.endsWith(".tsx"));
}

const violations = [];

for (const file of await listSourceFiles(businessCoreRoot)) {
  const contents = await readFile(file, "utf8");

  for (const pattern of forbiddenPatterns) {
    if (contents.toLowerCase().includes(pattern.toLowerCase())) {
      violations.push(`${file}: forbidden business-core dependency on ${pattern}`);
    }
  }
}

async function read(path) {
  return readFile(path, "utf8");
}

function countMatches(contents, pattern) {
  return [...contents.matchAll(pattern)].length;
}

const chatRuntimePath = "apps/web/src/hooks/useChatRuntimeState.ts";
const chatRuntime = await read(chatRuntimePath);
for (const forbidden of [
  "setProductForm",
  "setCustomerForm",
  "setInvoiceForm",
  "setInvoicePreview",
  "setPaymentForm",
  "requestNetworkRoute",
  "loadNetworkGraph",
  "isNetworkDiscoveryRequest"
]) {
  if (chatRuntime.includes(forbidden)) {
    violations.push(`${chatRuntimePath}: Chat must invoke capabilities instead of ${forbidden}`);
  }
}
if (/from\s+["'][^"']*(?:Product|Customer|Invoice|Payment|Supplier)[^"']*["']/u.test(chatRuntime)) {
  violations.push(`${chatRuntimePath}: Chat imports a domain UI implementation`);
}

for (const file of await listSourceFiles("apps/web/src/hooks")) {
  const contents = await read(file);
  if (/from\s+["']\.\/use[A-Z][^"']*["']/u.test(contents)) {
    violations.push(`${file}: domain hook imports a sibling hook's private implementation`);
  }
}

for (const file of await listSourceFiles("packages/tool-core/src")) {
  const contents = await read(file);
  if (/apps\/web|from\s+["']react(?:\/|["'])/u.test(contents)) {
    violations.push(`${file}: tool-core imports frontend code`);
  }
}

const apiFiles = await listSourceFiles("services/api/src");
for (const file of apiFiles.filter((candidate) => candidate.includes("/cp2/domains/"))) {
  const contents = await read(file);
  if (/from\s+["']\.\.\/((?!\.)[^/"']+)\/(store|shared)\.js["']/u.test(contents)) {
    violations.push(`${file}: new deep import of sibling domain private internals`);
  }
}

// Native bindings are the only production selection architecture. Fabric must not re-enter source.
// Mirrors scripts/check-retired-runtime-references.mjs's allowlist: the single production file
// sanctioned to name retired Execution Fabric terminology (see its own header comment), so this
// sweep must not flag it for doing exactly what it exists to do.
const allowlistedFabricFilePattern = /\/cp2\/retired-execution-fabric-tables\.(?:d\.ts|ts|js)$/u;
// The sanctioned filename itself contains the substring "execution-fabric" (e.g. import
// specifiers like "./cp2/retired-execution-fabric-tables.js"). Referencing the allowlisted file
// by name is not a reintroduction of the terminology, so strip that filename before testing.
const sanctionedFabricFileName = "retired-execution-fabric-tables";
for (const file of [...apiFiles, ...(await listSourceFiles("apps/web/src"))]) {
  if (allowlistedFabricFilePattern.test(file)) continue;
  const contents = await read(file);
  const scannableContents = contents.replaceAll(sanctionedFabricFileName, "");
  if (/execution[ -]fabric|execution-planner/iu.test(scannableContents)) {
    violations.push(`${file}: retired Execution Fabric terminology or dependency`);
  }
}

let runtimeTurnImplementations = 0;
for (const file of apiFiles) {
  const contents = await read(file);
  runtimeTurnImplementations += countMatches(contents, /async\s+createRuntimeTurn\s*\(/gu);
}
if (runtimeTurnImplementations !== 1) {
  violations.push(
    `services/api/src: expected one createRuntimeTurn implementation, found ${runtimeTurnImplementations}`
  );
}

const toolCoreFiles = await listSourceFiles("packages/tool-core/src");
let registryDeclarations = 0;
for (const file of toolCoreFiles) {
  registryDeclarations += countMatches(await read(file), /export const runtimeToolRegistry\b/gu);
}
if (registryDeclarations !== 1) {
  violations.push(
    `packages/tool-core/src: expected one runtimeToolRegistry, found ${registryDeclarations}`
  );
}

const mcpRoutes = await read("services/api/src/mcp/routes.ts");
if (!mcpRoutes.includes("store.createRuntimeTurnForMcp({")) {
  violations.push(
    "services/api/src/mcp/routes.ts: MCP must reuse the principal-aware runtime turn"
  );
}
if (
  /\.(?:createProduct|updateProduct|deleteProduct|createCustomer|recordPayment)\s*\(/u.test(
    mcpRoutes
  )
) {
  violations.push("services/api/src/mcp/routes.ts: MCP bypasses the canonical runtime turn");
}

const capabilityDispatcher = await read(
  "services/api/src/cp2/domains/agent-runtime/capabilities.ts"
);
if (capabilityDispatcher.includes("requireAuthorizedSession(")) {
  violations.push(
    "agent-runtime/capabilities.ts: capability dispatcher must not duplicate authorization"
  );
}
const capabilityCallers = apiFiles.filter(
  (file) => file !== "services/api/src/cp2/domains/agent-runtime/capabilities.ts"
);
for (const file of capabilityCallers) {
  const contents = await read(file);
  if (contents.includes("executeRuntimeCapability(") && !file.endsWith("agent-runtime/store.ts")) {
    violations.push(`${file}: business capability execution bypasses the canonical runtime turn`);
  }
}

// Corridor fulfillment boundaries (docs/architecture/corridor-fulfillment.md A20).
const webSourceFiles = await listSourceFiles("apps/web/src");
for (const file of webSourceFiles) {
  const contents = await read(file);
  if (
    /from\s+["'](?:pg|pg\/[^"']*)["']/u.test(contents) ||
    /from\s+["'][^"']*services\/api\//u.test(contents) ||
    /from\s+["'][^"']*business-core\/src\/domains\/fulfillment[^"']*["']/u.test(contents)
  ) {
    violations.push(`${file}: frontend imports database or fulfillment implementation internals`);
  }
  if (/\bBigInt\s*\(/u.test(contents)) {
    violations.push(
      `${file}: gram values must be converted only by @grogoni/shared-types grams helpers (A22)`
    );
  }
}

// Pure fulfillment rules: no I/O, framework, persistence, or event dependencies.
for (const file of (await listSourceFiles(businessCoreRoot)).filter((candidate) =>
  /\/domains\/fulfillment[^/]*\.ts$/u.test(candidate)
)) {
  const contents = await read(file);
  for (const match of contents.matchAll(/from\s+["']([^"']+)["']/gu)) {
    const specifier = match[1];
    if (specifier !== "@grogoni/shared-types" && specifier !== "@grogoni/tool-core") {
      violations.push(`${file}: pure fulfillment rules may not import ${specifier}`);
    }
  }
}

// Fulfillment SQL/transaction internals are private to the fulfillment domain; every other layer
// (other domains, MCP, messaging adapters, the capability dispatcher) goes through service.ts.
const fulfillmentDomainPrefix = "services/api/src/cp2/domains/fulfillment/";
for (const file of apiFiles.filter((candidate) => !candidate.startsWith(fulfillmentDomainPrefix))) {
  const contents = await read(file);
  if (/from\s+["'][^"']*\bfulfillment\/transaction(?:\.js)?["']/u.test(contents)) {
    violations.push(`${file}: imports fulfillment transaction internals instead of service.ts`);
  }
}
for (const file of apiFiles.filter((candidate) => candidate.startsWith(fulfillmentDomainPrefix))) {
  if (/\bBigInt\s*\(/u.test(await read(file))) {
    violations.push(
      `${file}: gram values must be converted only by @grogoni/shared-types grams helpers (A22)`
    );
  }
}

const lineBudgets = new Map([
  ["packages/tool-core/src/index.ts", 25],
  ["packages/tool-core/src/parsers.ts", 25],
  ["packages/tool-core/src/parsers/merchant-command.ts", 700],
  ["packages/tool-core/src/parsers/product-context.ts", 1150],
  ["packages/tool-core/src/parsers/receipt-context.ts", 350],
  ["packages/tool-core/src/parsers/runtime-proposals.ts", 275],
  ["packages/tool-core/src/registry/index.ts", 50],
  ["apps/web/src/GrogoniApplication.tsx", 2150],
  ["apps/web/src/OwnerWorkspace.tsx", 800],
  // Bumped for the offline human-chat SMS fallback: passing the selected human recipient's
  // smsFallbackRecipient into useChatComposerState is cohesive with the surrounding composer
  // wiring (see docs/messaging/cross-device-sms.md), not worth splitting out on its own.
  ["apps/web/src/ChatSurface.tsx", 1140],
  ["apps/web/src/ChatComposer.tsx", 375],
  ["apps/web/src/StackedModule.tsx", 180],
  // Bumped for the reviewed offline SMS fallback branch in sendLiveDraft (openSmsHandoff).
  // The send-route decision belongs beside the other provider branches, not a helper hook.
  ["apps/web/src/hooks/useChatComposerState.ts", 170],
  ["apps/web/src/hooks/useChatRuntimeState.ts", 1800],
  // Bumped for setAgentModelBillingMode (BYO Hugging Face credential billing mode) - cohesive with
  // the rest of the agent-model-binding activation logic already in this file, not worth splitting
  // out on its own.
  ["services/api/src/cp2/domains/agent-runtime/store.ts", 3800],
  ["services/api/src/cp2/domains/agent-runtime/domain-deps.ts", 325],
  ["services/api/src/cp2/domains/agent-runtime/runtime-context.ts", 300],
  ["services/api/src/cp2/domains/agent-runtime/runtime-model-routing.ts", 550],
  ["services/api/src/cp2/domains/agent-runtime/shared.ts", 1700],
  ["services/api/src/cp2/domains/agent-runtime/routes.ts", 1800],
  ["services/api/src/cp2/domains/agent-runtime/capabilities.ts", 550],
  ["services/api/src/cp2/domains/agent-runtime/commercial-records-capabilities.ts", 175]
]);
for (const [file, maximum] of lineBudgets) {
  const lines = (await read(file)).split("\n").length;
  if (lines > maximum)
    violations.push(`${file}: ${lines} lines exceeds modularity budget ${maximum}`);
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("Boundary check passed.");
