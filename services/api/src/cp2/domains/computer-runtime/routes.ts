import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  ComputerAction,
  ComputerActionKind,
  ExternalSurfaceDescriptor,
  ExternalSurfaceType
} from "@grogoni/shared-types";
import { Cp2Error, readSessionCookie, type Cp2Store } from "../../store.js";
import {
  parseNullableString,
  parseRequestBody,
  parseString,
  sendCp2Error
} from "../../route-helpers.js";

interface SessionParams {
  sessionId: string;
}
interface ProfileParams {
  profileId: string;
}
interface ApprovalParams {
  approvalId: string;
}

function action(body: unknown, sessionId: string): ComputerAction {
  const value = parseRequestBody(body);
  const target = parseRequestBody(value.target ?? {});
  const kind = parseString(value.kind, "kind") as ComputerActionKind;
  if (!["navigate", "observe", "click", "type", "scroll", "upload"].includes(kind))
    throw new Cp2Error(400, "computer_action_invalid", "Computer action is not supported.");
  return {
    id: typeof value.id === "string" ? value.id : randomUUID(),
    sessionId,
    kind,
    target: {
      ...(typeof target.url === "string" ? { url: target.url } : {}),
      ...(typeof target.selector === "string" ? { selector: target.selector } : {}),
      ...(typeof target.text === "string" ? { text: target.text } : {}),
      ...(typeof target.description === "string" ? { description: target.description } : {}),
      ...(typeof target.x === "number" && typeof target.y === "number"
        ? { coordinates: { x: target.x, y: target.y } }
        : {})
    },
    ...(typeof value.value === "string" ? { value: value.value } : {}),
    ...(typeof value.semanticIntent === "string" ? { semanticIntent: value.semanticIntent } : {}),
    risk: "READ"
  };
}

function externalSurface(body: Record<string, unknown>): ExternalSurfaceDescriptor {
  const value = parseRequestBody(body.externalSurface ?? {});
  const type = String(value.type ?? "web");
  if (!["web", "pwa", "desktop", "mobile-web"].includes(type)) {
    throw new Cp2Error(400, "external_surface_type_invalid", "External surface type is invalid.");
  }
  return {
    id: parseString(value.id ?? "generic-web", "externalSurface.id"),
    type: type as ExternalSurfaceType,
    ...(typeof value.provider === "string" ? { provider: value.provider } : {})
  };
}

export function registerComputerRuntimeRoutes(app: FastifyInstance, store: Cp2Store): void {
  app.get("/v1/computer/profiles", async (request, reply) => {
    try {
      return {
        profiles: store.listComputerProfiles(
          readSessionCookie(request.headers.cookie),
          parseNullableString((request.query as { businessId?: unknown }).businessId ?? null)
        )
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });
  app.post("/v1/computer/profiles", async (request, reply) => {
    try {
      const body = parseRequestBody(request.body);
      return reply.code(201).send(
        store.createComputerProfile(readSessionCookie(request.headers.cookie), {
          businessId: parseNullableString(body.businessId ?? null),
          label: parseString(body.label, "label")
        })
      );
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });
  app.delete(
    "/v1/computer/profiles/:profileId",
    async (request: FastifyRequest<{ Params: ProfileParams }>, reply) => {
      try {
        await store.clearComputerProfile(
          readSessionCookie(request.headers.cookie),
          request.params.profileId
        );
        return { cleared: true };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.post("/v1/computer/sessions", async (request, reply) => {
    try {
      const body = parseRequestBody(request.body);
      return reply.code(201).send(
        await store.createComputerSession(readSessionCookie(request.headers.cookie), {
          businessId: parseNullableString(body.businessId ?? null),
          conversationId: parseNullableString(body.conversationId ?? null),
          taskId: parseNullableString(body.taskId ?? null),
          profileId: parseNullableString(body.profileId ?? null),
          externalSurface: externalSurface(body),
          runtimeInstanceId: parseNullableString(body.runtimeInstanceId ?? null),
          ...(typeof body.policy === "object" && body.policy !== null
            ? { policy: body.policy }
            : {})
        })
      );
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });
  app.get(
    "/v1/computer/sessions/:sessionId",
    async (request: FastifyRequest<{ Params: SessionParams }>, reply) => {
      try {
        return store.getComputerSession(
          readSessionCookie(request.headers.cookie),
          request.params.sessionId
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.get(
    "/v1/computer/sessions/:sessionId/approval",
    async (request: FastifyRequest<{ Params: SessionParams }>, reply) => {
      try {
        return {
          approval: store.getPendingComputerApproval(
            readSessionCookie(request.headers.cookie),
            request.params.sessionId
          )
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.post(
    "/v1/computer/sessions/:sessionId/actions",
    async (request: FastifyRequest<{ Params: SessionParams }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return await store.performComputerAction(
          readSessionCookie(request.headers.cookie),
          action(body, request.params.sessionId),
          body.actor === "human" ? "human" : "agent",
          typeof body.approvalId === "string" ? body.approvalId : undefined
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.post(
    "/v1/computer/approvals/:approvalId",
    async (request: FastifyRequest<{ Params: ApprovalParams }>, reply) => {
      try {
        const body = parseRequestBody(request.body);
        return store.decideComputerApproval(
          readSessionCookie(request.headers.cookie),
          request.params.approvalId,
          body.decision === "approve"
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.post(
    "/v1/computer/sessions/:sessionId/control/take",
    async (request: FastifyRequest<{ Params: SessionParams }>, reply) => {
      try {
        return await store.takeComputerControl(
          readSessionCookie(request.headers.cookie),
          request.params.sessionId
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.post(
    "/v1/computer/sessions/:sessionId/control/release",
    async (request: FastifyRequest<{ Params: SessionParams }>, reply) => {
      try {
        return await store.releaseComputerControl(
          readSessionCookie(request.headers.cookie),
          request.params.sessionId
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.get(
    "/v1/computer/sessions/:sessionId/frame",
    async (request: FastifyRequest<{ Params: SessionParams }>, reply) => {
      try {
        const frame = await store.computerFrame(
          readSessionCookie(request.headers.cookie),
          request.params.sessionId
        );
        return reply
          .header("cache-control", "no-store")
          .type(frame.contentType)
          .send(Buffer.from(frame.bytes));
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
  app.delete(
    "/v1/computer/sessions/:sessionId",
    async (request: FastifyRequest<{ Params: SessionParams }>, reply) => {
      try {
        await store.closeComputerSession(
          readSessionCookie(request.headers.cookie),
          request.params.sessionId
        );
        return { closed: true };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}
