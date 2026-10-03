import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  BuyCheckoutItemInput,
  ConversationMessageContent,
  E2eePublicKey,
  McpAccessScope,
  McpPrincipal,
  RuntimeSwapDimension
} from "@grogoni/shared-types";
import { Cp2Error, readSessionCookie, type Cp2Store } from "../cp2/store.js";
import type { FulfillmentService } from "../cp2/domains/fulfillment/service.js";
import { mcpOAuthChallenge, mcpSecuritySchemes, registerMcpOAuthRoutes } from "./oauth.js";
import {
  describeFulfillmentMcpTool,
  findFulfillmentMcpTool,
  fulfillmentMcpTools,
  runFulfillmentMcpTool
} from "./fulfillment-tools.js";

const protocolVersion = "2025-11-25";
const maxRequestsPerMinute = 120;

export interface McpRouteOptions {
  allowedOrigins: string[];
  publicOrigin: string;
  store: Cp2Store;
  fulfillmentService?: FulfillmentService;
}

interface McpSession {
  tokenId: string;
  expiresAt: string;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface PendingCheckout {
  tokenId: string;
  items: BuyCheckoutItemInput[];
  idempotencyKey: string;
  expiresAt: number;
}

export function registerMcpRoutes(app: FastifyInstance, options: McpRouteOptions): void {
  const allowedOrigins = new Set(options.allowedOrigins);
  const sessions = new Map<string, McpSession>();
  const rateWindows = new Map<string, { startedAt: number; requests: number }>();
  const pendingCheckouts = new Map<string, PendingCheckout>();
  registerMcpOAuthRoutes(app, { store: options.store, publicOrigin: options.publicOrigin });

  app.post("/v1/mcp/tokens", async (request, reply) => {
    try {
      requireTrustedOrigin(request, allowedOrigins);
      const body = objectValue(request.body, "request body");
      const expiresInSeconds = optionalIntegerValue(body.expiresInSeconds, "expiresInSeconds");
      return options.store.createMcpAccessToken({
        sessionId: readSessionCookie(request.headers.cookie),
        name: stringValue(body.name, "name"),
        scopes: scopesValue(body.scopes),
        shopId: optionalStringValue(body.shopId, "shopId"),
        ...(expiresInSeconds === undefined ? {} : { expiresInSeconds })
      });
    } catch (error) {
      return sendHttpError(reply, error);
    }
  });

  app.get("/v1/mcp/tokens", async (request, reply) => {
    try {
      return {
        tokens: options.store.listMcpAccessTokens({
          sessionId: readSessionCookie(request.headers.cookie)
        })
      };
    } catch (error) {
      return sendHttpError(reply, error);
    }
  });

  app.delete(
    "/v1/mcp/tokens/:tokenId",
    async (request: FastifyRequest<{ Params: { tokenId: string } }>, reply) => {
      try {
        requireTrustedOrigin(request, allowedOrigins);
        return options.store.revokeMcpAccessToken({
          sessionId: readSessionCookie(request.headers.cookie),
          tokenId: request.params.tokenId
        });
      } catch (error) {
        return sendHttpError(reply, error);
      }
    }
  );

  app.get("/mcp", async (_request, reply) => {
    return reply.header("allow", "POST, DELETE").code(405).send();
  });

  app.delete("/mcp", async (request, reply) => {
    try {
      requireTrustedOrigin(request, allowedOrigins);
      const principal = authenticateBearer(request, options.store);
      requireShopLinkBinding(request, principal, options.store);
      const sessionId = stringHeader(request.headers["mcp-session-id"]);
      requireMcpSession(sessions, sessionId, principal);
      sessions.delete(sessionId);
      return reply.code(204).send();
    } catch (error) {
      return sendMcpHttpError(reply, error, null, options.publicOrigin);
    }
  });

  app.post("/mcp", async (request, reply) => {
    const rpc = isJsonRpcRequest(request.body) ? request.body : null;
    const id = rpc?.id ?? null;
    try {
      requireTrustedOrigin(request, allowedOrigins);
      const principal = authenticateBearer(request, options.store);
      requireShopLinkBinding(request, principal, options.store);
      enforceRateLimit(rateWindows, principal.tokenId);
      if (rpc === null || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
        return reply.send(jsonRpcError(id, -32600, "Invalid Request"));
      }

      if (rpc.method === "initialize") {
        const sessionId = randomUUID();
        sessions.set(sessionId, { tokenId: principal.tokenId, expiresAt: principal.expiresAt });
        return reply.header("mcp-session-id", sessionId).send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "grogoni", version: "0.1.0" },
            instructions:
              "Grogoni tools act as the authenticated account. Read credentials can browse shops, the marketplace, messages, and notifications. Act credentials can send messages, run permission-checked shop activities, and prepare purchases; checkout requires a separate confirmation call. fulfillment.* mutations run directly under the account's role permissions; each tool's description states what repeating it does, and tools that replay from an idempotency record require an idempotencyKey. Grams are decimal strings."
          }
        });
      }

      const sessionId = stringHeader(request.headers["mcp-session-id"]);
      requireMcpSession(sessions, sessionId, principal);

      if (rpc.method === "notifications/initialized") {
        return reply.code(202).send();
      }
      if (rpc.method === "ping") {
        return reply.send({ jsonrpc: "2.0", id, result: {} });
      }
      if (rpc.method === "tools/list") {
        return reply.send({
          jsonrpc: "2.0",
          id,
          result: {
            tools: mcpToolsForPrincipal(principal, options.fulfillmentService !== undefined)
          }
        });
      }
      if (rpc.method === "tools/call") {
        const result = await callMcpTool(
          options.store,
          principal,
          rpc.params,
          options.publicOrigin,
          options.fulfillmentService,
          pendingCheckouts
        );
        return reply.send({ jsonrpc: "2.0", id, result });
      }
      return reply.send(jsonRpcError(id, -32601, "Method not found"));
    } catch (error) {
      return sendMcpHttpError(reply, error, id, options.publicOrigin);
    }
  });
}

function mcpToolsForPrincipal(principal: McpPrincipal, fulfillmentAvailable: boolean) {
  const tools: Array<Record<string, unknown>> = [];
  if (principal.scopes.includes("mcp:read")) {
    tools.push(
      {
        name: "grogoni.get_profile",
        description:
          "Return the stable Grogoni account profile represented by the authenticated connection.",
        securitySchemes: mcpSecuritySchemes(["mcp:read"]),
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        outputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string", minLength: 1, pattern: "\\S" } }
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        _meta: { "openai/profile": true }
      },
      {
        name: "grogoni.list_shops",
        description: "List shops the authenticated Grogoni account can access.",
        securitySchemes: mcpSecuritySchemes(["mcp:read"]),
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false }
      },
      {
        name: "grogoni.get_sync_changes",
        description: "Read the account's durable incremental sync journal.",
        securitySchemes: mcpSecuritySchemes(["mcp:read"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            cursor: { type: ["string", "null"] },
            limit: { type: "integer", minimum: 1, maximum: 100 }
          }
        },
        annotations: { readOnlyHint: true, destructiveHint: false }
      },
      {
        name: "grogoni.query_catalogue",
        description:
          "Query canonical products in one authorized shop. Returns authoritative selling price, availability, and product IDs.",
        securitySchemes: mcpSecuritySchemes(["mcp:read"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["shopId", "query"],
          properties: {
            shopId: { type: "string", format: "uuid" },
            query: { type: "string", minLength: 1, maxLength: 120 },
            limit: { type: "integer", minimum: 1, maximum: 50 }
          }
        },
        annotations: { readOnlyHint: true, destructiveHint: false }
      },
      {
        name: "grogoni.get_inbox",
        description:
          "Receive the authenticated account's message inbox and one authorized shop's operational notifications. Returns unread items by default for polling agents.",
        securitySchemes: mcpSecuritySchemes(["mcp:read"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["shopId"],
          properties: {
            shopId: { type: "string", format: "uuid" },
            includeRead: { type: "boolean" },
            limit: { type: "integer", minimum: 1, maximum: 100 }
          }
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "grogoni.search_marketplace",
        description:
          "Search public Grogoni catalogues and the buyer's connected commerce feed using authoritative prices and product identifiers.",
        securitySchemes: mcpSecuritySchemes(["mcp:read"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: { query: { type: "string", minLength: 1, maxLength: 120 } }
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "grogoni.get_secure_channel",
        description:
          "Return one authorized conversation and the current public encryption endpoints for every participant. Refresh immediately before encrypting to prevent stale-recipient delivery.",
        securitySchemes: mcpSecuritySchemes(["mcp:read"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["conversationId"],
          properties: { conversationId: { type: "string", format: "uuid" } }
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "grogoni.runtime_status",
        description:
          "Resolve a task's Runtime Handoff Protocol state: its current immutable checkpoint, task head, runtime instance health, and whether the runtime has drifted from the task head.",
        securitySchemes: mcpSecuritySchemes(["mcp:read"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["taskId"],
          properties: { taskId: { type: "string" } }
        },
        annotations: { readOnlyHint: true, destructiveHint: false }
      }
    );
    if (fulfillmentAvailable) tools.push(...fulfillmentToolDescriptors("mcp:read"));
  }
  if (principal.scopes.includes("mcp:act")) {
    tools.push(
      {
        name: "grogoni.runtime_turn",
        description:
          "Propose a deterministic Grogoni runtime action. Business mutations return needs_confirmation and are not executed yet.",
        securitySchemes: mcpSecuritySchemes(["mcp:act"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["shopId", "message"],
          properties: {
            shopId: { type: "string", format: "uuid" },
            message: { type: "string", minLength: 1, maxLength: 2000 },
            runtimeSessionId: { type: "string", format: "uuid" }
          }
        },
        annotations: { readOnlyHint: false, destructiveHint: false }
      },
      {
        name: "grogoni.confirm_runtime_action",
        description: "Explicitly confirm one previously proposed Grogoni runtime action.",
        securitySchemes: mcpSecuritySchemes(["mcp:act"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["shopId", "runtimeSessionId", "confirmationToken"],
          properties: {
            shopId: { type: "string", format: "uuid" },
            runtimeSessionId: { type: "string", format: "uuid" },
            confirmationToken: { type: "string", minLength: 1 }
          }
        },
        annotations: { readOnlyHint: false, destructiveHint: true }
      },
      {
        name: "grogoni.send_message",
        description:
          "Send a text message in an existing conversation owned by the authenticated account. Repeating the same idempotencyKey does not duplicate the message.",
        securitySchemes: mcpSecuritySchemes(["mcp:act"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["conversationId", "text", "idempotencyKey"],
          properties: {
            conversationId: { type: "string", format: "uuid" },
            text: { type: "string", minLength: 1, maxLength: 4000 },
            idempotencyKey: { type: "string", minLength: 8, maxLength: 120 }
          }
        },
        annotations: { readOnlyHint: false, destructiveHint: false }
      },
      {
        name: "grogoni.register_secure_endpoint",
        description:
          "Register this agent or model runtime's P-256 public encryption endpoint. Private keys must remain in the calling runtime.",
        securitySchemes: mcpSecuritySchemes(["mcp:act"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["endpointId", "label", "publicKey"],
          properties: {
            endpointId: { type: "string", minLength: 8, maxLength: 120 },
            label: { type: "string", minLength: 1, maxLength: 120 },
            publicKey: e2eePublicKeySchema()
          }
        },
        annotations: { readOnlyHint: false, destructiveHint: false }
      },
      {
        name: "grogoni.create_secure_channel",
        description:
          "Create an authenticated direct channel to another Grogoni account for agent-to-agent, agent-to-model, or model-to-model communication. Messages require E2EE.",
        securitySchemes: mcpSecuritySchemes(["mcp:act"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["recipient"],
          properties: {
            recipient: { type: "string", minLength: 3, maxLength: 320 },
            title: { type: "string", maxLength: 200 },
            runtimeBindingId: { type: "string" }
          }
        },
        annotations: { readOnlyHint: false, destructiveHint: false }
      },
      {
        name: "grogoni.send_secure_message",
        description:
          "Send a replay-safe E2EE message from the authenticated agent or model runtime. Encrypt locally for exactly the endpoints returned by grogoni.get_secure_channel, one envelope each. On e2ee_device_set_changed, refresh the channel and re-encrypt; on e2ee_recipient_unavailable, a participant has no endpoint yet.",
        securitySchemes: mcpSecuritySchemes(["mcp:act"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["conversationId", "idempotencyKey", "content"],
          properties: {
            conversationId: { type: "string", format: "uuid" },
            idempotencyKey: { type: "string", minLength: 8, maxLength: 120 },
            content: encryptedContentSchema()
          }
        },
        annotations: { readOnlyHint: false, destructiveHint: false }
      },
      {
        name: "grogoni.prepare_checkout",
        description:
          "Stage a buyer's selected marketplace items and return a short-lived confirmation token. This does not create an order; stock and prices are validated during confirmation.",
        securitySchemes: mcpSecuritySchemes(["mcp:act"]),
        inputSchema: checkoutInputSchema(),
        annotations: { readOnlyHint: false, destructiveHint: false }
      },
      {
        name: "grogoni.confirm_checkout",
        description:
          "Create the previously prepared buyer checkout after explicit user confirmation. Stock and authoritative prices are revalidated by Grogoni.",
        securitySchemes: mcpSecuritySchemes(["mcp:act"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["confirmationToken"],
          properties: { confirmationToken: { type: "string", format: "uuid" } }
        },
        annotations: { readOnlyHint: false, destructiveHint: true }
      },
      {
        name: "grogoni.runtime_checkpoint",
        description:
          "Record a Runtime Handoff Protocol checkpoint for a task - its goal, current state, completed/pending actions, and next action. Immutable once written; pass promote:true with expectedHandoffId to also move the task head.",
        securitySchemes: mcpSecuritySchemes(["mcp:act"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["taskId"],
          properties: {
            taskId: { type: "string" },
            goal: { type: "string" },
            currentState: { type: "string" },
            nextAction: { type: ["string", "null"] },
            promote: { type: "boolean" },
            expectedHandoffId: { type: "string" }
          }
        },
        annotations: { readOnlyHint: false, destructiveHint: false }
      },
      {
        name: "grogoni.runtime_resume",
        description:
          "Resume a task from its Runtime Handoff Protocol state (the authoritative checkpoint), never from conversation transcript replay.",
        securitySchemes: mcpSecuritySchemes(["mcp:act"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["taskId"],
          properties: { taskId: { type: "string" } }
        },
        annotations: { readOnlyHint: false, destructiveHint: false }
      },
      {
        name: "grogoni.runtime_rollback",
        description:
          "Move a task's runtime head back to an earlier immutable checkpoint. Never mutates checkpoint history or the runtime binding.",
        securitySchemes: mcpSecuritySchemes(["mcp:act"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["taskId", "targetHandoffId"],
          properties: {
            taskId: { type: "string" },
            targetHandoffId: { type: "string" },
            expectedHandoffId: { type: "string" }
          }
        },
        annotations: { readOnlyHint: false, destructiveHint: true }
      },
      {
        name: "grogoni.runtime_merge",
        description:
          "Unify two or more diverged offline branch checkpoints into one new checkpoint and promote the task head to it. The first id in branchHandoffIds becomes the merge's primary parent; the rest are recorded as additional ancestors.",
        securitySchemes: mcpSecuritySchemes(["mcp:act"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["taskId", "branchHandoffIds", "expectedHandoffId"],
          properties: {
            taskId: { type: "string" },
            branchHandoffIds: { type: "array", items: { type: "string" }, minItems: 2 },
            goal: { type: "string" },
            currentState: { type: "string" },
            nextAction: { type: ["string", "null"] },
            expectedHandoffId: { type: "string" }
          }
        },
        annotations: { readOnlyHint: false, destructiveHint: true }
      },
      ...(["agent", "model", "host"] as const).map((dimension) => ({
        name: `grogoni.${dimension === "host" ? "execution_host" : dimension}_swap`,
        description: `Swap a task's ${dimension} to a new compatible ${dimension}, checkpointing current state first (Prepare -> Commit -> Activate). Task and conversation identity never change.`,
        securitySchemes: mcpSecuritySchemes(["mcp:act"]),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["taskId", "targetId"],
          properties: {
            taskId: { type: "string" },
            targetId: { type: "string" },
            expectedHandoffId: { type: "string" }
          }
        },
        annotations: { readOnlyHint: false, destructiveHint: false }
      }))
    );
    if (fulfillmentAvailable) tools.push(...fulfillmentToolDescriptors("mcp:act"));
  }
  return tools;
}

function fulfillmentToolDescriptors(scope: McpAccessScope) {
  return fulfillmentMcpTools
    .filter((tool) => tool.scope === scope)
    .map((tool) => describeFulfillmentMcpTool(tool, mcpSecuritySchemes([scope])));
}

async function callMcpTool(
  store: Cp2Store,
  principal: McpPrincipal,
  params: unknown,
  publicOrigin: string,
  fulfillmentService: FulfillmentService | undefined,
  pendingCheckouts: Map<string, PendingCheckout>
) {
  const record = objectValue(params, "params");
  const name = stringValue(record.name, "name");
  const args = objectValue(record.arguments ?? {}, "arguments");
  const fulfillmentTool = findFulfillmentMcpTool(name);
  try {
    let result: unknown;
    if (name === "grogoni.get_profile") {
      requireScope(principal, "mcp:read");
      result = { id: principal.accountId };
    } else if (name === "grogoni.list_shops") {
      requireScope(principal, "mcp:read");
      result = store.listAccountShopsForMcp({ principal });
    } else if (name === "grogoni.get_sync_changes") {
      requireScope(principal, "mcp:read");
      const limit = optionalIntegerValue(args.limit, "limit");
      result = store.pullSyncChangesForMcp({
        principal,
        cursor: optionalStringValue(args.cursor, "cursor"),
        ...(limit === undefined ? {} : { limit })
      });
    } else if (name === "grogoni.query_catalogue") {
      requireScope(principal, "mcp:read");
      const shopId = requiredShop(principal, args.shopId);
      const limit = optionalIntegerValue(args.limit, "limit");
      result = store.queryCatalogueForMcp({
        principal,
        businessId: shopId,
        query: stringValue(args.query, "query"),
        ...(limit === undefined ? {} : { limit })
      });
    } else if (name === "grogoni.get_inbox") {
      requireScope(principal, "mcp:read");
      const shopId = requiredShop(principal, args.shopId);
      const limit = optionalIntegerValue(args.limit, "limit");
      result = store.getInboxForMcp({
        principal,
        businessId: shopId,
        ...(args.includeRead === undefined
          ? {}
          : { includeRead: booleanValue(args.includeRead, "includeRead") }),
        ...(limit === undefined ? {} : { limit })
      });
    } else if (name === "grogoni.search_marketplace") {
      requireScope(principal, "mcp:read");
      result = store.searchMarketplaceForMcp({
        principal,
        query: stringValue(args.query, "query")
      });
    } else if (name === "grogoni.get_secure_channel") {
      requireScope(principal, "mcp:read");
      result = store.getSecureChannelForMcp({
        principal,
        conversationId: stringValue(args.conversationId, "conversationId")
      });
    } else if (name === "grogoni.runtime_status") {
      requireScope(principal, "mcp:read");
      result = store.resolveRuntimeHandoffForMcp({
        principal,
        taskId: stringValue(args.taskId, "taskId")
      });
    } else if (fulfillmentTool !== undefined) {
      requireScope(principal, fulfillmentTool.scope);
      const shopId = requiredShop(principal, args.shopId);
      if (fulfillmentService === undefined) throw fulfillmentUnavailable();
      result = await store.runFulfillmentForMcp(principal, async () =>
        runFulfillmentMcpTool(fulfillmentTool, {
          args,
          businessId: shopId,
          service: fulfillmentService,
          store
        })
      );
    } else if (name === "grogoni.runtime_checkpoint") {
      requireScope(principal, "mcp:act");
      result = store.createRuntimeCheckpointForMcp({
        principal,
        checkpoint: {
          taskId: stringValue(args.taskId, "taskId"),
          ...(args.goal === undefined ? {} : { goal: stringValue(args.goal, "goal") }),
          ...(args.currentState === undefined
            ? {}
            : { currentState: stringValue(args.currentState, "currentState") }),
          ...(args.nextAction === undefined
            ? {}
            : {
                nextAction:
                  args.nextAction === null ? null : stringValue(args.nextAction, "nextAction")
              }),
          ...(args.promote === undefined ? {} : { promote: args.promote === true }),
          ...(args.expectedHandoffId === undefined
            ? {}
            : { expectedHandoffId: stringValue(args.expectedHandoffId, "expectedHandoffId") })
        }
      });
    } else if (name === "grogoni.runtime_resume") {
      requireScope(principal, "mcp:act");
      result = store.resumeRuntimeHandoffForMcp({
        principal,
        taskId: stringValue(args.taskId, "taskId")
      });
    } else if (name === "grogoni.runtime_rollback") {
      requireScope(principal, "mcp:act");
      result = store.rollbackRuntimeHandoffForMcp({
        principal,
        rollback: {
          taskId: stringValue(args.taskId, "taskId"),
          targetHandoffId: stringValue(args.targetHandoffId, "targetHandoffId"),
          ...(args.expectedHandoffId === undefined
            ? {}
            : { expectedHandoffId: stringValue(args.expectedHandoffId, "expectedHandoffId") })
        }
      });
    } else if (name === "grogoni.runtime_merge") {
      requireScope(principal, "mcp:act");
      result = store.mergeRuntimeHandoffsForMcp({
        principal,
        merge: {
          taskId: stringValue(args.taskId, "taskId"),
          branchHandoffIds: stringArrayValue(args.branchHandoffIds, "branchHandoffIds"),
          expectedHandoffId: stringValue(args.expectedHandoffId, "expectedHandoffId"),
          ...(args.goal === undefined ? {} : { goal: stringValue(args.goal, "goal") }),
          ...(args.currentState === undefined
            ? {}
            : { currentState: stringValue(args.currentState, "currentState") }),
          ...(args.nextAction === undefined
            ? {}
            : {
                nextAction:
                  args.nextAction === null ? null : stringValue(args.nextAction, "nextAction")
              })
        }
      });
    } else if (
      name === "grogoni.agent_swap" ||
      name === "grogoni.model_swap" ||
      name === "grogoni.execution_host_swap"
    ) {
      requireScope(principal, "mcp:act");
      const dimension: RuntimeSwapDimension =
        name === "grogoni.agent_swap" ? "agent" : name === "grogoni.model_swap" ? "model" : "host";
      result = store.performRuntimeSwapForMcp({
        principal,
        swap: {
          taskId: stringValue(args.taskId, "taskId"),
          dimension,
          targetId: stringValue(args.targetId, "targetId"),
          ...(args.expectedHandoffId === undefined
            ? {}
            : { expectedHandoffId: stringValue(args.expectedHandoffId, "expectedHandoffId") })
        }
      });
    } else if (name === "grogoni.runtime_turn") {
      requireScope(principal, "mcp:act");
      const shopId = requiredShop(principal, args.shopId);
      result = await store.createRuntimeTurnForMcp({
        principal,
        businessId: shopId,
        message: stringValue(args.message, "message"),
        ...(args.runtimeSessionId === undefined
          ? {}
          : { runtimeSessionId: stringValue(args.runtimeSessionId, "runtimeSessionId") })
      });
    } else if (name === "grogoni.confirm_runtime_action") {
      requireScope(principal, "mcp:act");
      const shopId = requiredShop(principal, args.shopId);
      result = await store.createRuntimeTurnForMcp({
        principal,
        businessId: shopId,
        runtimeSessionId: stringValue(args.runtimeSessionId, "runtimeSessionId"),
        confirmationToken: stringValue(args.confirmationToken, "confirmationToken"),
        message: "Confirm the previously proposed MCP action."
      });
    } else if (name === "grogoni.send_message") {
      requireScope(principal, "mcp:act");
      result = store.sendMessageForMcp({
        principal,
        conversationId: stringValue(args.conversationId, "conversationId"),
        text: stringValue(args.text, "text"),
        idempotencyKey: stringValue(args.idempotencyKey, "idempotencyKey")
      });
    } else if (name === "grogoni.register_secure_endpoint") {
      requireScope(principal, "mcp:act");
      result = store.registerSecureEndpointForMcp({
        principal,
        deviceId: stringValue(args.endpointId, "endpointId"),
        label: stringValue(args.label, "label"),
        publicKey: e2eePublicKeyValue(args.publicKey, "publicKey")
      });
    } else if (name === "grogoni.create_secure_channel") {
      requireScope(principal, "mcp:act");
      result = store.createSecureChannelForMcp({
        principal,
        recipient: stringValue(args.recipient, "recipient"),
        ...(args.title === undefined ? {} : { title: stringValue(args.title, "title") }),
        ...(args.runtimeBindingId === undefined
          ? {}
          : { runtimeBindingId: stringValue(args.runtimeBindingId, "runtimeBindingId") })
      });
    } else if (name === "grogoni.send_secure_message") {
      requireScope(principal, "mcp:act");
      result = store.sendSecureMessageForMcp({
        principal,
        conversationId: stringValue(args.conversationId, "conversationId"),
        idempotencyKey: stringValue(args.idempotencyKey, "idempotencyKey"),
        content: encryptedContentValue(args.content)
      });
    } else if (name === "grogoni.prepare_checkout") {
      requireScope(principal, "mcp:act");
      const confirmationToken = randomUUID();
      const items = checkoutItemsValue(args.items);
      const idempotencyKey = stringValue(args.idempotencyKey, "idempotencyKey");
      const expiresAt = Date.now() + 10 * 60_000;
      pendingCheckouts.set(confirmationToken, {
        tokenId: principal.tokenId,
        items,
        idempotencyKey,
        expiresAt
      });
      result = {
        status: "needs_confirmation",
        confirmationToken,
        expiresAt: new Date(expiresAt).toISOString(),
        items
      };
    } else if (name === "grogoni.confirm_checkout") {
      requireScope(principal, "mcp:act");
      const confirmationToken = stringValue(args.confirmationToken, "confirmationToken");
      const pending = pendingCheckouts.get(confirmationToken);
      if (
        pending === undefined ||
        pending.tokenId !== principal.tokenId ||
        pending.expiresAt <= Date.now()
      ) {
        pendingCheckouts.delete(confirmationToken);
        throw new Cp2Error(
          409,
          "mcp_checkout_confirmation_invalid",
          "Checkout confirmation is invalid or expired. Prepare the checkout again."
        );
      }
      result = store.createCheckoutForMcp({
        principal,
        items: pending.items,
        idempotencyKey: pending.idempotencyKey
      });
      pendingCheckouts.delete(confirmationToken);
    } else {
      throw new Cp2Error(404, "mcp_tool_not_found", "MCP tool was not found.");
    }
    return toolResult(result, false);
  } catch (error) {
    if (error instanceof Cp2Error) {
      const readTool =
        name === "grogoni.get_profile" ||
        name === "grogoni.list_shops" ||
        name === "grogoni.get_sync_changes" ||
        name === "grogoni.query_catalogue" ||
        name === "grogoni.get_inbox" ||
        name === "grogoni.search_marketplace" ||
        name === "grogoni.get_secure_channel" ||
        name === "grogoni.runtime_status";
      const fulfillmentReadTool = fulfillmentTool?.scope === "mcp:read";
      const challenge =
        error.code === "mcp_scope_forbidden"
          ? mcpOAuthChallenge(
              publicOrigin,
              readTool || fulfillmentReadTool ? "mcp:read" : "mcp:act"
            )
          : undefined;
      // Same error body as HTTP (sendCp2Error): an agent retrying needs `details` (for example
      // the stop's recorded deliveryStatus) to tell its own success from someone else's change.
      return toolResult(
        {
          code: error.code,
          message: error.message,
          ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
          ...(error.details === undefined ? {} : { details: error.details })
        },
        true,
        challenge
      );
    }
    throw error;
  }
}

function fulfillmentUnavailable(): Cp2Error {
  return new Cp2Error(
    503,
    "fulfillment_requires_postgres",
    "Corridor fulfillment requires PostgreSQL."
  );
}

function toolResult(value: unknown, isError: boolean, challenge?: string) {
  const text = JSON.stringify(value);
  return {
    content: [{ type: "text", text }],
    structuredContent: value,
    isError,
    ...(challenge === undefined
      ? {}
      : {
          _meta: {
            "mcp/www_authenticate": [
              `${challenge}, error="insufficient_scope", error_description="Authorize the required Grogoni permission"`
            ]
          }
        })
  };
}

function authenticateBearer(request: FastifyRequest, store: Cp2Store): McpPrincipal {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new Cp2Error(401, "mcp_bearer_required", "Bearer authorization is required.");
  }
  return store.authenticateMcpAccessToken({ accessToken: authorization.slice(7).trim() });
}

function requireMcpSession(
  sessions: Map<string, McpSession>,
  sessionId: string,
  principal: McpPrincipal
): void {
  const session = sessions.get(sessionId);
  if (
    session === undefined ||
    session.tokenId !== principal.tokenId ||
    Date.parse(session.expiresAt) <= Date.now()
  ) {
    throw new Cp2Error(400, "mcp_session_invalid", "MCP session is invalid or expired.");
  }
}

function enforceRateLimit(
  windows: Map<string, { startedAt: number; requests: number }>,
  tokenId: string
): void {
  const now = Date.now();
  const current = windows.get(tokenId);
  if (current === undefined || now - current.startedAt >= 60_000) {
    windows.set(tokenId, { startedAt: now, requests: 1 });
    return;
  }
  current.requests += 1;
  if (current.requests > maxRequestsPerMinute) {
    throw new Cp2Error(429, "mcp_rate_limited", "MCP request rate limit exceeded.");
  }
}

function requireTrustedOrigin(request: FastifyRequest, allowedOrigins: Set<string>): void {
  const origin = request.headers.origin;
  if (origin !== undefined && !allowedOrigins.has(origin)) {
    throw new Cp2Error(403, "mcp_origin_forbidden", "MCP origin is not allowed.");
  }
}

function requireScope(principal: McpPrincipal, scope: McpAccessScope): void {
  if (!principal.scopes.includes(scope)) {
    throw new Cp2Error(403, "mcp_scope_forbidden", "MCP token lacks the required scope.");
  }
}

function requireShopLinkBinding(
  request: FastifyRequest,
  principal: McpPrincipal,
  store: Cp2Store
): void {
  if (typeof request.query !== "object" || request.query === null) return;
  const shopId = (request.query as Record<string, unknown>).shopId;
  if (shopId === undefined) return;
  // Account-wide tokens may select a shop, but canonical membership checks still apply.
  if (typeof shopId !== "string" || (principal.shopId !== null && principal.shopId !== shopId)) {
    throw new Cp2Error(403, "mcp_shop_forbidden", "MCP token is bound to another shop.");
  }
  store.assertMcpShopAccess(principal, shopId);
}

function requiredShop(principal: McpPrincipal, value: unknown): string {
  const shopId = stringValue(value, "shopId");
  if (principal.shopId !== null && principal.shopId !== shopId) {
    throw new Cp2Error(403, "mcp_shop_forbidden", "MCP token is bound to another shop.");
  }
  return shopId;
}

function sendHttpError(reply: FastifyReply, error: unknown) {
  if (error instanceof Cp2Error) {
    return reply.code(error.statusCode).send({ code: error.code, message: error.message });
  }
  throw error;
}

function sendMcpHttpError(reply: FastifyReply, error: unknown, id: unknown, publicOrigin: string) {
  if (error instanceof Cp2Error) {
    if (error.statusCode === 401) {
      reply.header("www-authenticate", mcpOAuthChallenge(publicOrigin));
    }
    return reply.code(error.statusCode).send(jsonRpcError(id, -32000, error.message));
  }
  throw error;
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Cp2Error(400, "mcp_input_invalid", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Cp2Error(400, "mcp_input_invalid", `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalStringValue(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : stringValue(value, field);
}

function stringArrayValue(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Cp2Error(400, "mcp_input_invalid", `${field} must be an array of strings.`);
  }
  return value as string[];
}

function optionalIntegerValue(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value)) {
    throw new Cp2Error(400, "mcp_input_invalid", `${field} must be an integer.`);
  }
  return value as number;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Cp2Error(400, "mcp_input_invalid", `${field} must be a boolean.`);
  }
  return value;
}

function e2eePublicKeySchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["kty", "crv", "x", "y"],
    properties: {
      kty: { const: "EC" },
      crv: { const: "P-256" },
      x: { type: "string" },
      y: { type: "string" },
      ext: { type: "boolean" },
      key_ops: { type: "array", items: { type: "string" } }
    }
  };
}

function encryptedContentSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "envelopes", "attachmentCount", "iv", "ciphertext"],
    properties: {
      type: { const: "encrypted" },
      attachmentCount: { type: "integer", minimum: 0, maximum: 10 },
      iv: { type: "string" },
      ciphertext: { type: "string" },
      envelopes: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "version",
            "algorithm",
            "recipientDeviceId",
            "ephemeralPublicKey",
            "salt",
            "iv",
            "ciphertext"
          ],
          properties: {
            version: { const: 1 },
            algorithm: { const: "ECDH-P256-HKDF-SHA256-AES-256-GCM" },
            recipientDeviceId: { type: "string" },
            ephemeralPublicKey: e2eePublicKeySchema(),
            salt: { type: "string" },
            iv: { type: "string" },
            ciphertext: { type: "string" }
          }
        }
      }
    }
  };
}

function e2eePublicKeyValue(value: unknown, field: string): E2eePublicKey {
  const key = objectValue(value, field);
  if (key.kty !== "EC" || key.crv !== "P-256") {
    throw new Cp2Error(400, "mcp_input_invalid", `${field} must be an EC P-256 public key.`);
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: stringValue(key.x, `${field}.x`),
    y: stringValue(key.y, `${field}.y`),
    ...(key.ext === undefined ? {} : { ext: booleanValue(key.ext, `${field}.ext`) }),
    ...(key.key_ops === undefined
      ? {}
      : { key_ops: stringArrayValue(key.key_ops, `${field}.key_ops`) })
  };
}

function encryptedContentValue(
  value: unknown
): Extract<ConversationMessageContent, { type: "encrypted" }> {
  const content = objectValue(value, "content");
  if (content.type !== "encrypted" || !Array.isArray(content.envelopes)) {
    throw new Cp2Error(400, "mcp_input_invalid", "content must be an encrypted message.");
  }
  const attachmentCount = optionalIntegerValue(content.attachmentCount, "content.attachmentCount");
  if (attachmentCount === undefined) {
    throw new Cp2Error(400, "mcp_input_invalid", "content.attachmentCount must be an integer.");
  }
  return {
    type: "encrypted",
    attachmentCount,
    iv: stringValue(content.iv, "content.iv"),
    ciphertext: stringValue(content.ciphertext, "content.ciphertext"),
    envelopes: content.envelopes.map((entry, index) => {
      const envelope = objectValue(entry, `content.envelopes[${index}]`);
      if (envelope.version !== 1 || envelope.algorithm !== "ECDH-P256-HKDF-SHA256-AES-256-GCM") {
        throw new Cp2Error(
          400,
          "mcp_input_invalid",
          `content.envelopes[${index}] uses an unsupported encryption format.`
        );
      }
      return {
        version: 1,
        algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM",
        recipientDeviceId: stringValue(
          envelope.recipientDeviceId,
          `content.envelopes[${index}].recipientDeviceId`
        ),
        ephemeralPublicKey: e2eePublicKeyValue(
          envelope.ephemeralPublicKey,
          `content.envelopes[${index}].ephemeralPublicKey`
        ),
        salt: stringValue(envelope.salt, `content.envelopes[${index}].salt`),
        iv: stringValue(envelope.iv, `content.envelopes[${index}].iv`),
        ciphertext: stringValue(envelope.ciphertext, `content.envelopes[${index}].ciphertext`)
      };
    })
  };
}

function checkoutInputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items", "idempotencyKey"],
    properties: {
      idempotencyKey: { type: "string", minLength: 8, maxLength: 120 },
      items: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "sourceKind",
            "sourceId",
            "sourceLabel",
            "title",
            "quantity",
            "agentId",
            "productId",
            "statusBroadcastId",
            "productCaptureItemId"
          ],
          properties: {
            sourceKind: { enum: ["catalogue", "contact"] },
            sourceId: { type: "string" },
            sourceLabel: { type: "string" },
            title: { type: "string" },
            quantity: { type: "integer", minimum: 1 },
            agentId: { type: ["string", "null"] },
            productId: { type: ["string", "null"] },
            statusBroadcastId: { type: ["string", "null"] },
            productCaptureItemId: { type: ["string", "null"] }
          }
        }
      }
    }
  };
}

function checkoutItemsValue(value: unknown): BuyCheckoutItemInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Cp2Error(400, "mcp_input_invalid", "items must contain between 1 and 100 items.");
  }
  return value.map((entry, index) => {
    const item = objectValue(entry, `items[${index}]`);
    const sourceKind = stringValue(item.sourceKind, `items[${index}].sourceKind`);
    if (sourceKind !== "catalogue" && sourceKind !== "contact") {
      throw new Cp2Error(400, "mcp_input_invalid", `items[${index}].sourceKind is invalid.`);
    }
    const quantity = optionalIntegerValue(item.quantity, `items[${index}].quantity`);
    if (quantity === undefined || quantity < 1) {
      throw new Cp2Error(400, "mcp_input_invalid", `items[${index}].quantity must be positive.`);
    }
    return {
      sourceKind,
      sourceId: stringValue(item.sourceId, `items[${index}].sourceId`),
      sourceLabel: stringValue(item.sourceLabel, `items[${index}].sourceLabel`),
      title: stringValue(item.title, `items[${index}].title`),
      quantity,
      agentId: optionalStringValue(item.agentId, `items[${index}].agentId`),
      productId: optionalStringValue(item.productId, `items[${index}].productId`),
      statusBroadcastId: optionalStringValue(
        item.statusBroadcastId,
        `items[${index}].statusBroadcastId`
      ),
      productCaptureItemId: optionalStringValue(
        item.productCaptureItemId,
        `items[${index}].productCaptureItemId`
      )
    };
  });
}

function scopesValue(value: unknown): McpAccessScope[] {
  if (!Array.isArray(value)) {
    throw new Cp2Error(400, "mcp_input_invalid", "scopes must be an array.");
  }
  return value.map((scope) => {
    if (scope !== "mcp:read" && scope !== "mcp:act") {
      throw new Cp2Error(400, "mcp_scope_invalid", "Unsupported MCP scope.");
    }
    return scope;
  });
}

function stringHeader(value: string | string[] | undefined): string {
  return stringValue(Array.isArray(value) ? value[0] : value, "Mcp-Session-Id");
}
