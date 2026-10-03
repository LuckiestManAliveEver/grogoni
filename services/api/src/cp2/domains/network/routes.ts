/**
 * Fourth domain slice of in-process modularization for services/api/src/cp2/routes.ts (see
 * docs/architecture/routes-modularization-roadmap.md). All routes are user-scoped (gate on
 * `requirePinVerifiedSession`, never take a `businessId`), matching the store-side NetworkDomain
 * extraction's own finding that this domain is user-scoped, not business-scoped.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SocialNetworkProvider } from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { maxConnectionsPerContact, maxDestinationsPerContact } from "./shared.js";
import { fetchGoogleContacts, googleContactsScope } from "../../google-contacts.js";
import {
  type Cp2Store,
  type PhoneContactNetworkInput,
  type SocialProfileNetworkInput,
  readSessionCookie
} from "../../store.js";
import {
  parseNullableString,
  parseOptionalString,
  parseRequestBody,
  parseString,
  sendCp2Error
} from "../../route-helpers.js";

interface NetworkConnectionBody {
  name?: string;
  phone?: string | null;
  email?: string | null;
  phones?: string[];
  emails?: string[];
  providerSubject?: string | null;
  handle?: string | null;
}

interface PhoneContactNetworkBody extends NetworkConnectionBody {
  connections?: NetworkConnectionBody[];
}

interface SocialProfileNetworkBody extends NetworkConnectionBody {
  relationship?: "followed" | "follower" | "interaction" | "message";
  connections?: NetworkConnectionBody[];
}

interface NetworkContactsSyncBody {
  contacts?: PhoneContactNetworkBody[];
  sourceName?: string;
  mode?: string;
  defaultCountry?: string;
}

interface NetworkConnectionRequestBody {
  nodeId?: string;
}

interface NetworkConnectionParams {
  connectionId: string;
}

interface NetworkConnectionResponseBody {
  accept?: boolean;
}

interface NetworkSocialSyncBody {
  profiles?: SocialProfileNetworkBody[];
  sourceName?: string;
}

interface NetworkRouteBody {
  requestText?: string;
  targetNodeId?: string | null;
}

interface NetworkRouteParams {
  routeId: string;
}

interface NetworkSourceParams {
  sourceId: string;
}

interface NetworkSocialParams {
  provider: string;
}

interface NetworkProviderSyncParams {
  provider: string;
}

interface NetworkResolveQuery {
  query?: string;
}

interface IdentityCandidateParams {
  candidateId: string;
}

interface IdentityCandidateConfirmBody {
  targetNodeId?: string | null;
  createNewContact?: boolean;
}

interface NetworkNodeIdentityParams {
  nodeId: string;
}

interface NetworkIdentityUnlinkParams extends NetworkNodeIdentityParams {
  externalIdentityId: string;
}

interface NetworkIdentityAddBody {
  provider?: string;
  providerSubject?: string;
  displayName?: string;
  handle?: string | null;
}

export function registerNetworkRoutes(app: FastifyInstance, store: Cp2Store): void {
  app.post(
    "/network/sync/contacts",
    async (request: FastifyRequest<{ Body: NetworkContactsSyncBody }>, reply) => {
      try {
        const sourceName = parseOptionalString(request.body.sourceName);
        const mode = request.body.mode;
        if (mode !== undefined && mode !== "replace" && mode !== "merge") {
          throw new Cp2Error(
            400,
            "network_sync_mode_invalid",
            'mode must be "replace" or "merge".'
          );
        }
        const defaultCountry = parseOptionalString(request.body.defaultCountry);
        return store.syncPhoneContacts({
          sessionId: readSessionCookie(request.headers.cookie),
          contacts: parsePhoneContactNetworkBodies(request.body.contacts),
          ...(sourceName === undefined ? {} : { sourceName }),
          ...(mode === undefined ? {} : { mode }),
          ...(defaultCountry === undefined ? {} : { defaultCountry })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/network/sync/social/:provider",
    async (
      request: FastifyRequest<{ Params: NetworkSocialParams; Body: NetworkSocialSyncBody }>,
      reply
    ) => {
      try {
        const sourceName = parseOptionalString(request.body.sourceName);
        return store.syncSocialNetwork({
          sessionId: readSessionCookie(request.headers.cookie),
          provider: parseNetworkSocialProvider(request.params.provider),
          profiles: parseSocialProfileNetworkBodies(request.body.profiles),
          ...(sourceName === undefined ? {} : { sourceName })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/network/providers/:provider/sync",
    async (request: FastifyRequest<{ Params: NetworkProviderSyncParams }>, reply) => {
      try {
        const sessionId = readSessionCookie(request.headers.cookie);
        const provider = parseNetworkSocialProvider(request.params.provider);
        if (provider === "google") {
          const credential = store.getConnectedProviderAccess({
            sessionId,
            provider: "google",
            requiredScope: googleContactsScope
          });
          const profiles = await fetchGoogleContacts({ accessToken: credential.accessToken });
          return store.syncSocialNetwork({
            sessionId,
            provider,
            profiles,
            sourceName: "Google Contacts",
            provenance: "verified"
          });
        }
        return store.syncConnectedSocialProvider({ sessionId, provider });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get("/network", async (request, reply) => {
    try {
      return store.getNetworkGraph({
        sessionId: readSessionCookie(request.headers.cookie)
      });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.get("/network/direct", async (request, reply) => {
    try {
      return {
        nodes: store.getDirectNetwork({
          sessionId: readSessionCookie(request.headers.cookie)
        })
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.get("/network/extended", async (request, reply) => {
    try {
      return {
        nodes: store.getExtendedNetwork({
          sessionId: readSessionCookie(request.headers.cookie)
        })
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post(
    "/network/routes",
    async (request: FastifyRequest<{ Body: NetworkRouteBody }>, reply) => {
      try {
        return store.createAgentRoute({
          sessionId: readSessionCookie(request.headers.cookie),
          requestText: parseString(request.body.requestText, "requestText"),
          targetNodeId: parseNullableString(request.body.targetNodeId)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/network/routes/:routeId",
    async (request: FastifyRequest<{ Params: NetworkRouteParams }>, reply) => {
      try {
        return store.getAgentRoute({
          sessionId: readSessionCookie(request.headers.cookie),
          routeId: parseString(request.params.routeId, "routeId")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/network/routes/:routeId/approve",
    async (request: FastifyRequest<{ Params: NetworkRouteParams }>, reply) => {
      try {
        return store.approveAgentRoute({
          sessionId: readSessionCookie(request.headers.cookie),
          routeId: parseString(request.params.routeId, "routeId")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/network/routes/:routeId/reject",
    async (request: FastifyRequest<{ Params: NetworkRouteParams }>, reply) => {
      try {
        return store.rejectAgentRoute({
          sessionId: readSessionCookie(request.headers.cookie),
          routeId: parseString(request.params.routeId, "routeId")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.delete(
    "/network/sources/:sourceId",
    async (request: FastifyRequest<{ Params: NetworkSourceParams }>, reply) => {
      try {
        return store.deleteNetworkSource({
          sessionId: readSessionCookie(request.headers.cookie),
          sourceId: parseString(request.params.sourceId, "sourceId")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get("/network/connections", async (request, reply) => {
    try {
      return {
        connections: store.listNetworkConnections({
          sessionId: readSessionCookie(request.headers.cookie)
        })
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post(
    "/network/connections",
    async (request: FastifyRequest<{ Body: NetworkConnectionRequestBody }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return store.requestNetworkConnection({
          sessionId: readSessionCookie(request.headers.cookie),
          nodeId: parseString(body.nodeId, "nodeId")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/network/connections/:connectionId/respond",
    async (
      request: FastifyRequest<{
        Params: NetworkConnectionParams;
        Body: NetworkConnectionResponseBody;
      }>,
      reply
    ) => {
      try {
        const body = parseRequestBody(request.body);
        if (typeof body.accept !== "boolean") {
          throw new Cp2Error(
            400,
            "network_connection_accept_required",
            "accept must be a boolean."
          );
        }
        const connection = store.respondToNetworkConnection({
          sessionId: readSessionCookie(request.headers.cookie),
          connectionId: parseString(request.params.connectionId, "connectionId"),
          accept: body.accept
        });
        return { connection };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.delete(
    "/network/connections/:connectionId",
    async (request: FastifyRequest<{ Params: NetworkConnectionParams }>, reply) => {
      try {
        store.removeNetworkConnection({
          sessionId: readSessionCookie(request.headers.cookie),
          connectionId: parseString(request.params.connectionId, "connectionId")
        });
        return { removed: true };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/network/contacts/resolve",
    async (request: FastifyRequest<{ Querystring: NetworkResolveQuery }>, reply) => {
      try {
        return store.resolveContact({
          sessionId: readSessionCookie(request.headers.cookie),
          query: parseString(request.query.query, "query")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get("/network/identity-candidates", async (request, reply) => {
    try {
      return {
        candidates: store.listIdentityCandidates({
          sessionId: readSessionCookie(request.headers.cookie)
        })
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post(
    "/network/identity-candidates/:candidateId/confirm",
    async (
      request: FastifyRequest<{
        Params: IdentityCandidateParams;
        Body: IdentityCandidateConfirmBody;
      }>,
      reply
    ) => {
      try {
        return store.confirmIdentityCandidate({
          sessionId: readSessionCookie(request.headers.cookie),
          candidateId: parseString(request.params.candidateId, "candidateId"),
          targetNodeId: parseNullableString(request.body?.targetNodeId),
          createNewContact: request.body?.createNewContact === true
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/network/identity-candidates/:candidateId/reject",
    async (request: FastifyRequest<{ Params: IdentityCandidateParams }>, reply) => {
      try {
        store.rejectIdentityCandidate({
          sessionId: readSessionCookie(request.headers.cookie),
          candidateId: parseString(request.params.candidateId, "candidateId")
        });
        return { rejected: true };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/network/nodes/:nodeId/identities",
    async (
      request: FastifyRequest<{ Params: NetworkNodeIdentityParams; Body: NetworkIdentityAddBody }>,
      reply
    ) => {
      try {
        const body = parseRequestBody(request.body);
        return store.addManualIdentity({
          sessionId: readSessionCookie(request.headers.cookie),
          nodeId: parseString(request.params.nodeId, "nodeId"),
          provider: parseString(body.provider, "provider"),
          providerSubject: parseString(body.providerSubject, "providerSubject"),
          ...(parseOptionalString(body.displayName) === undefined
            ? {}
            : { displayName: parseOptionalString(body.displayName) as string }),
          handle: parseNullableString(body.handle)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.delete(
    "/network/nodes/:nodeId/identities/:externalIdentityId",
    async (request: FastifyRequest<{ Params: NetworkIdentityUnlinkParams }>, reply) => {
      try {
        return store.unlinkIdentity({
          sessionId: readSessionCookie(request.headers.cookie),
          nodeId: parseString(request.params.nodeId, "nodeId"),
          externalIdentityId: parseString(request.params.externalIdentityId, "externalIdentityId")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}

function parsePhoneContactNetworkBodies(
  value: PhoneContactNetworkBody[] | undefined
): PhoneContactNetworkInput[] {
  if (!Array.isArray(value)) {
    throw new Cp2Error(400, "contacts_required", "contacts is required.");
  }

  return value.map((contact, index) => parseNetworkConnectionBody(contact, `contacts.${index}`));
}

function parseSocialProfileNetworkBodies(
  value: SocialProfileNetworkBody[] | undefined
): SocialProfileNetworkInput[] {
  if (!Array.isArray(value)) {
    throw new Cp2Error(400, "profiles_required", "profiles is required.");
  }

  return value.map((profile, index) => {
    const parsed = parseNetworkConnectionBody(profile, `profiles.${index}`);
    const relationship = profile.relationship;

    if (
      relationship !== undefined &&
      relationship !== "followed" &&
      relationship !== "follower" &&
      relationship !== "interaction" &&
      relationship !== "message"
    ) {
      throw new Cp2Error(
        400,
        "network_relationship_invalid",
        "Social network relationship is not supported."
      );
    }

    return relationship === undefined
      ? parsed
      : {
          ...parsed,
          relationship
        };
  });
}

function parseNetworkConnectionBody(
  value: NetworkConnectionBody,
  name: string
): PhoneContactNetworkInput {
  const record = parseRequestBody(value);
  const parsed: PhoneContactNetworkInput = {
    name: parseString(record.name, `${name}.name`),
    phone: parseNullableString(record.phone),
    email: parseNullableString(record.email),
    providerSubject: parseNullableString(record.providerSubject),
    handle: parseNullableString(record.handle)
  };

  for (const field of ["phones", "emails"] as const) {
    if (record[field] !== undefined)
      parsed[field] = parseDestinationList(record[field], `${name}.${field}`);
  }

  if (record.connections !== undefined) {
    parsed.connections = parseNestedNetworkConnectionBodies(
      record.connections,
      `${name}.connections`
    );
  }

  return parsed;
}

function parseDestinationList(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maxDestinationsPerContact ||
    !value.every((item) => typeof item === "string" && item.length <= 254)
  ) {
    throw new Cp2Error(
      400,
      "network_destinations_invalid",
      `${name} must be at most ${maxDestinationsPerContact} strings.`
    );
  }
  return value as string[];
}

function parseNestedNetworkConnectionBodies(
  value: unknown,
  name: string
): PhoneContactNetworkInput[] {
  if (!Array.isArray(value)) {
    throw new Cp2Error(400, "network_connections_invalid", `${name} must be an array.`);
  }
  if (value.length > maxConnectionsPerContact) {
    throw new Cp2Error(
      400,
      "network_connections_invalid",
      `${name} must have at most ${maxConnectionsPerContact} entries.`
    );
  }

  return value.map((connection, index) =>
    parseNetworkConnectionBody(connection as NetworkConnectionBody, `${name}.${index}`)
  );
}

function parseNetworkSocialProvider(value: string): SocialNetworkProvider {
  if (
    value === "facebook" ||
    value === "instagram" ||
    value === "whatsapp" ||
    value === "tiktok" ||
    value === "x" ||
    value === "linkedin" ||
    value === "google" ||
    value === "microsoft" ||
    value === "github" ||
    value === "apple"
  ) {
    return value;
  }

  throw new Cp2Error(400, "network_provider_invalid", "Social network provider is not supported.");
}
