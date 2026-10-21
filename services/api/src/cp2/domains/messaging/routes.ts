/**
 * Thirteenth domain slice of in-process modularization for services/api/src/cp2/routes.ts (see
 * docs/architecture/routes-modularization-roadmap.md). Owns conversations, messages, E2EE
 * devices, push subscriptions, connected mailboxes (+ OAuth), native SMS device/command/message
 * routes, channel readiness/endpoints/messages/webhooks, message handoffs, and the
 * public-storefront session/message/inbox routes - everything that calls into
 * `domains/messaging/store.ts`'s `MessagingDomain` on the store.ts side.
 *
 * The largest single extraction so far (40 routes). Was split into two clusters in the original
 * file: the bulk sat right after the agent-runtime cluster (interrupted only by the
 * marketplace-intro routes and the registerAgentRuntimeRoutes call, both left in routes.ts), and
 * three more routes (`/public/storefronts/:agentId/sessions`, `/public/storefronts/:agentId/messages`,
 * `/businesses/:businessId/storefront/messages`) sat far later, tightly interleaved with CORE's
 * public-storefront listing, shop-presence, and network-invite routes. Both clusters combine into
 * a single `registerMessagingRoutes` call here, matching every other domain's convention.
 *
 * Imports `parseRuntimeTurnBody`/`RuntimeTurnBody` from the agent-runtime domain (POST /v1/messages
 * parses an embedded agent-authored turn) and `defaultOAuthRedirectUri` from the oauth domain
 * (connected-mailbox OAuth start needs the API's own redirect origin) - the same
 * cross-domain-import pattern used throughout this effort. Exports nothing of its own: no other
 * domain or CORE route in routes.ts references any messaging-only type or helper.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  ChannelProvider,
  ConnectedMailboxProvider,
  ConversationKind,
  ConversationMessageContent,
  E2eePublicKey,
  MessageChannel,
  MessageHandoffChannel,
  MessageHandoffStatus,
  NativeSmsResultCode,
  TrustedMessageAttachmentReference
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { type Cp2Store, readSessionCookie } from "../../store.js";
import { parseRuntimeTurnBody, type RuntimeTurnBody } from "../agent-runtime/routes.js";
import { defaultOAuthRedirectUri } from "../oauth/routes.js";
import { contentDispositionHeader } from "../../workspace-file-delivery.js";
import {
  parseBoolean,
  parseIntegerString,
  parseIsoTimestamp,
  parseNonNegativeInteger,
  parseNullableString,
  parseOptionalString,
  parsePositiveInteger,
  parseRequestBody,
  parseString,
  parseStringArray,
  sendCp2Error,
  type BusinessParams,
  type CustomerParams,
  type StorefrontParams
} from "../../route-helpers.js";

interface CreateConversationBody {
  kind?: string;
  activeShopId?: string | null;
  recipient?: string | null;
  title?: string | null;
  runtimeBindingId?: string | null;
}

interface ConversationParams {
  conversationId: string;
}

interface ConversationAttachmentParams extends ConversationParams {
  attachmentId: string;
}

interface CreateMessageBody {
  conversationId?: string;
  clientMessageId?: string;
  idempotencyKey?: string;
  content?: unknown;
  clientTimestamp?: string | null;
  queuedAt?: string | null;
  selectedChannel?: string;
  author?: string;
  replyToMessageId?: string | null;
  forwardedFromMessageId?: string | null;
  agent?: RuntimeTurnBody & {
    businessId?: string;
  };
}

interface MessageHandoffBody {
  businessId?: string | null;
  conversationId?: string | null;
  channel?: string;
  status?: string;
  normalizedErrorCode?: string | null;
}

interface ChannelMessageBody {
  customerId?: string;
  customerName?: string;
  conversationId?: string;
  provider?: string;
  mailboxId?: string;
  subject?: string;
  replyToMessageId?: string;
  attachments?: unknown;
  text?: string;
  idempotencyKey?: string;
}

interface ConnectedMailboxParams extends BusinessParams {
  mailboxId: string;
}

interface ConnectedMailboxOAuthParams {
  provider: string;
}

interface ConnectedMailboxOAuthQuery {
  code?: string;
  error?: string;
  state?: string;
}

interface ConnectedMailboxSyncBody {
  historyDays?: number;
}

interface ConnectedMailboxUpdateBody {
  isDefault?: boolean;
  ingestUnknownSenders?: boolean;
  automaticReplyEnabled?: boolean;
  automaticReplyText?: string | null;
}

interface ChannelLinkGrantBody {
  provider?: string;
  conversationId?: string | null;
  automaticRepliesEnabled?: boolean;
}

interface ChannelWebhookParams {
  provider: string;
}

interface NativeSmsDeviceBody {
  roleAvailable?: boolean;
  roleGranted?: boolean;
  sendPermissionGranted?: boolean;
  receivePermissionGranted?: boolean;
  simReady?: boolean;
  subscriptionId?: number | null;
  preferred?: boolean;
  lastErrorCode?: string | null;
}

interface NativeSmsInboundBody {
  businessId?: string;
  externalMessageId?: string;
  sender?: string;
  text?: string;
  occurredAt?: string;
}

interface NativeSmsCommandResultBody {
  status?: string;
  resultCode?: string;
  carrierReference?: string | null;
}

interface NativeSmsCommandParams {
  commandId: string;
}

interface NativeSmsDeviceParams {
  deviceId: string;
}

interface UpdateConversationBody {
  archived?: boolean;
  mutedUntil?: string | null;
  pinned?: boolean;
  read?: boolean;
  title?: string | null;
}

interface UpdateMessageBody {
  text?: string;
  content?: unknown;
  deleted?: boolean;
  reaction?: string | null;
}

interface E2eeDeviceBody {
  deviceId?: string;
  label?: string;
  publicKey?: unknown;
}

interface PushSubscriptionBody {
  endpoint?: string;
  expirationTime?: number | null;
  keys?: unknown;
}

interface MessageParams extends ConversationParams {
  messageId: string;
}

interface PublicStorefrontMessageBody {
  capabilityToken?: string;
  body?: string;
  attachmentNames?: string[];
}

interface PublicStorefrontSessionBody {
  visitorId?: string;
  displayName?: string | null;
}

export function registerMessagingRoutes(
  app: FastifyInstance,
  store: Cp2Store,
  oauthAllowedRedirectOrigins: ReadonlySet<string>,
  vapidPublicKey: string | undefined
): void {
  app.post("/v1/help", async (request, reply) => {
    try {
      return store.ensureHelpConversations({
        sessionId: readSessionCookie(request.headers.cookie)
      });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });
  app.get(
    "/v1/conversations",
    async (request: FastifyRequest<{ Querystring: { includeArchived?: string } }>, reply) => {
      try {
        return {
          conversations: store.listConversations({
            sessionId: readSessionCookie(request.headers.cookie),
            includeArchived: request.query.includeArchived === "true"
          })
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/v1/conversations",
    async (request: FastifyRequest<{ Body: CreateConversationBody }>, reply) => {
      try {
        return store.createConversation({
          sessionId: readSessionCookie(request.headers.cookie),
          kind: parseConversationKind(request.body.kind),
          activeShopId: parseNullableString(request.body.activeShopId),
          recipient: parseNullableString(request.body.recipient),
          title: parseNullableString(request.body.title),
          runtimeBindingId: parseNullableString(request.body.runtimeBindingId)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/v1/conversations/:conversationId",
    async (request: FastifyRequest<{ Params: ConversationParams }>, reply) => {
      try {
        return store.getConversation({
          sessionId: readSessionCookie(request.headers.cookie),
          conversationId: parseString(request.params.conversationId, "conversationId")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/v1/conversations/:conversationId/attachments/:attachmentId/preview",
    async (request: FastifyRequest<{ Params: ConversationAttachmentParams }>, reply) => {
      try {
        const attachment = await store.getConversationAttachment({
          sessionId: readSessionCookie(request.headers.cookie),
          conversationId: parseString(request.params.conversationId, "conversationId"),
          attachmentId: parseString(request.params.attachmentId, "attachmentId")
        });
        if (!attachment.record.previewable) {
          throw new Cp2Error(
            415,
            "ATTACHMENT_PREVIEW_UNAVAILABLE",
            "This attachment is available for download only."
          );
        }
        request.log.info(
          {
            event: "workspace_file_preview",
            conversationId: attachment.record.conversationId,
            attachmentId: attachment.record.id
          },
          "Workspace attachment preview authorized."
        );
        return reply
          .header("content-type", attachment.record.mimeType)
          .header("content-length", String(attachment.record.size))
          .header(
            "content-disposition",
            contentDispositionHeader("inline", attachment.record.filename)
          )
          .header("cache-control", "private, no-store")
          .header("etag", `"${attachment.record.checksum}"`)
          .send(attachment.bytes);
      } catch (error) {
        request.log.warn(
          {
            event: "workspace_file_preview_failed",
            conversationId: request.params.conversationId,
            attachmentId: request.params.attachmentId,
            errorCode: error instanceof Cp2Error ? error.code : "ATTACHMENT_PREVIEW_FAILED"
          },
          "Workspace attachment preview failed."
        );
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/v1/conversations/:conversationId/attachments/:attachmentId/download",
    async (request: FastifyRequest<{ Params: ConversationAttachmentParams }>, reply) => {
      try {
        const attachment = await store.getConversationAttachment({
          sessionId: readSessionCookie(request.headers.cookie),
          conversationId: parseString(request.params.conversationId, "conversationId"),
          attachmentId: parseString(request.params.attachmentId, "attachmentId")
        });
        request.log.info(
          {
            event: "workspace_file_download",
            conversationId: attachment.record.conversationId,
            attachmentId: attachment.record.id
          },
          "Workspace attachment download authorized."
        );
        return reply
          .header("content-type", attachment.record.mimeType)
          .header("content-length", String(attachment.record.size))
          .header(
            "content-disposition",
            contentDispositionHeader("attachment", attachment.record.filename)
          )
          .header("cache-control", "private, no-store")
          .header("etag", `"${attachment.record.checksum}"`)
          .send(attachment.bytes);
      } catch (error) {
        request.log.warn(
          {
            event: "workspace_file_download_failed",
            conversationId: request.params.conversationId,
            attachmentId: request.params.attachmentId,
            errorCode: error instanceof Cp2Error ? error.code : "ATTACHMENT_DOWNLOAD_FAILED"
          },
          "Workspace attachment download failed."
        );
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post("/v1/e2ee/devices", async (request: FastifyRequest<{ Body: E2eeDeviceBody }>, reply) => {
    try {
      return store.registerE2eeDevice({
        sessionId: readSessionCookie(request.headers.cookie),
        deviceId: parseString(request.body.deviceId, "deviceId"),
        label: parseString(request.body.label, "label"),
        publicKey: parseE2eePublicKey(request.body.publicKey, "publicKey")
      });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.get("/v1/e2ee/devices", async (request, reply) => {
    try {
      return {
        devices: store.listE2eeDevices({ sessionId: readSessionCookie(request.headers.cookie) })
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.delete(
    "/v1/e2ee/devices/:deviceId",
    async (request: FastifyRequest<{ Params: { deviceId: string } }>, reply) => {
      try {
        return store.revokeE2eeDevice({
          sessionId: readSessionCookie(request.headers.cookie),
          deviceId: parseString(request.params.deviceId, "deviceId")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/v1/conversations/:conversationId/encryption-devices",
    async (request: FastifyRequest<{ Params: ConversationParams }>, reply) => {
      try {
        return {
          devices: store.listConversationE2eeDevices({
            sessionId: readSessionCookie(request.headers.cookie),
            conversationId: parseString(request.params.conversationId, "conversationId")
          })
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get("/v1/push/config", async () => ({
    enabled: Boolean(vapidPublicKey),
    publicKey: vapidPublicKey ?? null
  }));

  app.post(
    "/v1/push/subscriptions",
    async (request: FastifyRequest<{ Body: PushSubscriptionBody }>, reply) => {
      try {
        const keys = parseRequestBody(request.body.keys);
        return store.registerPushSubscription({
          sessionId: readSessionCookie(request.headers.cookie),
          endpoint: parseString(request.body.endpoint, "endpoint"),
          expirationTime:
            request.body.expirationTime === undefined || request.body.expirationTime === null
              ? null
              : parseNonNegativeInteger(request.body.expirationTime, "expirationTime"),
          keys: {
            auth: parseString(keys.auth, "keys.auth"),
            p256dh: parseString(keys.p256dh, "keys.p256dh")
          }
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.delete(
    "/v1/push/subscriptions",
    async (request: FastifyRequest<{ Body: { endpoint?: string } }>, reply) => {
      try {
        return store.removePushSubscription({
          sessionId: readSessionCookie(request.headers.cookie),
          endpoint: parseString(request.body.endpoint, "endpoint")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post("/v1/messages", async (request: FastifyRequest<{ Body: CreateMessageBody }>, reply) => {
    try {
      const sessionId = readSessionCookie(request.headers.cookie);
      const clientTimestamp =
        request.body.clientTimestamp === undefined || request.body.clientTimestamp === null
          ? null
          : parseIsoTimestamp(request.body.clientTimestamp, "clientTimestamp");
      const queuedAt =
        request.body.queuedAt === undefined || request.body.queuedAt === null
          ? null
          : parseIsoTimestamp(request.body.queuedAt, "queuedAt");
      const selectedChannel = parseOptionalString(request.body.selectedChannel);
      if (selectedChannel !== undefined && !isMessageChannel(selectedChannel)) {
        throw new Cp2Error(400, "message_channel_invalid", "selectedChannel is invalid.");
      }
      const idempotencyKey = parseOptionalString(request.body.idempotencyKey);
      const content = parseConversationMessageContent(request.body.content);
      const messageInput = {
        sessionId,
        conversationId: parseString(request.body.conversationId, "conversationId"),
        clientMessageId: parseString(request.body.clientMessageId, "clientMessageId"),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        content,
        replyToMessageId: parseNullableString(request.body.replyToMessageId),
        forwardedFromMessageId: parseNullableString(request.body.forwardedFromMessageId),
        clientTimestamp,
        queuedAt,
        ...(selectedChannel !== undefined ? { selectedChannel } : {})
      };

      if (request.body.agent !== undefined) {
        if (request.body.author === "agent") {
          throw new Cp2Error(
            400,
            "agent_processing_invalid",
            "An agent-authored message cannot request another agent turn."
          );
        }
        const agent = parseRequestBody(request.body.agent);
        const runtime = parseRuntimeTurnBody(agent);
        const businessId = parseString(agent.businessId, "agent.businessId");
        let processed;
        try {
          processed = await store.createAgentConversationMessage({
            ...messageInput,
            businessId,
            message: runtime.message,
            ...(runtime.runtimeSessionId === undefined
              ? {}
              : { runtimeSessionId: runtime.runtimeSessionId })
          });
        } catch (error) {
          request.log.warn(
            {
              event: "model.inference_failed",
              requestId: request.id,
              shopId: businessId,
              errorCode: error instanceof Cp2Error ? error.code : "INFERENCE_FAILED"
            },
            "Agent inference failed."
          );
          throw error;
        }
        const modelPromptEvent = processed.runtime?.turn.telemetry.find(
          (event) => event.state === "model.prompt_built"
        );
        const modelTrace = processed.runtime?.turn.model;
        if (modelTrace?.bindingId !== undefined) {
          request.log.info(
            {
              event: "model.active_binding_resolved",
              requestId: request.id,
              shopId: businessId,
              bindingId: modelTrace.bindingId,
              modelId: modelTrace.modelId ?? null,
              executionTarget: modelTrace.executionTarget ?? null
            },
            "Active agent model binding resolved."
          );
          request.log.info(
            {
              event: "model.route_selected",
              requestId: request.id,
              shopId: businessId,
              bindingId: modelTrace.bindingId,
              modelId: modelTrace.modelId ?? null,
              executionTarget: modelTrace.executionTarget ?? null
            },
            "Agent model route selected."
          );
          request.log.info(
            {
              event:
                modelTrace.status === "available"
                  ? "model.inference_completed"
                  : "model.inference_failed",
              requestId: request.id,
              shopId: businessId,
              bindingId: modelTrace.bindingId,
              modelId: modelTrace.modelId ?? null,
              executionTarget: modelTrace.executionTarget ?? null,
              latencyMs: modelTrace.durationMs,
              errorCode: modelTrace.errorCode
            },
            modelTrace.status === "available"
              ? "Agent inference completed."
              : "Agent inference failed."
          );
        }
        request.log.info(
          {
            correlationId: processed.processing.correlationId,
            tenantId: businessId,
            conversationId: processed.message.conversationId,
            messageId: processed.message.id,
            agentId: processed.agentMessage?.authorId ?? null,
            bindingId: processed.runtime?.turn.model?.bindingId ?? null,
            modelId:
              processed.runtime?.turn.model?.modelId ??
              modelPromptEvent?.metadata.modelProfile ??
              null,
            provider: processed.runtime?.turn.model?.provider ?? null,
            executionTarget: processed.runtime?.turn.model?.executionTarget ?? null,
            processingStage:
              processed.processing.status === "completed"
                ? "assistant_persisted"
                : "model_processing_failed",
            normalizedErrorCode: processed.processing.errorCode,
            durationMs: processed.runtime?.turn.model?.durationMs ?? null
          },
          "Agent chat processing completed."
        );
        await store.deliverPendingMessageNotifications({ messageId: processed.message.id });
        return {
          ...processed.message,
          ...(processed.agentMessage === null ? {} : { agentMessage: processed.agentMessage }),
          runtime: processed.runtime,
          processing: processed.processing
        };
      }

      const message = store.createConversationMessage({
        ...messageInput,
        author: request.body.author === "agent" ? "agent" : "user"
      });
      await store.deliverPendingMessageNotifications({ messageId: message.id });
      return message;
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.get(
    "/businesses/:businessId/mailboxes/providers",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return {
          providers: store.listConnectedMailboxProviders({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: parseString(request.params.businessId, "businessId")
          })
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/mailboxes",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return {
          mailboxes: store.listConnectedMailboxes({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: parseString(request.params.businessId, "businessId")
          })
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/mailboxes/oauth/:provider/start",
    async (
      request: FastifyRequest<{
        Params: BusinessParams & ConnectedMailboxOAuthParams;
      }>,
      reply
    ) => {
      try {
        const provider = parseConnectedMailboxProvider(request.params.provider);
        const apiOrigin = new URL(defaultOAuthRedirectUri(request)).origin;
        const redirectUri = new URL(
          `/v1/mailboxes/oauth/${provider}/callback`,
          apiOrigin
        ).toString();
        const requestedOrigin = request.headers.origin;
        const returnOrigin =
          requestedOrigin !== undefined &&
          (requestedOrigin === apiOrigin || oauthAllowedRedirectOrigins.has(requestedOrigin))
            ? requestedOrigin
            : apiOrigin;
        return store.beginConnectedMailboxOAuth({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: parseString(request.params.businessId, "businessId"),
          provider,
          redirectUri,
          returnUrl: new URL("/?mailbox=connected", returnOrigin).toString()
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/v1/mailboxes/oauth/:provider/callback",
    async (
      request: FastifyRequest<{
        Params: ConnectedMailboxOAuthParams;
        Querystring: ConnectedMailboxOAuthQuery;
      }>,
      reply
    ) => {
      try {
        if (request.query.error !== undefined) {
          throw new Cp2Error(401, "mailbox_oauth_denied", "Mailbox authorization was denied.");
        }
        const result = await store.completeConnectedMailboxOAuth({
          provider: parseConnectedMailboxProvider(request.params.provider),
          code: parseString(request.query.code, "code"),
          state: parseString(request.query.state, "state")
        });
        request.log.info(
          {
            event: "mailbox_connected",
            businessId: result.mailbox.businessId,
            mailboxId: result.mailbox.id,
            provider: result.mailbox.provider
          },
          "Connected mailbox authorization completed."
        );
        return reply.redirect(result.returnUrl);
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/mailboxes/:mailboxId",
    async (
      request: FastifyRequest<{
        Params: ConnectedMailboxParams;
        Body: ConnectedMailboxUpdateBody;
      }>,
      reply
    ) => {
      try {
        return store.updateConnectedMailbox({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: parseString(request.params.businessId, "businessId"),
          mailboxId: parseString(request.params.mailboxId, "mailboxId"),
          ...(request.body.isDefault === undefined
            ? {}
            : { isDefault: parseBoolean(request.body.isDefault, "isDefault") }),
          ...(request.body.ingestUnknownSenders === undefined
            ? {}
            : {
                ingestUnknownSenders: parseBoolean(
                  request.body.ingestUnknownSenders,
                  "ingestUnknownSenders"
                )
              }),
          ...(request.body.automaticReplyEnabled === undefined
            ? {}
            : {
                automaticReplyEnabled: parseBoolean(
                  request.body.automaticReplyEnabled,
                  "automaticReplyEnabled"
                )
              }),
          ...(request.body.automaticReplyText === undefined
            ? {}
            : { automaticReplyText: parseNullableString(request.body.automaticReplyText) })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.delete(
    "/businesses/:businessId/mailboxes/:mailboxId",
    async (request: FastifyRequest<{ Params: ConnectedMailboxParams }>, reply) => {
      try {
        const mailbox = await store.disconnectConnectedMailbox({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: parseString(request.params.businessId, "businessId"),
          mailboxId: parseString(request.params.mailboxId, "mailboxId")
        });
        request.log.info(
          {
            event: "mailbox_disconnected",
            businessId: mailbox.businessId,
            mailboxId: mailbox.id,
            provider: mailbox.provider
          },
          "Connected mailbox disconnected."
        );
        return mailbox;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/mailboxes/:mailboxId/sync",
    async (
      request: FastifyRequest<{
        Params: ConnectedMailboxParams;
        Body: ConnectedMailboxSyncBody;
      }>,
      reply
    ) => {
      try {
        const synchronized = await store.syncConnectedMailbox({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: parseString(request.params.businessId, "businessId"),
          mailboxId: parseString(request.params.mailboxId, "mailboxId"),
          ...(request.body.historyDays === undefined
            ? {}
            : {
                historyDays: parseNonNegativeInteger(request.body.historyDays, "historyDays")
              })
        });
        request.log.info(
          {
            event: "mailbox_sync_completed",
            businessId: synchronized.mailbox.businessId,
            mailboxId: synchronized.mailbox.id,
            provider: synchronized.mailbox.provider,
            fetched: synchronized.fetched,
            ingested: synchronized.ingested,
            deduplicated: synchronized.deduplicated,
            filtered: synchronized.filtered
          },
          "Connected mailbox synchronization completed."
        );
        return synchronized;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/mailboxes/:mailboxId/conversations",
    async (
      request: FastifyRequest<{
        Params: ConnectedMailboxParams;
        Body: { recipientAddress?: string; displayName?: string };
      }>,
      reply
    ) => {
      try {
        return store.createConnectedEmailConversation({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: parseString(request.params.businessId, "businessId"),
          mailboxId: parseString(request.params.mailboxId, "mailboxId"),
          recipientAddress: parseString(request.body.recipientAddress, "recipientAddress"),
          ...(request.body.displayName === undefined
            ? {}
            : { displayName: parseString(request.body.displayName, "displayName") })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.put(
    "/v1/devices/native-sms",
    async (request: FastifyRequest<{ Body: NativeSmsDeviceBody }>, reply) => {
      try {
        return store.registerNativeSmsDevice({
          sessionId: readSessionCookie(request.headers.cookie),
          roleAvailable: parseBoolean(request.body.roleAvailable, "roleAvailable"),
          roleGranted: parseBoolean(request.body.roleGranted, "roleGranted"),
          sendPermissionGranted: parseBoolean(
            request.body.sendPermissionGranted,
            "sendPermissionGranted"
          ),
          receivePermissionGranted: parseBoolean(
            request.body.receivePermissionGranted,
            "receivePermissionGranted"
          ),
          simReady: parseBoolean(request.body.simReady, "simReady"),
          ...(request.body.subscriptionId === undefined
            ? {}
            : {
                subscriptionId:
                  request.body.subscriptionId === null
                    ? null
                    : parseNonNegativeInteger(request.body.subscriptionId, "subscriptionId")
              }),
          ...(request.body.preferred === undefined
            ? {}
            : { preferred: parseBoolean(request.body.preferred, "preferred") }),
          ...(request.body.lastErrorCode === undefined
            ? {}
            : { lastErrorCode: parseNullableString(request.body.lastErrorCode) })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get("/v1/devices/native-sms", async (request, reply) => {
    try {
      return {
        devices: store.listNativeSmsDevices({
          sessionId: readSessionCookie(request.headers.cookie)
        })
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.get("/v1/devices/native-sms/businesses", async (request, reply) => {
    try {
      return {
        businesses: store.listNativeSmsBusinesses({
          sessionId: readSessionCookie(request.headers.cookie)
        })
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.delete(
    "/v1/devices/native-sms/:deviceId",
    async (request: FastifyRequest<{ Params: NativeSmsDeviceParams }>, reply) => {
      try {
        return store.revokeNativeSmsDevice({
          sessionId: readSessionCookie(request.headers.cookie),
          deviceId: parseString(request.params.deviceId, "deviceId")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/v1/devices/native-sms/commands",
    async (request: FastifyRequest<{ Querystring: { limit?: string } }>, reply) => {
      try {
        return store.fetchNativeSmsCommands({
          sessionId: readSessionCookie(request.headers.cookie),
          ...(request.query.limit === undefined
            ? {}
            : { limit: parseIntegerString(request.query.limit, "limit") })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/v1/devices/native-sms/commands/:commandId/acknowledge",
    async (request: FastifyRequest<{ Params: NativeSmsCommandParams }>, reply) => {
      try {
        return store.acknowledgeNativeSmsCommand({
          sessionId: readSessionCookie(request.headers.cookie),
          commandId: parseString(request.params.commandId, "commandId")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/v1/devices/native-sms/commands/:commandId/result",
    async (
      request: FastifyRequest<{
        Params: NativeSmsCommandParams;
        Body: NativeSmsCommandResultBody;
      }>,
      reply
    ) => {
      try {
        return store.reportNativeSmsCommandResult({
          sessionId: readSessionCookie(request.headers.cookie),
          commandId: parseString(request.params.commandId, "commandId"),
          status: parseNativeSmsCommandResultStatus(request.body.status),
          resultCode: parseNativeSmsResultCode(request.body.resultCode),
          ...(request.body.carrierReference === undefined
            ? {}
            : { carrierReference: parseNullableString(request.body.carrierReference) })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/v1/devices/native-sms/messages",
    async (request: FastifyRequest<{ Body: NativeSmsInboundBody }>, reply) => {
      try {
        const result = store.ingestNativeSmsMessage({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: parseString(request.body.businessId, "businessId"),
          externalMessageId: parseString(request.body.externalMessageId, "externalMessageId"),
          sender: parseString(request.body.sender, "sender"),
          text: parseString(request.body.text, "text"),
          occurredAt: parseString(request.body.occurredAt, "occurredAt")
        });
        request.log.info(
          {
            event: "native_sms.inbound_received",
            businessId: result.customer.businessId,
            customerId: result.customer.id,
            messageId: result.message?.id ?? null,
            receiptId: result.receipt.id,
            deviceId: result.device.id
          },
          "Native SMS message synchronized."
        );
        return result;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/channels/readiness",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return {
          providers: store.listChannelProviderReadiness({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: parseString(request.params.businessId, "businessId")
          })
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/channel-endpoints",
    async (
      request: FastifyRequest<{
        Params: BusinessParams;
        Querystring: { customerId?: string; conversationId?: string };
      }>,
      reply
    ) => {
      try {
        return {
          endpoints: store.listCustomerChannelEndpoints({
            sessionId: readSessionCookie(request.headers.cookie),
            businessId: parseString(request.params.businessId, "businessId"),
            ...(request.query.customerId === undefined
              ? {}
              : { customerId: parseString(request.query.customerId, "customerId") }),
            ...(request.query.conversationId === undefined
              ? {}
              : { conversationId: parseString(request.query.conversationId, "conversationId") })
          })
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/customers/:customerId/channel-link-grants",
    async (
      request: FastifyRequest<{ Params: CustomerParams; Body: ChannelLinkGrantBody }>,
      reply
    ) => {
      try {
        return store.createChannelIdentityLinkGrant({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: parseString(request.params.businessId, "businessId"),
          customerId: parseString(request.params.customerId, "customerId"),
          provider: parseChannelProvider(request.body.provider),
          ...(request.body.conversationId === undefined
            ? {}
            : { conversationId: parseNullableString(request.body.conversationId) }),
          ...(request.body.automaticRepliesEnabled === undefined
            ? {}
            : {
                automaticRepliesEnabled: parseBoolean(
                  request.body.automaticRepliesEnabled,
                  "automaticRepliesEnabled"
                )
              })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/channel-messages",
    async (
      request: FastifyRequest<{ Params: BusinessParams; Body: ChannelMessageBody }>,
      reply
    ) => {
      try {
        const sent = await store.sendChannelMessage({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: parseString(request.params.businessId, "businessId"),
          ...(request.body.customerId === undefined
            ? {}
            : { customerId: parseString(request.body.customerId, "customerId") }),
          ...(request.body.customerName === undefined
            ? {}
            : { customerName: parseString(request.body.customerName, "customerName") }),
          ...(request.body.conversationId === undefined
            ? {}
            : { conversationId: parseString(request.body.conversationId, "conversationId") }),
          ...(request.body.provider === undefined
            ? {}
            : { provider: parseChannelProvider(request.body.provider) }),
          ...(request.body.mailboxId === undefined
            ? {}
            : { mailboxId: parseString(request.body.mailboxId, "mailboxId") }),
          ...(request.body.subject === undefined
            ? {}
            : { subject: parseString(request.body.subject, "subject") }),
          ...(request.body.replyToMessageId === undefined
            ? {}
            : {
                replyToMessageId: parseString(request.body.replyToMessageId, "replyToMessageId")
              }),
          ...(request.body.attachments === undefined
            ? {}
            : {
                attachments: parseTrustedMessageAttachmentReferences(request.body.attachments)
              }),
          text: parseString(request.body.text, "text"),
          idempotencyKey: parseString(request.body.idempotencyKey, "idempotencyKey")
        });
        request.log.info(
          {
            tenantId: request.params.businessId,
            conversationId: sent.message.conversationId,
            messageId: sent.message.id,
            provider: sent.selection.endpoint.provider,
            status: sent.message.status
          },
          "Channel message delivery completed."
        );
        return sent;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/v1/webhooks/channels/:provider",
    async (
      request: FastifyRequest<{
        Params: ChannelWebhookParams;
        Querystring: Record<string, unknown>;
      }>,
      reply
    ) => {
      try {
        const provider = parseChannelProvider(request.params.provider);
        const challenge = store.channelWebhookChallenge(provider, request.query);
        if (challenge === null) return reply.code(401).send({ code: "CHANNEL_WEBHOOK_INVALID" });
        return reply.type(provider === "x" ? "application/json" : "text/plain").send(challenge);
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  // Signature checks use the exact provider bytes, including whitespace and Unicode.
  void app.register(async (webhook) => {
    webhook.removeContentTypeParser("application/json");
    if (webhook.hasContentTypeParser("application/x-www-form-urlencoded"))
      webhook.removeContentTypeParser("application/x-www-form-urlencoded");
    webhook.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body)
    );
    webhook.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body)
    );
    webhook.post(
      "/v1/webhooks/channels/:provider",
      async (request: FastifyRequest<{ Params: ChannelWebhookParams; Body: Buffer }>, reply) => {
        try {
          const provider = parseChannelProvider(request.params.provider);
          const rawBody = request.body;
          let payload: unknown;
          try {
            payload = request.headers["content-type"]?.includes("application/x-www-form-urlencoded")
              ? Object.fromEntries(new URLSearchParams(rawBody.toString("utf8")))
              : JSON.parse(rawBody.toString("utf8"));
          } catch {
            return reply.code(400).send({ code: "webhook_payload_invalid" });
          }
          const results = store.ingestChannelWebhookBatch({
            provider,
            headers: request.headers,
            payload,
            rawBody
          });
          request.log.info({ provider, count: results.length }, "Channel webhook processed.");
          if (provider === "sms") return reply.type("text/xml").send("<Response/>");
          // Preserve the existing single-message response contract for Telegram clients.
          return results.length === 1 ? results[0] : { results };
        } catch (error) {
          return sendCp2Error(reply, error);
        }
      }
    );
  });

  app.post(
    "/v1/message-handoffs",
    async (request: FastifyRequest<{ Body: MessageHandoffBody }>, reply) => {
      try {
        const channel = parseString(request.body.channel, "channel");
        if (!isMessageHandoffChannel(channel)) {
          throw new Cp2Error(
            400,
            "message_handoff_channel_invalid",
            "The handoff channel is invalid."
          );
        }
        const status = parseString(request.body.status, "status");
        if (!isMessageHandoffStatus(status)) {
          throw new Cp2Error(
            400,
            "message_handoff_status_invalid",
            "The handoff status is invalid."
          );
        }
        return store.recordMessageHandoff({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: parseNullableString(request.body.businessId),
          conversationId: parseNullableString(request.body.conversationId),
          channel,
          status,
          normalizedErrorCode: parseNullableString(request.body.normalizedErrorCode)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/v1/conversations/:conversationId",
    async (
      request: FastifyRequest<{ Params: ConversationParams; Body: UpdateConversationBody }>,
      reply
    ) => {
      try {
        const mutedUntil =
          request.body.mutedUntil === undefined
            ? undefined
            : request.body.mutedUntil === null
              ? null
              : parseIsoTimestamp(request.body.mutedUntil, "mutedUntil");
        return store.updateConversationSettings({
          sessionId: readSessionCookie(request.headers.cookie),
          conversationId: parseString(request.params.conversationId, "conversationId"),
          ...(request.body.archived !== undefined ? { archived: request.body.archived } : {}),
          ...(mutedUntil !== undefined ? { mutedUntil } : {}),
          ...(request.body.pinned !== undefined ? { pinned: request.body.pinned } : {}),
          ...(request.body.read !== undefined ? { read: request.body.read } : {}),
          ...(request.body.title !== undefined ? { title: request.body.title } : {})
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  // Soft-deletes a conversation into the recycle bin. Admin-only (see MessagingDomain.
  // requireConversationAdmin): the shop owner for a shop-scoped conversation, or an account that
  // owns no business (or owns one) for a personal conversation. Refuses with 507/recycle_bin_full
  // once the owning scope's bin is at capacity - the caller should point the user at emptying it.
  app.delete(
    "/v1/conversations/:conversationId",
    async (request: FastifyRequest<{ Params: ConversationParams }>, reply) => {
      try {
        return store.deleteConversation({
          sessionId: readSessionCookie(request.headers.cookie),
          conversationId: parseString(request.params.conversationId, "conversationId")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/v1/conversations/:conversationId/restore",
    async (request: FastifyRequest<{ Params: ConversationParams }>, reply) => {
      try {
        return store.restoreConversationFromRecycleBin({
          sessionId: readSessionCookie(request.headers.cookie),
          conversationId: parseString(request.params.conversationId, "conversationId")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/v1/conversations/recycle-bin",
    async (request: FastifyRequest<{ Querystring: { businessId?: string } }>, reply) => {
      try {
        return store.listRecycleBin({
          sessionId: readSessionCookie(request.headers.cookie),
          ...(request.query.businessId === undefined
            ? {}
            : { businessId: request.query.businessId })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/v1/conversations/recycle-bin/empty",
    async (
      request: FastifyRequest<{
        Body: { businessId?: string | null; conversationIds?: string[] };
      }>,
      reply
    ) => {
      try {
        return store.emptyRecycleBin({
          sessionId: readSessionCookie(request.headers.cookie),
          ...(request.body.businessId === undefined
            ? {}
            : { businessId: parseNullableString(request.body.businessId) }),
          ...(request.body.conversationIds === undefined
            ? {}
            : {
                conversationIds: parseStringArray(
                  request.body.conversationIds,
                  "conversationIds",
                  200
                )
              })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/v1/conversations/:conversationId/messages/:messageId/delivery-attempts",
    async (request: FastifyRequest<{ Params: MessageParams }>, reply) => {
      try {
        return {
          attempts: store.listMessageDeliveryAttempts({
            sessionId: readSessionCookie(request.headers.cookie),
            conversationId: parseString(request.params.conversationId, "conversationId"),
            messageId: parseString(request.params.messageId, "messageId")
          })
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/v1/conversations/:conversationId/messages/:messageId",
    async (request: FastifyRequest<{ Params: MessageParams; Body: UpdateMessageBody }>, reply) => {
      try {
        return store.updateConversationMessage({
          sessionId: readSessionCookie(request.headers.cookie),
          conversationId: parseString(request.params.conversationId, "conversationId"),
          messageId: parseString(request.params.messageId, "messageId"),
          ...(request.body.text !== undefined ? { text: request.body.text } : {}),
          ...(request.body.content !== undefined
            ? { content: parseConversationMessageContent(request.body.content) }
            : {}),
          ...(request.body.deleted !== undefined ? { deleted: request.body.deleted } : {}),
          ...(request.body.reaction !== undefined ? { reaction: request.body.reaction } : {})
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/v1/conversations/:conversationId/typing",
    async (
      request: FastifyRequest<{ Params: ConversationParams; Body: { typing?: boolean } }>,
      reply
    ) => {
      try {
        return {
          typing: store.setConversationTyping({
            sessionId: readSessionCookie(request.headers.cookie),
            conversationId: parseString(request.params.conversationId, "conversationId"),
            typing: parseBoolean(request.body.typing, "typing")
          })
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/public/storefronts/:agentId/sessions",
    async (
      request: FastifyRequest<{ Params: StorefrontParams; Body: PublicStorefrontSessionBody }>,
      reply
    ) => {
      try {
        return store.createPublicStorefrontSession({
          agentId: parseString(request.params.agentId, "agentId"),
          visitorId: parseString(request.body.visitorId, "visitorId"),
          displayName: parseNullableString(request.body.displayName)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/public/storefronts/:agentId/messages",
    async (
      request: FastifyRequest<{ Params: StorefrontParams; Body: PublicStorefrontMessageBody }>,
      reply
    ) => {
      try {
        return await store.createPublicStorefrontMessage({
          agentId: parseString(request.params.agentId, "agentId"),
          capabilityToken: parseString(request.body.capabilityToken, "capabilityToken"),
          body: parseString(request.body.body, "body"),
          attachmentNames: parseStringArray(request.body.attachmentNames, "attachmentNames", 10)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/storefront/messages",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listPublicStorefrontMessages({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}

function isMessageChannel(value: string): value is MessageChannel {
  return [
    "grogoni",
    "sms",
    "mms",
    "rcs_business",
    "whatsapp_business",
    "telegram",
    "facebook_messenger",
    "instagram_messaging",
    "tiktok_business",
    "x_dm",
    "native_sms",
    "email"
  ].includes(value);
}

function parseChannelProvider(value: unknown): ChannelProvider {
  const provider = parseString(value, "provider");
  if (
    [
      "grogoni",
      "telegram",
      "whatsapp",
      "messenger",
      "instagram",
      "tiktok",
      "x",
      "sms",
      "native_sms",
      "email"
    ].includes(provider)
  ) {
    return provider as ChannelProvider;
  }
  throw new Cp2Error(400, "channel_provider_invalid", "The channel provider is invalid.");
}

function parseConnectedMailboxProvider(value: unknown): ConnectedMailboxProvider {
  const provider = parseString(value, "provider");
  if (provider === "gmail" || provider === "outlook") return provider;
  throw new Cp2Error(400, "mailbox_provider_invalid", "Mailbox provider is invalid.");
}

function parseNativeSmsCommandResultStatus(
  value: unknown
): "sending" | "sent" | "delivered" | "failed" {
  const status = parseString(value, "status");
  if (["sending", "sent", "delivered", "failed"].includes(status)) {
    return status as "sending" | "sent" | "delivered" | "failed";
  }
  throw new Cp2Error(400, "sms_result_status_invalid", "SMS result status is invalid.");
}

function parseNativeSmsResultCode(value: unknown): NativeSmsResultCode {
  const code = parseString(value, "resultCode");
  if (
    [
      "SMS_SENT",
      "SMS_DELIVERED",
      "SMS_DEVICE_UNAVAILABLE",
      "SMS_NO_SERVICE",
      "SMS_RADIO_OFF",
      "SMS_SIM_UNAVAILABLE",
      "SMS_SIM_SELECTION_REQUIRED",
      "SMS_PERMISSION_REQUIRED",
      "SMS_ROLE_REQUIRED",
      "SMS_SEND_FAILED",
      "SMS_DELIVERY_UNKNOWN"
    ].includes(code)
  ) {
    return code as NativeSmsResultCode;
  }
  throw new Cp2Error(400, "sms_result_code_invalid", "SMS result code is invalid.");
}

function isMessageHandoffStatus(value: string): value is MessageHandoffStatus {
  return [
    "preparing",
    "composer_opened",
    "no_sms_app",
    "invalid_recipient",
    "cancelled_before_handoff",
    "native_bridge_unavailable",
    "share_completed",
    "share_cancelled",
    "copied_to_clipboard",
    "share_unavailable",
    "unsupported"
  ].includes(value);
}

function isMessageHandoffChannel(value: string): value is MessageHandoffChannel {
  return value === "sms_external_app" || value === "platform_share_sheet";
}

function parseConversationKind(value: unknown): ConversationKind {
  if (value === "personal" || value === "storefront" || value === "order") {
    return value;
  }

  throw new Cp2Error(400, "conversation_kind_invalid", "Conversation kind is not supported.");
}

function parseConversationMessageContent(value: unknown): ConversationMessageContent {
  const content = parseRequestBody(value);
  const type = parseString(content.type, "content.type");

  if (
    type === "product-management" ||
    type === "supplier-management" ||
    type === "customer-management" ||
    type === "invoice-management" ||
    type === "payment-management" ||
    type === "import-management" ||
    type === "logistics-management"
  ) {
    const optionalField =
      type === "product-management"
        ? "productId"
        : type === "supplier-management"
          ? "supplierId"
          : type === "customer-management"
            ? "customerId"
            : type === "import-management"
              ? "importJobId"
              : "customerName";
    return {
      type,
      businessId: parseString(content.businessId, "content.businessId"),
      ...(content[optionalField] === undefined
        ? {}
        : { [optionalField]: parseString(content[optionalField], `content.${optionalField}`) })
    };
  }

  if (type === "text") {
    const attachments = content.attachments;
    if (attachments !== undefined && !Array.isArray(attachments)) {
      throw new Cp2Error(400, "message_content_invalid", "content.attachments must be an array.");
    }
    return {
      type,
      text: parseString(content.text, "content.text"),
      ...(Array.isArray(attachments)
        ? {
            attachments: attachments.map((value, index) => {
              const attachment = parseRequestBody(value);
              const category = parseString(
                attachment.category,
                `content.attachments[${index}].category`
              );
              if (!["document", "image", "video", "audio", "other"].includes(category)) {
                throw new Cp2Error(
                  400,
                  "message_content_invalid",
                  "Attachment category is not supported."
                );
              }
              const parsed = {
                id: parseString(attachment.id, `content.attachments[${index}].id`),
                name: parseString(attachment.name, `content.attachments[${index}].name`),
                mimeType: parseString(
                  attachment.mimeType,
                  `content.attachments[${index}].mimeType`
                ),
                size: parseNonNegativeInteger(
                  attachment.size,
                  `content.attachments[${index}].size`
                ),
                category: category as "document" | "image" | "video" | "audio" | "other"
              };
              if (attachment.source === "managed") {
                const kind = parseString(attachment.kind, `content.attachments[${index}].kind`);
                if (!["image", "pdf", "text", "document", "archive", "file"].includes(kind)) {
                  throw new Cp2Error(
                    400,
                    "message_content_invalid",
                    "Managed attachment kind is not supported."
                  );
                }
                const caption = parseOptionalString(attachment.caption);
                return {
                  ...parsed,
                  source: "managed" as const,
                  kind: kind as "image" | "pdf" | "text" | "document" | "archive" | "file",
                  previewable: parseBoolean(
                    attachment.previewable,
                    `content.attachments[${index}].previewable`
                  ),
                  ...(caption === undefined ? {} : { caption })
                };
              }
              if (attachment.source !== undefined) {
                throw new Cp2Error(
                  400,
                  "message_content_invalid",
                  "Attachment source is not supported."
                );
              }
              return {
                ...parsed,
                url: parseString(attachment.url, `content.attachments[${index}].url`)
              };
            })
          }
        : {})
    };
  }

  if (type === "encrypted") {
    if (!Array.isArray(content.envelopes)) {
      throw new Cp2Error(400, "message_content_invalid", "content.envelopes must be an array.");
    }
    return {
      type,
      attachmentCount: parseNonNegativeInteger(content.attachmentCount, "content.attachmentCount"),
      iv: parseString(content.iv, "content.iv"),
      ciphertext: parseString(content.ciphertext, "content.ciphertext"),
      envelopes: content.envelopes.map((value, index) => {
        const envelope = parseRequestBody(value);
        return {
          version: parsePositiveInteger(
            envelope.version,
            `content.envelopes[${index}].version`
          ) as 1,
          algorithm: parseString(
            envelope.algorithm,
            `content.envelopes[${index}].algorithm`
          ) as "ECDH-P256-HKDF-SHA256-AES-256-GCM",
          recipientDeviceId: parseString(
            envelope.recipientDeviceId,
            `content.envelopes[${index}].recipientDeviceId`
          ),
          ephemeralPublicKey: parseE2eePublicKey(
            envelope.ephemeralPublicKey,
            `content.envelopes[${index}].ephemeralPublicKey`
          ),
          salt: parseString(envelope.salt, `content.envelopes[${index}].salt`),
          iv: parseString(envelope.iv, `content.envelopes[${index}].iv`),
          ciphertext: parseString(envelope.ciphertext, `content.envelopes[${index}].ciphertext`)
        };
      })
    };
  }

  if (type === "storefront" || type === "owner-controls") {
    return { type, shopId: parseString(content.shopId, "content.shopId") };
  }

  if (type === "confirmation") {
    return {
      type,
      confirmationToken: parseString(content.confirmationToken, "content.confirmationToken"),
      prompt: parseString(content.prompt, "content.prompt")
    };
  }

  throw new Cp2Error(400, "message_content_invalid", "Message content type is not supported.");
}

function parseE2eePublicKey(value: unknown, field: string): E2eePublicKey {
  const key = parseRequestBody(value);
  return {
    kty: parseString(key.kty, `${field}.kty`) as "EC",
    crv: parseString(key.crv, `${field}.crv`) as "P-256",
    x: parseString(key.x, `${field}.x`),
    y: parseString(key.y, `${field}.y`),
    ...(typeof key.ext === "boolean" ? { ext: key.ext } : {}),
    ...(Array.isArray(key.key_ops)
      ? {
          key_ops: key.key_ops.map((item, index) => parseString(item, `${field}.key_ops[${index}]`))
        }
      : {})
  };
}

function parseTrustedMessageAttachmentReferences(
  value: unknown
): TrustedMessageAttachmentReference[] {
  if (!Array.isArray(value) || value.length > 3) {
    throw new Cp2Error(
      400,
      "EMAIL_ATTACHMENT_UNAVAILABLE",
      "Email attachments must contain at most three trusted resource references."
    );
  }
  return value.map((item, index) => {
    const record = parseRequestBody(item);
    const resourceType = parseString(record.resourceType, `attachments[${index}].resourceType`);
    if (resourceType !== "invoice") {
      throw new Cp2Error(
        400,
        "EMAIL_ATTACHMENT_UNAVAILABLE",
        "Only trusted invoice resources can currently be attached to email."
      );
    }
    return {
      resourceType,
      resourceId: parseString(record.resourceId, `attachments[${index}].resourceId`)
    };
  });
}
