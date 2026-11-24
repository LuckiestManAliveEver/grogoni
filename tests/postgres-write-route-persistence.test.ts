import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A write route's store method must be on postgres-store.ts's mutatingMethodNames, or on a Node
// deployment backed by PostgreSQL the change answers 200 and is never saved (the save queue only
// runs for listed methods). setBroadcastPreference and setShopDirectoryListing shipped that way
// before this check. Supabase Edge saves every request's changes regardless, so production was
// not affected.
//
// The methods below were already missing when the check was added (2026-11-24). Many are reads
// behind a POST (checkRole, getSession) or save through their own tables; each still needs a
// look. Classify one (list it in mutatingMethodNames, or record why it needs no save) and remove
// it here: the check fails both on a new omission and on a stale entry, so this list only shrinks.
const unclassifiedWhenAdded = new Set([
  "getConversation",
  "assertDocumentImportWriteAccess",
  "beginAccountModelArtifact",
  "beginConnectedMailboxOAuth",
  "beginPasskeyAuthentication",
  "beginPasskeyRegistration",
  "cancelProductCaptureJob",
  "cancelReceiptOCRJob",
  "cancelRuntimeExecution",
  "changeAccountPin",
  "checkRole",
  "clearComputerProfile",
  "closeComputerSession",
  "completeAccountModelArtifact",
  "completeDeviceInferenceJob",
  "confirmProductCaptureItem",
  "confirmProductCaptureJob",
  "connectExternalConnection",
  "correctReceiptOCRJob",
  "createComputerProfile",
  "createComputerSession",
  "createConnectedEmailConversation",
  "createProductCaptureJob",
  "createPublicStorefrontSession",
  "decideComputerApproval",
  "disconnectConnectedMailbox",
  "disconnectExternalConnection",
  "duplicateCatalogueProducts",
  "ensureHelpConversations",
  "failDeviceInferenceJob",
  "getAuthTransaction",
  "getConnectedProviderAccess",
  "getPendingEmailIdentity",
  "getRecoveryNotificationRecipient",
  "getSession",
  "hasCredentialRecoveryGrant",
  "identifyAccount",
  "installAccountOssAgentManifest",
  "isCurrentGuestPhone",
  "listExternalConnections",
  "matchCommerceProducts",
  "performComputerAction",
  "previewInvoice",
  "pushOfflineOrderIntents",
  "putAccountModelArtifactChunk",
  "readAgentSkillResource",
  "recordMessageHandoff",
  "recordUnknownVocabularyTerm",
  "rejectProductCaptureItem",
  "releaseComputerControl",
  "removePlatformInferenceProvider",
  "renameGrogoniId",
  "retryProductCaptureJob",
  "reviewProductCaptureJob",
  "reviewVocabularyEntry",
  "syncConnectedMailbox",
  "takeComputerControl",
  "testAgentModel",
  "updateBusinessShareLinks",
  "updateConnectedMailbox",
  "updateOwnDisplayName",
  "upsertPlatformInferenceProvider"
]);

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === "routes.ts" || name.endsWith("-routes.ts") ? [path] : [];
  });
}

function writeRouteStoreMethods(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of routeFiles("services/api/src/cp2")) {
    const source = readFileSync(file, "utf8");
    const parts = source.split(/\bapp\.(get|post|put|patch|delete|route)\s*(?:<[^>]*>)?\s*\(/u);
    for (let index = 1; index < parts.length; index += 2) {
      const method = parts[index]!;
      const body = parts[index + 1]!;
      if (method === "get") continue;
      if (
        method === "route" &&
        !/method:\s*(\[[^\]]*\b(POST|PUT|PATCH|DELETE)|"(POST|PUT|PATCH|DELETE)"|method)/u.test(
          body.slice(0, 300)
        )
      )
        continue;
      const path = /"([^"]+)"/u.exec(body.slice(0, 200))?.[1] ?? "?";
      for (const call of body.matchAll(/\bstore\.([a-zA-Z]+)\(/gu))
        if (!found.has(call[1]!)) found.set(call[1]!, `${method.toUpperCase()} ${path}`);
    }
  }
  return found;
}

describe("write routes reach the PostgreSQL save queue", () => {
  const source = readFileSync("services/api/src/cp2/postgres-store.ts", "utf8");
  const listed = new Set(
    [
      ...source
        .slice(
          source.indexOf("const mutatingMethodNames"),
          source.indexOf("const targetedPasskeyCeremonyMethodNames")
        )
        .matchAll(/"([A-Za-z]+)"/gu)
    ].map((match) => match[1]!)
  );
  const methods = writeRouteStoreMethods();

  it("lists every store method a POST, PUT, PATCH or DELETE route calls", () => {
    const missing = [...methods]
      .filter(([name]) => !listed.has(name) && !unclassifiedWhenAdded.has(name))
      .map(([name, route]) => `${name} (${route})`);
    expect(missing).toEqual([]);
  });

  it("keeps the unclassified list current: drop an entry once it is listed or gone", () => {
    const stale = [...unclassifiedWhenAdded].filter(
      (name) => listed.has(name) || !methods.has(name)
    );
    expect(stale).toEqual([]);
  });

  it("saves the shop directory and status broadcast writes", () => {
    for (const name of [
      "setShopDirectoryListing",
      "setBroadcastPreference",
      "createStatusBroadcast",
      "recordStatusBroadcastView",
      "recordStatusBroadcastReply"
    ])
      expect(listed.has(name), name).toBe(true);
  });
});
