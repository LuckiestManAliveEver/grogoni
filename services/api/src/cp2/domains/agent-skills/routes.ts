import { Cp2Error } from "../../cp2-error.js";
import type { FastifyInstance } from "fastify";
import { readSessionCookie, type Cp2Store } from "../../store.js";
import { parseRequestBody, parseString, sendCp2Error } from "../../route-helpers.js";
import type { SkillInput } from "./store.js";

export function registerAgentSkillsRoutes(app: FastifyInstance, store: Cp2Store): void {
  // Reuse the application's authenticated domain facade and snapshot transaction boundary.
  app.get<{ Params: { businessId: string } }>(
    "/businesses/:businessId/skills",
    async (request, reply) => {
      try {
        return {
          skills: store.listAgentSkills({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId
          })
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.post<{ Params: { businessId: string }; Body: unknown }>(
    "/businesses/:businessId/skills",
    async (request, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return store.draftAgentSkill(
          {
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId
          },
          body as unknown as SkillInput
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.get<{ Params: { businessId: string; skillId: string } }>(
    "/businesses/:businessId/skills/:skillId",
    async (request, reply) => {
      try {
        return store.inspectAgentSkill(
          {
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId
          },
          request.params.skillId
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.put<{ Params: { businessId: string; skillId: string }; Body: unknown }>(
    "/businesses/:businessId/skills/:skillId",
    async (request, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return store.updateAgentSkill(
          {
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId
          },
          request.params.skillId,
          body as unknown as SkillInput
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.post<{ Params: { businessId: string }; Body: unknown }>(
    "/businesses/:businessId/skills/generate",
    async (request, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return await store.generateAgentSkill(
          {
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId
          },
          parseString(body.description, "description")
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.post<{ Params: { businessId: string; skillId: string }; Body: unknown }>(
    "/businesses/:businessId/skills/:skillId/lifecycle",
    async (request, reply) => {
      try {
        const body = parseRequestBody(request.body);
        const operation = parseString(body.operation, "operation");
        if (!["install", "enable", "disable", "uninstall", "revoke"].includes(operation))
          throw new Cp2Error(400, "skill_operation_invalid", "Unknown skill lifecycle operation.");
        return store.transitionAgentSkill(
          {
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId
          },
          request.params.skillId,
          operation as "install" | "enable" | "disable" | "uninstall" | "revoke",
          typeof body.digest === "string" ? body.digest : undefined
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.get<{ Params: { businessId: string; skillId: string } }>(
    "/businesses/:businessId/skills/:skillId/export",
    async (request, reply) => {
      try {
        return store.exportAgentSkill(
          {
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId
          },
          request.params.skillId
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.post<{ Params: { businessId: string; skillId: string }; Body: unknown }>(
    "/businesses/:businessId/skills/:skillId/resources",
    async (request, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return store.readAgentSkillResource(
          {
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId
          },
          {
            id: request.params.skillId,
            version: Number(body.version),
            digest: parseString(body.digest, "digest")
          },
          parseString(body.path, "path")
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.get<{ Querystring: { q?: string } }>("/v1/skills/marketplace", async (request, reply) => {
    try {
      return {
        skills: store.searchAgentSkills(
          { sessionId: readSessionCookie(request.headers.cookie) },
          request.query.q
        )
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });
  app.post<{ Params: { businessId: string; skillId: string }; Body: unknown }>(
    "/businesses/:businessId/skills/:skillId/publish",
    async (request, reply) => {
      try {
        return store.publishAgentSkill(
          {
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId
          },
          request.params.skillId,
          parseRequestBody(request.body) as unknown as Parameters<Cp2Store["publishAgentSkill"]>[2]
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.post<{ Params: { businessId: string; skillId: string }; Body: unknown }>(
    "/businesses/:businessId/skills/:skillId/install-public",
    async (request, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return store.installPublicAgentSkill(
          {
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: request.params.businessId
          },
          request.params.skillId,
          parseString(body.digest, "digest"),
          body.grants as string[]
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.get("/v1/skills", async (request, reply) => {
    try {
      return {
        skills: store.listAgentSkills({ sessionId: readSessionCookie(request.headers.cookie) })
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });
  app.post<{ Body: unknown }>("/v1/skills", async (request, reply) => {
    try {
      return store.draftAgentSkill(
        { sessionId: readSessionCookie(request.headers.cookie) },
        parseRequestBody(request.body) as unknown as SkillInput
      );
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });
  app.get<{ Params: { skillId: string } }>("/v1/skills/:skillId", async (request, reply) => {
    try {
      return store.inspectAgentSkill(
        { sessionId: readSessionCookie(request.headers.cookie) },
        request.params.skillId
      );
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });
  app.put<{ Params: { skillId: string }; Body: unknown }>(
    "/v1/skills/:skillId",
    async (request, reply) => {
      try {
        return store.updateAgentSkill(
          { sessionId: readSessionCookie(request.headers.cookie) },
          request.params.skillId,
          parseRequestBody(request.body) as unknown as SkillInput
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.post<{ Params: { skillId: string }; Body: unknown }>(
    "/v1/skills/:skillId/lifecycle",
    async (request, reply) => {
      try {
        const body = parseRequestBody(request.body);
        const operation = parseString(body.operation, "operation");
        if (!["install", "enable", "disable", "uninstall", "revoke"].includes(operation))
          throw new Cp2Error(400, "skill_operation_invalid", "Unknown skill lifecycle operation.");
        return store.transitionAgentSkill(
          { sessionId: readSessionCookie(request.headers.cookie) },
          request.params.skillId,
          operation as "install" | "enable" | "disable" | "uninstall" | "revoke",
          typeof body.digest === "string" ? body.digest : undefined
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.get<{ Params: { skillId: string } }>("/v1/skills/:skillId/export", async (request, reply) => {
    try {
      return store.exportAgentSkill(
        { sessionId: readSessionCookie(request.headers.cookie) },
        request.params.skillId
      );
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });
}
