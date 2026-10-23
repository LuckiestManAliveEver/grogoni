import { computerWorkerFromEnvironment } from "./computer-runtime/client.js";
import { positiveIntegerFromEnv } from "@grogoni/resource-control";
import { repositoryDefaultRuntimePolicy } from "@grogoni/shared-types";
import { createOpenRouterRuntime } from "./inference/openrouter-runtime.js";
import { readAccountDeletionProcessors } from "./cp2/account-deletion-processors.js";
import { createEmailProviderFromEnvironment } from "./cp2/email-provider.js";
import { createNetworkInviteSenderFromEnvironment } from "./cp2/network-invite-provider.js";
import { createWebPushSender, readWebPushConfiguration } from "./cp2/push.js";
import type { Cp2Store, Cp2StoreOptions } from "./cp2/store.js";
import {
  createPostgresFulfillmentService,
  fulfillmentDepsFromStore,
  type FulfillmentService
} from "./cp2/domains/fulfillment/service.js";
import type { Pool } from "pg";
import { createChannelGatewayFromEnvironment } from "./messaging/channel-gateway.js";
import { createEmailMailboxProviderClient } from "./messaging/email-provider-client.js";

/**
 * The outbound providers a Cp2Store needs to have side effects outside the database: web push,
 * encrypted-message email notices, network invites, the channel gateway (SMS/WhatsApp), connected
 * mailboxes, and account-deletion processors. The long-running API builds exactly these from the
 * environment (services/api/src/index.ts); an Edge store built without them silently skips every
 * push and email it should send. Each provider is configured by the same environment variables on
 * both runtimes and is omitted, as there, when its variables are unset.
 */
export function createEdgeStoreDependencies(
  environment: NodeJS.ProcessEnv = process.env
): Pick<
  Cp2StoreOptions,
  | "pushNotificationSender"
  | "messageEmailNotificationSender"
  | "networkInviteSender"
  | "channelGateway"
  | "emailMailboxProviderClient"
  | "accountDeletionProcessors"
  | "messageWebBaseUrl"
  | "configuredModels"
  | "modelRuntimeAdapterResolver"
  | "platformDefaultRuntime"
  | "computerWorkerClient"
> {
  const computerWorkerClient = computerWorkerFromEnvironment(environment);
  const webPush = readWebPushConfiguration();
  const emailProvider = createEmailProviderFromEnvironment(environment);
  const networkInviteSender = createNetworkInviteSenderFromEnvironment(environment);
  const accountDeletionProcessors = readAccountDeletionProcessors(environment);
  return {
    ...(computerWorkerClient ? { computerWorkerClient } : {}),
    configuredModels: createOpenRouterRuntime(environment).catalog(),
    modelRuntimeAdapterResolver: createOpenRouterRuntime(environment).resolve,
    platformDefaultRuntime: repositoryDefaultRuntimePolicy,
    ...(webPush === null ? {} : { pushNotificationSender: createWebPushSender(webPush) }),
    messageEmailNotificationSender:
      emailProvider.sendEncryptedMessageNotification.bind(emailProvider),
    ...(networkInviteSender === undefined ? {} : { networkInviteSender }),
    channelGateway: createChannelGatewayFromEnvironment(environment),
    emailMailboxProviderClient: createEmailMailboxProviderClient(environment),
    ...(accountDeletionProcessors.length === 0 ? {} : { accountDeletionProcessors }),
    messageWebBaseUrl: (environment.WEB_PUBLIC_URL ?? "https://grogoni.com").trim()
  };
}

/**
 * The fulfillment service exactly as the Node API builds it (services/api/src/index.ts): outbox
 * events are handed to the store's notifier, and idempotency records keep the configured
 * retention. Without deliverOutboxEvent the outbox job marks events delivered without sending the
 * customer's "scheduled" / "delivered" notifications, and nothing retries them.
 */
export function createEdgeFulfillmentService(
  pool: Pool,
  store: Cp2Store,
  idempotencyRetentionHours: number
): FulfillmentService {
  return createPostgresFulfillmentService({
    pool,
    deps: fulfillmentDepsFromStore(store),
    idempotencyRetentionHours,
    deliverOutboxEvent: (event) => store.deliverFulfillmentNotification(event)
  });
}

/**
 * FULFILLMENT_IDEMPOTENCY_RETENTION_HOURS, parsed as the Node API parses it: an invalid value is
 * an error, not a silent default. Read it once at startup so a bad value fails the domain's start
 * (and readiness) instead of every request.
 */
export function readFulfillmentRetentionHours(environment: NodeJS.ProcessEnv = process.env) {
  return positiveIntegerFromEnv("FULFILLMENT_IDEMPOTENCY_RETENTION_HOURS", 24, environment);
}
