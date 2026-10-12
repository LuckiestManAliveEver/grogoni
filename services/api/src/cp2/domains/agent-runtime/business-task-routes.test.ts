import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  createBusinessEnvironmentRegistry,
  type BusinessEnvironmentManifest
} from "@grogoni/tool-core";
import { Cp2Error } from "../../cp2-error.js";
import type { Cp2Store } from "../../store.js";
import { registerBusinessTaskRoutes, type BusinessTaskStore } from "./business-task-routes.js";

const manifest: BusinessEnvironmentManifest = {
  id: "grogoni.retail.inventory",
  version: "1.0.0",
  name: "Inventory",
  description: "Test fixture",
  domain: "retail",
  capabilities: ["products.list"],
  observationSchema: { type: "object" },
  verificationPolicyId: "inventory.verify.v1",
  evaluationPolicyId: "inventory.evaluate.v1",
  executionMode: "READ_ONLY",
  status: "ACTIVE"
};
function setup(available = true, conversationBusiness = "business-1") {
  const app = Fastify();
  const authorize = vi.fn(({ sessionId }: { sessionId: string | null }) => {
    if (sessionId !== "valid") throw new Cp2Error(401, "unauthorized", "Sign in.");
    return { userId: "actor-1", role: "owner" };
  });
  const store = {
    authorizeBusinessPermission: authorize,
    getConversation: () => ({
      conversation: { id: "conversation-1", activeShopId: conversationBusiness }
    })
  } as unknown as Cp2Store;
  const create = vi.fn(async () => ({ id: "conversation-1" }));
  const tasks = {
    create,
    get: vi.fn(async () => null),
    list: vi.fn(async () => [])
  } as unknown as BusinessTaskStore;
  registerBusinessTaskRoutes(
    app,
    store,
    available ? tasks : undefined,
    createBusinessEnvironmentRegistry([manifest])
  );
  return { app, create, authorize };
}
const request = () => ({
  taskId: "conversation-1",
  environmentId: manifest.id,
  environmentVersion: manifest.version,
  objective: "Inspect inventory",
  executionMode: "READ_ONLY",
  constraints: {},
  steps: [
    {
      id: "observe",
      capability: "products.list",
      input: {},
      dependencies: [],
      expectedOutput: "Products"
    }
  ]
});
const headers = { cookie: "grogoni_session=valid" };

describe("structured task HTTP boundary", () => {
  it("requires authenticated business access before exposing storage availability", async () => {
    const { app, create } = setup(false);
    try {
      expect(
        (await app.inject({ method: "GET", url: "/businesses/business-1/runtime/tasks" }))
          .statusCode
      ).toBe(401);
      expect(create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("requires durable storage and returns missing tasks without exposing another actor", async () => {
    const { app } = setup(false);
    try {
      expect(
        (await app.inject({ method: "GET", url: "/businesses/business-1/runtime/tasks", headers }))
          .statusCode
      ).toBe(503);
    } finally {
      await app.close();
    }
    const ready = setup();
    try {
      expect(
        (
          await ready.app.inject({
            method: "GET",
            url: "/businesses/business-1/runtime/tasks/unknown",
            headers
          })
        ).statusCode
      ).toBe(404);
    } finally {
      await ready.app.close();
    }
  });
  it("binds the task to an authorized conversation in the same business", async () => {
    const { app, create } = setup(true, "business-2");
    try {
      const response = await app.inject({
        method: "POST",
        url: "/businesses/business-1/runtime/tasks",
        headers,
        payload: request()
      });
      expect(response.statusCode).toBe(403);
      expect(create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("passes server-resolved manifests and scoped principals to persistence", async () => {
    const { app, create } = setup();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/businesses/business-1/runtime/tasks",
        headers,
        payload: request()
      });
      expect(response.statusCode).toBe(200);
      expect(create).toHaveBeenCalledWith(
        { sessionId: "valid", businessId: "business-1" },
        manifest,
        expect.objectContaining({
          taskId: "conversation-1",
          executionMode: "READ_ONLY",
          constraints: { budgetMinor: null, currency: null, horizonDays: null }
        })
      );
    } finally {
      await app.close();
    }
  });
  it("rejects unknown versions and invented capabilities before persistence", async () => {
    const { app, create } = setup();
    try {
      const version = await app.inject({
        method: "POST",
        url: "/businesses/business-1/runtime/tasks",
        headers,
        payload: { ...request(), environmentVersion: "2.0.0" }
      });
      expect(version.statusCode).toBe(409);
      const invented = await app.inject({
        method: "POST",
        url: "/businesses/business-1/runtime/tasks",
        headers,
        payload: {
          ...request(),
          steps: [{ ...request().steps[0], capability: "invented.execute" }]
        }
      });
      expect(invented.statusCode).toBe(400);
      expect(create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
