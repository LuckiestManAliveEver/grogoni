/**
 * Runtime-asset search + import routes, mounted from services/api/src/cp2/routes.ts. Local-first
 * mode accepts only the Grogoni catalogue provider; GitHub and Hugging Face are rejected with
 * runtime_registry_provider_invalid (see docs/local-first-cloud-audit.md).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  RuntimeAssetKind,
  RuntimeRegistryContext,
  RuntimeRegistryProviderId,
  RuntimeRegistryResourceRef
} from "@grogoni/shared-types";
import { Cp2Error } from "../cp2-error.js";
import { readSessionCookie } from "../store.js";
import { parseString, sendCp2Error } from "../route-helpers.js";
import {
  RuntimeRegistryAccessRequiredError,
  RuntimeRegistryResourceNotFoundError,
  type RuntimeRegistryAdapter
} from "./types.js";
import type { RuntimeRegistrySearchService } from "./search.js";
import type { createRuntimeRegistryImportService } from "./import-service.js";

const providerIds: readonly RuntimeRegistryProviderId[] = ["grogoni"];
const assetKinds: readonly RuntimeAssetKind[] = ["agent", "model"];

export interface RuntimeRegistryRouteDeps {
  searchService: RuntimeRegistrySearchService;
  adapters: Partial<Record<RuntimeRegistryProviderId, RuntimeRegistryAdapter>>;
  importService: ReturnType<typeof createRuntimeRegistryImportService>;
  /** Maps a session cookie to the per-request search context (accountId + whether the caller has a
   *  connected, non-expired provider connection) - never a raw token, per RuntimeRegistryContext's
   *  own contract. An unauthenticated caller still gets a valid (public) context back: search is
   *  open to anonymous callers, same as the existing /v1/ai-models routes. */
  resolveContext: (sessionId: string | null) => RuntimeRegistryContext;
  /** Throws a Cp2Error(401, ...) when the caller isn't authenticated - only the import endpoints
   *  require this, search/inspect do not. */
  requireAccount: (sessionId: string | null) => { accountId: string; userId: string };
}

interface SearchQuery {
  q?: string;
  kind?: string;
  providers?: string;
  cursor?: string;
  limit?: string;
}

interface ResourceParams {
  provider: string;
  id: string;
}

interface ResourceQuery {
  kind?: string;
  revision?: string;
}

interface ImportBody {
  provider?: unknown;
  kind?: unknown;
  externalId?: unknown;
  revision?: unknown;
}

interface ImportParams {
  importId: string;
}

export function registerRuntimeRegistryRoutes(
  app: FastifyInstance,
  deps: RuntimeRegistryRouteDeps
): void {
  app.get(
    "/v1/runtime-registry/search",
    async (request: FastifyRequest<{ Querystring: SearchQuery }>, reply) => {
      try {
        const context = deps.resolveContext(readSessionCookie(request.headers.cookie));
        const kinds = parseKinds(request.query.kind);
        const providers = parseProviders(request.query.providers);
        const limit = parseOptionalNumber(request.query.limit);
        return await deps.searchService.search(
          {
            query: request.query.q ?? "",
            ...(kinds === undefined ? {} : { kinds }),
            ...(providers === undefined ? {} : { providers }),
            ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
            ...(limit === undefined ? {} : { limit })
          },
          context
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/v1/runtime-registry/resources/:provider/:id",
    async (
      request: FastifyRequest<{ Params: ResourceParams; Querystring: ResourceQuery }>,
      reply
    ) => {
      try {
        const providerId = parseProviderId(request.params.provider);
        const adapter = deps.adapters[providerId];
        if (adapter === undefined) {
          throw new Cp2Error(
            404,
            "runtime_registry_provider_not_found",
            `Unknown runtime registry provider "${request.params.provider}".`
          );
        }
        const kind = parseKind(request.query.kind);
        const context = deps.resolveContext(readSessionCookie(request.headers.cookie));
        const ref: RuntimeRegistryResourceRef = {
          provider: providerId,
          kind,
          externalId: decodeURIComponent(request.params.id),
          ...(request.query.revision === undefined ? {} : { revision: request.query.revision })
        };
        return await adapter.inspect(ref, context);
      } catch (error) {
        if (error instanceof RuntimeRegistryResourceNotFoundError) {
          return sendCp2Error(
            reply,
            new Cp2Error(404, "runtime_registry_resource_not_found", error.message)
          );
        }
        if (error instanceof RuntimeRegistryAccessRequiredError) {
          return sendCp2Error(
            reply,
            new Cp2Error(403, "runtime_registry_access_required", error.message)
          );
        }
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/v1/runtime-registry/imports",
    async (request: FastifyRequest<{ Body: ImportBody }>, reply) => {
      try {
        const { accountId, userId } = deps.requireAccount(
          readSessionCookie(request.headers.cookie)
        );
        const provider = parseProviderId(request.body.provider);
        const kind = parseKind(request.body.kind);
        const externalId = parseString(request.body.externalId, "externalId");
        const revision =
          typeof request.body.revision === "string" ? request.body.revision : undefined;
        return await deps.importService.startImport({
          accountId,
          userId,
          ref: { provider, kind, externalId, ...(revision === undefined ? {} : { revision }) }
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get("/v1/runtime-registry/imports", async (request, reply) => {
    try {
      const { accountId } = deps.requireAccount(readSessionCookie(request.headers.cookie));
      return { imports: await deps.importService.listImports(accountId) };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.get(
    "/v1/runtime-registry/imports/:importId",
    async (request: FastifyRequest<{ Params: ImportParams }>, reply) => {
      try {
        const { accountId } = deps.requireAccount(readSessionCookie(request.headers.cookie));
        const importRecord = await deps.importService.getImport(request.params.importId, accountId);
        if (importRecord === null) {
          throw new Cp2Error(
            404,
            "runtime_registry_import_not_found",
            "The requested import was not found."
          );
        }
        return importRecord;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}

function parseKinds(value: string | undefined): RuntimeAssetKind[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const kinds = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is RuntimeAssetKind =>
      (assetKinds as readonly string[]).includes(entry)
    );
  return kinds.length === 0 ? undefined : kinds;
}

function parseProviders(value: string | undefined): RuntimeRegistryProviderId[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const providers = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is RuntimeRegistryProviderId =>
      (providerIds as readonly string[]).includes(entry)
    );
  return providers.length === 0 ? undefined : providers;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseProviderId(value: unknown): RuntimeRegistryProviderId {
  if (typeof value === "string" && (providerIds as readonly string[]).includes(value)) {
    return value as RuntimeRegistryProviderId;
  }
  throw new Cp2Error(400, "runtime_registry_provider_invalid", "provider must be grogoni.");
}

function parseKind(value: unknown): RuntimeAssetKind {
  if (typeof value === "string" && (assetKinds as readonly string[]).includes(value)) {
    return value as RuntimeAssetKind;
  }
  throw new Cp2Error(400, "runtime_registry_kind_invalid", "kind must be one of agent, model.");
}
