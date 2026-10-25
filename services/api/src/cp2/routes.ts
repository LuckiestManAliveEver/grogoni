import { registerAgentSkillsRoutes } from "./domains/agent-skills/routes.js";
import { registerOfflineRuntimeRoutes } from "./offline-runtime-routes.js";
import { registerChatImageRoutes } from "./chat-image-routes.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BusinessPermission } from "@grogoni/business-core";
import type {
  AuthChannel,
  ShopPresenceStatus,
  SyncMutationPayload,
  SyncMutationType,
  GrogoniChatSurface,
  GrogoniMode,
  SyncRealtimeReadyEvent,
  InferenceRequest,
  OwnerInferenceNodeMessage,
  RuntimeRegistryProviderId
} from "@grogoni/shared-types";
import { getStoreLinks } from "@grogoni/shared-types";
import { isSyncMutationType } from "@grogoni/sync-core";
import {
  clearRefreshCookie,
  clearSessionCookie,
  Cp2Error,
  createCp2Store,
  isSupportedLanguage,
  readRefreshCookie,
  readSessionCookie,
  serializeRefreshCookie,
  serializeSessionCookie,
  type Cp2Store
} from "./store.js";
import {
  enforceAuthIpRate,
  parseAuthChannel,
  parseBoolean,
  parseContactRecordBody,
  parseIntegerString,
  parseIsoTimestamp,
  parseNullableString,
  parseOptionalNonNegativeInteger,
  parseOptionalString,
  parsePositiveInteger,
  parseRequestBody,
  parseString,
  readDeviceSessionMetadata,
  sendCp2Error,
  setAuthSessionCookies,
  type BusinessParams,
  type StorefrontParams
} from "./route-helpers.js";
import {
  parseLogisticsBody,
  parseLogisticsStatusBody,
  registerLogisticsRoutes
} from "./domains/logistics/routes.js";
import { registerNotificationsRoutes } from "./domains/notifications/routes.js";
import { registerPasskeysRoutes } from "./domains/passkeys/routes.js";
import { registerNetworkRoutes } from "./domains/network/routes.js";
import { registerCommercialRecordsRoutes } from "./domains/commercial-records/routes.js";
import { registerFulfillmentRoutes } from "./domains/fulfillment/routes.js";
import {
  createUnavailableFulfillmentService,
  type FulfillmentService
} from "./domains/fulfillment/service.js";
import { registerSuppliersRoutes } from "./domains/suppliers/routes.js";
import { registerDocumentImportsRoutes } from "./domains/document-imports/routes.js";
import { registerCatalogueSharingRoutes } from "./domains/catalogue-sharing/routes.js";
import { registerCommerceRoutes } from "./domains/commerce/routes.js";
import { registerOAuthRoutes } from "./domains/oauth/routes.js";
import { registerExternalConnectionsRoutes } from "./domains/external-connections/routes.js";
import {
  registerInferenceProviderRoutes,
  registerInferenceRuntimeRoutes
} from "./domains/inference-providers/routes.js";
import { registerComplianceRoutes } from "./domains/compliance/routes.js";
import {
  parseInvoiceBody,
  parsePaymentBody,
  parseProductBody,
  parseStockAdjustmentBody,
  registerSalesRoutes
} from "./domains/sales/routes.js";
import { registerAgentRuntimeRoutes } from "./domains/agent-runtime/routes.js";
import {
  registerBusinessTaskRoutes,
  type BusinessTaskStore
} from "./domains/agent-runtime/business-task-routes.js";
import { registerRuntimeHandoffRoutes } from "./domains/runtime-handoff/routes.js";
import { registerComputerRuntimeRoutes } from "./domains/computer-runtime/routes.js";
import { registerMessagingRoutes } from "./domains/messaging/routes.js";
import { registerOtpRoutes } from "./domains/otp/routes.js";
import { registerStaffRoutes } from "./domains/staff/routes.js";
import { registerShopHubRoutes } from "./domains/shop-hub/routes.js";
import { registerDeviceBootstrapRoutes } from "./domains/device-bootstrap/routes.js";
import { registerModelTemplateRoutes } from "./domains/model-templates/routes.js";
import { createEmailProviderFromEnvironment, type EmailProvider } from "./email-provider.js";
import {
  normalizeInternationalOwnerPhoneNumber,
  normalizeOwnerPhoneNumber
} from "./phone-identity.js";
import type { BinaryUploadPipeline } from "./binary-upload-pipeline.js";
import type { OwnerNodeBroker } from "../inference/owner-node-broker.js";
import { readAuthRuntimeConfig } from "./auth-runtime-config.js";
import { registerRuntimeRegistryRoutes } from "./runtime-registry/routes.js";
import { createGrogoniCatalogRegistryAdapter } from "./runtime-registry/grogoni-adapter.js";
import { createRuntimeRegistrySearchService } from "./runtime-registry/search.js";
import { createRuntimeRegistryImportService } from "./runtime-registry/import-service.js";
import {
  createMemoryRuntimeRegistryImportStore,
  type RuntimeRegistryImportStore
} from "./runtime-registry/import-store.js";
import type { RuntimeRegistryAdapter } from "./runtime-registry/types.js";
import { HttpComputerWorkerClient } from "../computer-runtime/client.js";
import type { InventoryTaskController } from "./domains/agent-runtime/inventory-task-controller.js";

export interface Cp2RouteOptions {
  inventoryTaskController?: InventoryTaskController;
  businessTaskStore?: BusinessTaskStore;
  binaryUploadPipeline?: BinaryUploadPipeline;
  emailProvider?: EmailProvider;
  oauthAllowedRedirectOrigins?: string[];
  ownerNodeBroker?: OwnerNodeBroker;
  realtimeAllowedOrigins?: string[];
  /** Defaults to an in-memory store; pass a Postgres-backed one
   *  (createPostgresRuntimeRegistryImportStore) in a deployment that persists imports. */
  runtimeRegistryImportStore?: RuntimeRegistryImportStore;
  /** Postgres-authoritative corridor fulfillment (docs/architecture/corridor-fulfillment.md).
   *  Omitted in memory mode, where every fulfillment route answers 503
   *  fulfillment_requires_postgres. */
  fulfillmentService?: FulfillmentService;
  store?: Cp2Store;
  vapidPublicKey?: string;
  /** Origin the web PWA is actually served from - used only to build the universal `/s/:slug`
   *  redirect's absolute Location header (docs/architecture/grogoni-id-slug-system.md). Reuses the
   *  same value/env var (`WEB_PUBLIC_URL`) services/api/src/index.ts already threads through for
   *  message links, rather than introducing a second "where is the web app" setting. */
  webPublicUrl?: string;
  /** For `getStoreLinks()`'s `telegram` field in the rename endpoint's response - reuses
   *  `TELEGRAM_BOT_USERNAME`, the same env var `TelegramChannelAdapter` already reads
   *  (services/api/src/messaging/channel-gateway.ts). Empty string when Telegram isn't
   *  configured, matching that adapter's own convention. */
  telegramBotUsername?: string;
}

interface SyncPullQuery {
  cursor?: string;
  limit?: string;
}

interface OwnerNodePresenceQuery {
  tenantId?: string;
  agentId?: string;
  modelId?: string;
}

interface PinBody {
  currentPin?: string;
  mfaCode?: string;
  pin?: string;
  pinConfirmation?: string;
}

interface PinLoginBody extends PinBody {
  channel?: string;
  contact?: string;
  country?: string;
  destination?: string;
  method?: string;
}

interface IdentifierBody {
  type?: string;
  identifier?: string;
  country?: string;
}

interface CreateBusinessBody {
  name?: string;
  language?: string;
  phoneCountry?: string;
  phoneNumber?: string;
}

interface OwnerPhoneBody {
  country?: string;
  phoneNumber?: string;
}

interface DisplayNameBody {
  displayName?: string;
}

interface RoleCheckBody {
  businessId?: string;
  role?: string;
  permission?: string;
}

interface GrogoniIdRenameBody {
  handle?: string;
}

interface SessionContextBody {
  mode?: string;
  activeShopId?: string | null;
  activeSurface?: string;
  conversationId?: string;
  expectedSessionVersion?: number;
}

interface SessionContextQuery {
  conversationId?: string;
}

interface MarketplaceIntroBody {
  businessId?: string | null;
}

interface PublicStorefrontSearchQuery {
  search?: string;
  limit?: string;
}

interface ShopPresenceBody {
  status?: string;
  catalogueShareable?: boolean;
}

interface NetworkInviteContactBody {
  name?: string;
  phone?: string | null;
  email?: string | null;
}

interface NetworkInvitesBody {
  contacts?: NetworkInviteContactBody[];
  defaultCountry?: string;
}

interface SyncQueueParams extends BusinessParams {
  syncItemId: string;
}

interface SyncMutationBody {
  idempotencyKey?: string;
  mutationType?: string;
  clientCreatedAt?: string;
  payload?: unknown;
}

interface AccountDeletionBody {
  confirmation?: string;
  reason?: string | null;
}

interface ShopDeletionRequestBody {
  shopId?: string;
}

interface ShopDeletionFinalizeBody {
  acknowledgement?: boolean;
  idempotencyKey?: string | null;
  pin?: string;
}

interface ShopDeletionParams extends BusinessParams {
  requestId: string;
}

interface AccountRestorationParams {
  requestId: string;
}

export function registerCp2Routes(app: FastifyInstance, options: Cp2RouteOptions = {}): Cp2Store {
  const computerRuntimeUrl = process.env.COMPUTER_RUNTIME_URL?.trim();
  const computerRuntimeToken = process.env.COMPUTER_RUNTIME_SERVICE_TOKEN?.trim();
  const store =
    options.store ??
    createCp2Store({
      ...(computerRuntimeUrl && computerRuntimeToken
        ? {
            computerWorkerClient: new HttpComputerWorkerClient(
              computerRuntimeUrl,
              computerRuntimeToken
            )
          }
        : {})
    });
  const webPublicUrl = (options.webPublicUrl ?? "https://grogoni.com").replace(/\/+$/u, "");
  registerChatImageRoutes(app, store);
  const telegramBotUsername = options.telegramBotUsername ?? "";
  const binaryUploadPipeline = options.binaryUploadPipeline;
  const runtimeRegistryAdapters: Partial<
    Record<RuntimeRegistryProviderId, RuntimeRegistryAdapter>
  > = {
    grogoni: createGrogoniCatalogRegistryAdapter({
      listModels: () => store.listModelCatalog(),
      listAgents: () => store.listAgentCatalog()
    })
  };
  const runtimeRegistrySearchService = createRuntimeRegistrySearchService({
    adapters: runtimeRegistryAdapters
  });
  const runtimeRegistryImportStore =
    options.runtimeRegistryImportStore ?? createMemoryRuntimeRegistryImportStore();
  const runtimeRegistryImportService = createRuntimeRegistryImportService({
    store: runtimeRegistryImportStore,
    adapters: runtimeRegistryAdapters
  });
  const emailProvider = options.emailProvider ?? createEmailProviderFromEnvironment();
  const oauthAllowedRedirectOrigins = new Set(options.oauthAllowedRedirectOrigins ?? []);
  const realtimeAllowedOrigins = new Set(options.realtimeAllowedOrigins ?? []);
  const authRuntime = readAuthRuntimeConfig(realtimeAllowedOrigins);
  const authAttemptsByIp = new Map<string, number[]>();

  function requireAuthFeature(enabled: boolean, code: string, message: string): void {
    if (!enabled) throw new Cp2Error(503, code, message);
  }

  function requirePhoneLogin(channel: AuthChannel): void {
    if (channel !== "phone")
      throw new Cp2Error(
        400,
        "phone_login_required",
        "Use your mobile phone number to sign up or log in. Email is reserved for backup recovery and MFA."
      );
  }

  function readIdentifier(body: IdentifierBody): { channel: AuthChannel; value: string } {
    const channel = parseAuthChannel(body.type);
    const identifier = parseString(body.identifier, "identifier");
    if (channel === "email") return { channel, value: identifier };
    try {
      const phone =
        body.country === undefined
          ? normalizeInternationalOwnerPhoneNumber(identifier)
          : normalizeOwnerPhoneNumber(identifier, parseString(body.country, "country"));
      return { channel, value: phone.e164 };
    } catch {
      throw new Cp2Error(400, "INVALID_PHONE_NUMBER", "Enter a valid phone number.");
    }
  }

  function normalizeAuthPhone(rawPhone: string, country?: string): string {
    try {
      return country === undefined
        ? normalizeInternationalOwnerPhoneNumber(rawPhone).e164
        : normalizeOwnerPhoneNumber(rawPhone, country).e164;
    } catch {
      throw new Cp2Error(400, "INVALID_PHONE_NUMBER", "Enter a valid phone number.");
    }
  }

  app.post("/auth/identify", async (request: FastifyRequest<{ Body: IdentifierBody }>, reply) => {
    try {
      readIdentifier(request.body);
      return reply.code(410).send({
        code: "auth_method_discovery_replaced",
        message: "Use the enumeration-safe login method endpoint."
      });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post(
    "/auth/login/methods",
    async (request: FastifyRequest<{ Body: IdentifierBody }>, reply) => {
      try {
        // Validate and normalize the identifier, but deliberately return the same capabilities
        // for known and unknown accounts to avoid an account-enumeration oracle.
        requirePhoneLogin(readIdentifier(request.body).channel);
        return {
          preferred: "pin",
          passkeyAvailable: authRuntime.passkeysEnabled,
          passwordFallback: authRuntime.passwordFallbackEnabled,
          recoveryAvailable: true,
          smsLogin: false
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/signup/start",
    async (request: FastifyRequest<{ Body: IdentifierBody }>, reply) => {
      try {
        enforceAuthIpRate(authAttemptsByIp, request, "signup_start", 10);
        requirePhoneLogin(parseAuthChannel(request.body.type ?? "phone"));
        const identifier = readIdentifier({ ...request.body, type: "phone" });
        if (
          store.identifyAccount({ channel: "phone", identifier: identifier.value }).next === "login"
        ) {
          throw new Cp2Error(409, "account_exists", "Continue to sign in.");
        }
        const transaction = store.beginPhoneSignup({
          phoneE164: identifier.value
        });
        return {
          ...transaction,
          verificationRequired: false
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/signup/complete",
    async (
      request: FastifyRequest<{
        Body: {
          transactionId?: string;
          displayName?: string;
          password?: string;
          passwordConfirmation?: string;
          email?: string;
          termsAccepted?: boolean;
          privacyAccepted?: boolean;
        };
      }>,
      reply
    ) => {
      try {
        requireAuthFeature(
          authRuntime.passwordFallbackEnabled,
          "password_fallback_disabled",
          "Password fallback is disabled."
        );
        // A real credential is required at signup - passkeys are an optional, later backup, not
        // the only way back into a new account. See docs/authentication/phone-first-authentication.md.
        const password = parseString(request.body.password, "password");
        const passwordConfirmation = parseOptionalString(request.body.passwordConfirmation);
        if (password !== passwordConfirmation)
          throw new Cp2Error(400, "password_confirmation_invalid", "Passwords do not match.");
        const result = store.completePhoneSignup({
          transactionId: parseString(request.body.transactionId, "transactionId"),
          displayName: parseString(request.body.displayName, "displayName"),
          password,
          ...(request.body.email === undefined ? {} : { email: request.body.email }),
          termsAccepted: request.body.termsAccepted === true,
          privacyAccepted: request.body.privacyAccepted === true
        });
        setAuthSessionCookies(reply, request, store, result.session.id);
        return result;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post("/auth/email/verification/start", async (request, reply) => {
    try {
      const identity = store.getPendingEmailIdentity({
        sessionId: readSessionCookie(request.headers.cookie)
      });
      const otp = store.requestOtp({
        channel: "email",
        destination: identity.normalizedValue,
        purpose: "signup"
      });
      await emailProvider.sendOtp({
        challengeId: otp.challengeId,
        code: otp.devOtp,
        expiresAt: otp.expiresAt,
        to: otp.destination
      });
      return {
        challengeId: otp.challengeId,
        expiresAt: otp.expiresAt,
        ...(emailProvider.exposesDevOtp ? { developmentCode: otp.devOtp } : {})
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post(
    "/auth/identity/email/start",
    async (request: FastifyRequest<{ Body: { email?: string } }>, reply) => {
      try {
        enforceAuthIpRate(authAttemptsByIp, request, "identity_email_start", 10);
        const upgrade = store.beginEmailIdentityUpgrade({
          sessionId: readSessionCookie(request.headers.cookie),
          email: parseString(request.body.email, "email")
        });
        const otp = store.requestOtp({
          channel: "email",
          destination: upgrade.kind === "link" ? upgrade.identity.normalizedValue : upgrade.email,
          purpose: upgrade.kind === "merge" ? "recovery" : "signup"
        });
        if (upgrade.kind === "merge") {
          store.beginEmailIdentityMerge({
            sessionId: readSessionCookie(request.headers.cookie),
            email: upgrade.email,
            targetAccountId: upgrade.targetAccountId,
            challengeId: otp.challengeId
          });
        }
        await emailProvider.sendOtp({
          challengeId: otp.challengeId,
          code: otp.devOtp,
          expiresAt: otp.expiresAt,
          to: otp.destination
        });
        return {
          challengeId: otp.challengeId,
          expiresAt: otp.expiresAt,
          mergeRequired: upgrade.kind === "merge",
          ...(emailProvider.exposesDevOtp ? { developmentCode: otp.devOtp } : {})
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/email/verification/verify",
    async (request: FastifyRequest<{ Body: { challengeId?: string; code?: string } }>, reply) => {
      try {
        return store.verifyPendingEmail({
          sessionId: readSessionCookie(request.headers.cookie),
          challengeId: parseString(request.body.challengeId, "challengeId"),
          code: parseString(request.body.code, "code")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/identity/email/verify",
    async (request: FastifyRequest<{ Body: { challengeId?: string; code?: string } }>, reply) => {
      try {
        return store.verifyPendingEmail({
          sessionId: readSessionCookie(request.headers.cookie),
          challengeId: parseString(request.body.challengeId, "challengeId"),
          code: parseString(request.body.code, "code")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/identity/email/merge/verify",
    async (request: FastifyRequest<{ Body: { challengeId?: string; code?: string } }>, reply) => {
      try {
        const result = store.verifyEmailIdentityMerge({
          sessionId: readSessionCookie(request.headers.cookie),
          challengeId: parseString(request.body.challengeId, "challengeId"),
          code: parseString(request.body.code, "code")
        });
        const { refreshToken, ...session } = result;
        store.prepareDeviceSession(session.session.id, readDeviceSessionMetadata(request));
        reply.header("set-cookie", [
          serializeSessionCookie(session.session.id),
          serializeRefreshCookie(refreshToken)
        ]);
        return session;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/login/password",
    async (request: FastifyRequest<{ Body: IdentifierBody & { password?: string } }>, reply) => {
      try {
        requireAuthFeature(
          authRuntime.passwordFallbackEnabled,
          "password_fallback_disabled",
          "Password fallback is disabled."
        );
        enforceAuthIpRate(authAttemptsByIp, request, "password_login", 30);
        const identifier = readIdentifier(request.body);
        requirePhoneLogin(identifier.channel);
        const result = store.loginWithPassword({
          channel: identifier.channel,
          identifier: identifier.value,
          password: parseString(request.body.password, "password")
        });
        if (result.mfaRequired) return reply.code(202).send(result);
        setAuthSessionCookies(reply, request, store, result.session.session.id);
        return result.session;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post("/auth/mfa/totp/setup", async (request, reply) => {
    try {
      return store.setupTotp({ sessionId: readSessionCookie(request.headers.cookie) });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.get("/auth/mfa/factors", async (request, reply) => {
    try {
      return {
        factors: store.listMfaFactors({ sessionId: readSessionCookie(request.headers.cookie) })
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post(
    "/auth/mfa/totp/confirm",
    async (request: FastifyRequest<{ Body: { factorId?: string; code?: string } }>, reply) => {
      try {
        return store.confirmTotp({
          sessionId: readSessionCookie(request.headers.cookie),
          factorId: parseString(request.body.factorId, "factorId"),
          code: parseString(request.body.code, "code")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/mfa/challenge",
    async (request: FastifyRequest<{ Body: { transactionId?: string } }>, reply) => {
      try {
        const transaction = store.getAuthTransaction(
          parseString(request.body.transactionId, "transactionId"),
          "login_mfa"
        );
        return {
          transactionId: transaction.id,
          factors: ["totp", "recovery_code"],
          expiresAt: transaction.expiresAt
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/mfa/verify",
    async (
      request: FastifyRequest<{ Body: { transactionId?: string; factor?: string; code?: string } }>,
      reply
    ) => {
      try {
        const factor = parseString(request.body.factor, "factor");
        if (factor !== "totp" && factor !== "recovery_code" && factor !== "email")
          throw new Cp2Error(400, "mfa_factor_invalid", "MFA factor is invalid.");
        const result = store.verifyMfa({
          transactionId: parseString(request.body.transactionId, "transactionId"),
          factor,
          code: parseString(request.body.code, "code")
        });
        setAuthSessionCookies(reply, request, store, result.session.id);
        return result;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/mfa/email/challenge",
    async (request: FastifyRequest<{ Body: { transactionId?: string } }>, reply) => {
      try {
        enforceAuthIpRate(authAttemptsByIp, request, "email_mfa", 10);
        const otp = store.beginEmailMfa({
          transactionId: parseString(request.body.transactionId, "transactionId")
        });
        await emailProvider.sendOtp({
          challengeId: otp.challengeId,
          code: otp.devOtp,
          expiresAt: otp.expiresAt,
          to: otp.destination
        });
        return {
          expiresAt: otp.expiresAt,
          ...(emailProvider.exposesDevOtp ? { developmentCode: otp.devOtp } : {})
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/password/recover/passkey",
    async (
      request: FastifyRequest<{ Body: { password?: string; passwordConfirmation?: string } }>,
      reply
    ) => {
      try {
        const password = parseString(request.body.password, "password");
        if (password !== request.body.passwordConfirmation)
          throw new Cp2Error(400, "password_confirmation_invalid", "Passwords do not match.");
        const result = store.recoverPasswordWithPasskey({
          sessionId: readSessionCookie(request.headers.cookie),
          password
        });
        setAuthSessionCookies(reply, request, store, result.session.id);
        return result;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post("/auth/mfa/recovery-codes/regenerate", async (request, reply) => {
    try {
      return store.regenerateMfaRecoveryCodes({
        sessionId: readSessionCookie(request.headers.cookie)
      });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.delete(
    "/auth/mfa/factors/:factorId",
    async (
      request: FastifyRequest<{ Params: { factorId: string }; Body: { code?: string } }>,
      reply
    ) => {
      try {
        return store.disableMfaFactor({
          sessionId: readSessionCookie(request.headers.cookie),
          factorId: parseString(request.params.factorId, "factorId"),
          code: parseString(request.body?.code, "code")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/recovery/start",
    async (request: FastifyRequest<{ Body: IdentifierBody }>, reply) => {
      try {
        enforceAuthIpRate(authAttemptsByIp, request, "recovery_challenge", 10);
        const identifier = readIdentifier(request.body);
        if (identifier.channel === "phone") {
          throw new Cp2Error(
            400,
            "phone_recovery_unavailable",
            "Phone and SMS recovery are unavailable. Use a passkey, password, or linked verified email."
          );
        }
        const otp = store.requestOtp({
          channel: "email",
          destination: identifier.value,
          purpose: "recovery"
        });
        const transaction = store.beginRecovery({
          channel: "email",
          identifier: identifier.value,
          providerChallengeId: otp.challengeId,
          expiresAt: otp.expiresAt
        });
        if (transaction.accountFound)
          await emailProvider.sendOtp({
            challengeId: otp.challengeId,
            code: otp.devOtp,
            expiresAt: otp.expiresAt,
            to: otp.destination
          });
        return {
          message: "If an account matches those details, recovery instructions have been sent.",
          transactionId: transaction.transactionId,
          ...(emailProvider.exposesDevOtp ? { developmentCode: otp.devOtp } : {})
        };
      } catch (error) {
        if (error instanceof Cp2Error) return sendCp2Error(reply, error);
        return sendCp2Error(
          reply,
          new Cp2Error(503, "recovery_unavailable", "Account recovery is temporarily unavailable.")
        );
      }
    }
  );

  app.post(
    "/auth/recovery/verify",
    async (request: FastifyRequest<{ Body: { transactionId?: string; code?: string } }>, reply) => {
      try {
        const transactionId = parseString(request.body.transactionId, "transactionId");
        const transaction = store.getAuthTransaction(transactionId, "recovery");
        const code = parseString(request.body.code, "code");
        if (transaction.identifierType !== "email" || transaction.providerChallengeId === null)
          throw new Cp2Error(401, "recovery_verification_invalid", "Recovery verification failed.");
        return store.verifyEmailRecovery({
          transactionId,
          challengeId: transaction.providerChallengeId,
          code
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/recovery/reset-password",
    async (
      request: FastifyRequest<{
        Body: {
          transactionId?: string;
          password?: string;
          passwordConfirmation?: string;
          mfaCode?: string;
        };
      }>,
      reply
    ) => {
      try {
        requireAuthFeature(
          authRuntime.passwordFallbackEnabled,
          "password_fallback_disabled",
          "Password fallback is disabled."
        );
        const password = parseString(request.body.password, "password");
        if (password !== request.body.passwordConfirmation)
          throw new Cp2Error(400, "password_confirmation_invalid", "Passwords do not match.");
        const result = store.resetRecoveredPassword({
          transactionId: parseString(request.body.transactionId, "transactionId"),
          password,
          ...(request.body.mfaCode === undefined ? {} : { mfaCode: request.body.mfaCode })
        });
        setAuthSessionCookies(reply, request, store, result.session.id);
        return result;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/password/setup",
    async (
      request: FastifyRequest<{
        Body: {
          currentPin?: string;
          password?: string;
          passwordConfirmation?: string;
          mfaCode?: string;
        };
      }>,
      reply
    ) => {
      try {
        requireAuthFeature(
          authRuntime.passwordFallbackEnabled,
          "password_fallback_disabled",
          "Password fallback is disabled."
        );
        enforceAuthIpRate(authAttemptsByIp, request, "password_setup", 10);
        const password = parseString(request.body.password, "password");
        if (password !== request.body.passwordConfirmation)
          throw new Cp2Error(400, "password_confirmation_invalid", "Passwords do not match.");
        return store.createPassword({
          sessionId: readSessionCookie(request.headers.cookie),
          password,
          ...(request.body.currentPin === undefined
            ? {}
            : { currentPin: parseString(request.body.currentPin, "currentPin") }),
          ...(request.body.mfaCode === undefined ? {} : { mfaCode: request.body.mfaCode })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/auth/password/change",
    async (
      request: FastifyRequest<{
        Body: {
          currentPassword?: string;
          password?: string;
          passwordConfirmation?: string;
          mfaCode?: string;
          revokeOtherSessions?: boolean;
        };
      }>,
      reply
    ) => {
      try {
        requireAuthFeature(
          authRuntime.passwordFallbackEnabled,
          "password_fallback_disabled",
          "Password fallback is disabled."
        );
        enforceAuthIpRate(authAttemptsByIp, request, "password_change", 10);
        const password = parseString(request.body.password, "password");
        if (password !== request.body.passwordConfirmation)
          throw new Cp2Error(400, "password_confirmation_invalid", "Passwords do not match.");
        return store.changePassword({
          sessionId: readSessionCookie(request.headers.cookie),
          currentPassword: parseString(request.body.currentPassword, "currentPassword"),
          password,
          ...(request.body.mfaCode === undefined ? {} : { mfaCode: request.body.mfaCode }),
          ...(request.body.revokeOtherSessions === undefined
            ? {}
            : { revokeOtherSessions: request.body.revokeOtherSessions })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  registerOtpRoutes(app, store, emailProvider);

  registerPasskeysRoutes(app, store, authRuntime);

  registerOAuthRoutes(app, store, oauthAllowedRedirectOrigins);

  registerExternalConnectionsRoutes(app, store, authAttemptsByIp);
  registerInferenceProviderRoutes(app, store);
  registerInferenceRuntimeRoutes(app, store);

  app.post("/auth/pin/setup", async (request: FastifyRequest<{ Body: PinBody }>, reply) => {
    try {
      enforceAuthIpRate(authAttemptsByIp, request, "pin_setup", 10);
      const pin = parseString(request.body.pin, "pin");
      if (request.body.pinConfirmation !== undefined && pin !== request.body.pinConfirmation) {
        throw new Cp2Error(400, "pin_confirmation_invalid", "PINs do not match.");
      }
      const result = store.setAccountPin({
        sessionId: readSessionCookie(request.headers.cookie),
        pin,
        ...(request.body.mfaCode === undefined ? {} : { mfaCode: request.body.mfaCode })
      });
      setAuthSessionCookies(reply, request, store, result.session.id);
      return result;
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post("/auth/pin/change", async (request: FastifyRequest<{ Body: PinBody }>, reply) => {
    try {
      enforceAuthIpRate(authAttemptsByIp, request, "pin_change", 10);
      const pin = parseString(request.body.pin, "pin");
      if (pin !== request.body.pinConfirmation) {
        throw new Cp2Error(400, "pin_confirmation_invalid", "PINs do not match.");
      }
      return store.changeAccountPin({
        sessionId: readSessionCookie(request.headers.cookie),
        currentPin: parseString(request.body.currentPin, "currentPin"),
        pin,
        ...(request.body.mfaCode === undefined ? {} : { mfaCode: request.body.mfaCode })
      });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  registerDeviceBootstrapRoutes(app, store, authAttemptsByIp);

  app.post("/auth/pin/signup", async (request: FastifyRequest<{ Body: PinLoginBody }>, reply) => {
    try {
      enforceAuthIpRate(authAttemptsByIp, request, "pin_signup", 10);
      const channel = parseAuthChannel(request.body.method ?? request.body.channel ?? "phone");

      if (channel !== "phone") {
        throw new Cp2Error(400, "phone_pin_signup_only", "PIN signup requires a phone number.");
      }

      const rawDestination = parseString(
        request.body.contact ?? request.body.destination,
        "contact"
      );
      const destination = normalizeAuthPhone(
        rawDestination,
        request.body.country === undefined
          ? undefined
          : parseString(request.body.country, "country")
      );
      const result = store.signupWithPhonePin({
        destination,
        pin: parseString(request.body.pin, "pin")
      });
      setAuthSessionCookies(reply, request, store, result.session.id);
      return result;
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  // Single phone + PIN entry point: creates the account on first use, signs in on return
  // visits, and tells an existing passkey/password account to use that method instead of
  // silently repurposing whatever 4 digits were typed as a new credential.
  app.post("/auth/pin/continue", async (request: FastifyRequest<{ Body: PinLoginBody }>, reply) => {
    try {
      enforceAuthIpRate(authAttemptsByIp, request, "pin_continue", 10);
      const channel = parseAuthChannel(request.body.method ?? request.body.channel ?? "phone");
      requirePhoneLogin(channel);
      const rawDestination = parseString(
        request.body.contact ?? request.body.destination,
        "contact"
      );
      const destination =
        channel === "phone"
          ? normalizeAuthPhone(
              rawDestination,
              request.body.country === undefined
                ? undefined
                : parseString(request.body.country, "country")
            )
          : rawDestination;
      const result = store.continueWithChannelPin({
        channel,
        destination,
        pin: parseString(request.body.pin, "pin")
      });
      const mfa = store.challengePinLoginMfa(result);
      if (mfa) return reply.code(202).send(mfa);
      setAuthSessionCookies(reply, request, store, result.session.id);
      return result;
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post("/auth/pin/store-login", async (_request, reply) =>
    reply
      .code(410)
      .send({ code: "phone_login_required", message: "Log in with your mobile phone number." })
  );

  app.get("/auth/pin/status", async (request, reply) => {
    try {
      return store.getAccountPinStatus({
        sessionId: readSessionCookie(request.headers.cookie)
      });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.get("/auth/credentials/status", async (request, reply) => {
    try {
      return store.getAccountCredentialStatus({
        sessionId: readSessionCookie(request.headers.cookie)
      });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post("/auth/pin/verify", async (request: FastifyRequest<{ Body: PinBody }>, reply) => {
    try {
      const pin = parseString(request.body.pin, "pin");
      return store.verifyAccountPin({
        sessionId: readSessionCookie(request.headers.cookie),
        pin
      });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post("/auth/pin/login", async (request: FastifyRequest<{ Body: PinLoginBody }>, reply) => {
    try {
      enforceAuthIpRate(authAttemptsByIp, request, "pin_login", 30);
      const channel = parseAuthChannel(request.body.method ?? request.body.channel);
      requirePhoneLogin(channel);
      const rawDestination = parseString(
        request.body.contact ?? request.body.destination,
        "contact"
      );
      const destination =
        channel !== "phone"
          ? rawDestination
          : normalizeAuthPhone(
              rawDestination,
              request.body.country === undefined
                ? undefined
                : parseString(request.body.country, "country")
            );
      const result = store.loginWithAccountPin({
        channel,
        destination,
        pin: parseString(request.body.pin, "pin")
      });
      const mfa = store.challengePinLoginMfa(result);
      if (mfa) return reply.code(202).send(mfa);
      request.log.info(
        {
          event: "auth.pin_verified",
          accountId: result.account.id,
          requestCorrelationId: request.id
        },
        "Owner PIN verified."
      );
      request.log.info(
        {
          event: "auth.session_created",
          accountId: result.account.id,
          sessionId: result.session.id,
          requestCorrelationId: request.id
        },
        "Owner session created."
      );
      setAuthSessionCookies(reply, request, store, result.session.id);
      return result;
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post("/auth/pin/recover", async (request: FastifyRequest<{ Body: PinBody }>, reply) => {
    try {
      const pin = parseString(request.body.pin, "pin");
      return store.recoverAccountPin({
        sessionId: readSessionCookie(request.headers.cookie),
        pin
      });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.get("/session", async (request, reply) => {
    const session = store.getSession(readSessionCookie(request.headers.cookie));

    if (session === null) {
      return reply.code(401).send({
        code: "auth_required",
        message: "Authentication is required."
      });
    }

    request.log.info(
      {
        event: "auth.authenticated_user_loaded",
        accountId: session.account.id,
        sessionId: session.session.id,
        requestCorrelationId: request.id
      },
      "Authenticated owner session loaded."
    );
    return session;
  });

  app.get("/auth/bootstrap", async (request, reply) => {
    const session = store.getSession(readSessionCookie(request.headers.cookie));
    if (session === null) {
      return reply.code(401).send({
        code: "auth_session_expired",
        message: "The access session must be refreshed."
      });
    }
    const deviceSession = store
      .listDeviceSessions(session.session.id)
      .find((candidate) => candidate.current);
    if (deviceSession === undefined) {
      return reply.code(401).send({
        code: "auth_session_expired",
        message: "The device session is no longer active."
      });
    }
    return { authenticated: true, ...session, deviceSession };
  });

  // "/session/refresh" is a legacy alias kept for existing clients. Fastify's shorthand route
  // typings do not accept an array of paths, so the two registrations below share this one
  // handler function instead - there is exactly one implementation, so they cannot silently
  // drift out of sync again.
  async function handleSessionRefresh(request: FastifyRequest, reply: FastifyReply) {
    try {
      const refreshed = store.refreshSessionCredential({
        refreshToken: readRefreshCookie(request.headers.cookie),
        metadata: readDeviceSessionMetadata(request)
      });
      reply.header("set-cookie", [
        serializeSessionCookie(refreshed.session.id),
        serializeRefreshCookie(refreshed.refreshToken)
      ]);
      return {
        authenticated: true,
        account: refreshed.account,
        user: refreshed.user,
        session: refreshed.session,
        deviceSession: refreshed.deviceSession
      };
    } catch (error) {
      if (error instanceof Cp2Error && error.statusCode === 401) {
        reply.header("set-cookie", [clearSessionCookie(), clearRefreshCookie()]);
        // Classified for operators without exposing anything beyond the same code already
        // returned to the client (never the token/cookie itself) - see auth-runtime-config.md
        // and the refresh-reuse grace period in Cp2Store.refreshSessionCredential.
        request.log.warn(
          { event: "auth.session_refresh_failed", code: error.code, requestId: request.id },
          "Session refresh rejected."
        );
      }
      return sendCp2Error(reply, error);
    }
  }
  app.post("/auth/session/refresh", handleSessionRefresh);
  app.post("/session/refresh", handleSessionRefresh);

  app.get("/auth/sessions", async (request, reply) => {
    try {
      return { sessions: store.listDeviceSessions(readSessionCookie(request.headers.cookie)) };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.get("/sessions", async (request, reply) => {
    try {
      return { sessions: store.listDeviceSessions(readSessionCookie(request.headers.cookie)) };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.delete(
    "/auth/sessions/:sessionId",
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply) => {
      try {
        const revoked = store.revokeDeviceSession({
          sessionId: readSessionCookie(request.headers.cookie),
          targetSessionId: parseString(request.params.sessionId, "sessionId")
        });
        if (revoked.current) {
          reply.header("set-cookie", [clearSessionCookie(), clearRefreshCookie()]);
        }
        return revoked;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.delete(
    "/sessions/:sessionId",
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply) => {
      try {
        const revoked = store.revokeDeviceSession({
          sessionId: readSessionCookie(request.headers.cookie),
          targetSessionId: parseString(request.params.sessionId, "sessionId")
        });
        if (revoked.current)
          reply.header("set-cookie", [clearSessionCookie(), clearRefreshCookie()]);
        return revoked;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get("/auth/session", async (request, reply) => {
    const session = store.getSession(readSessionCookie(request.headers.cookie));

    if (session === null) {
      return reply.code(401).send({
        code: "auth_required",
        message: "Authentication is required."
      });
    }

    return session;
  });

  app.get("/api/auth/session", async (request, reply) => {
    const session = store.getSession(readSessionCookie(request.headers.cookie));

    if (session === null) {
      return reply.code(401).send({
        code: "auth_required",
        message: "Authentication is required."
      });
    }

    return session;
  });

  app.get(
    "/v1/session/context",
    async (request: FastifyRequest<{ Querystring: SessionContextQuery }>, reply) => {
      try {
        const conversationId = parseOptionalString(request.query.conversationId);
        return store.getGrogoniSessionContext({
          sessionId: readSessionCookie(request.headers.cookie),
          ...(conversationId === undefined ? {} : { conversationId })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/v1/session/context",
    async (request: FastifyRequest<{ Body: SessionContextBody }>, reply) => {
      try {
        const expectedSessionVersion = parseOptionalNonNegativeInteger(
          request.body.expectedSessionVersion,
          "expectedSessionVersion"
        );
        const conversationId = parseOptionalString(request.body.conversationId);
        const mode = parseOptionalGrogoniMode(request.body.mode);
        const activeShopId = parseOptionalNullableString(request.body.activeShopId);
        const activeSurface = parseOptionalGrogoniChatSurface(request.body.activeSurface);
        return store.updateGrogoniSessionContext({
          sessionId: readSessionCookie(request.headers.cookie),
          ...(mode === undefined ? {} : { mode }),
          ...(activeShopId === undefined ? {} : { activeShopId }),
          ...(activeSurface === undefined ? {} : { activeSurface }),
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(expectedSessionVersion === undefined ? {} : { expectedSessionVersion })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get("/v1/shops", async (request, reply) => {
    try {
      return {
        shops: store.listAccountShops({
          sessionId: readSessionCookie(request.headers.cookie)
        })
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.get(
    "/v1/sync/changes",
    async (request: FastifyRequest<{ Querystring: SyncPullQuery }>, reply) => {
      try {
        const cursor = parseOptionalString(request.query.cursor) ?? null;
        const limit =
          request.query.limit === undefined
            ? undefined
            : parseIntegerString(request.query.limit, "limit");
        return store.pullSyncChanges({
          sessionId: readSessionCookie(request.headers.cookie),
          cursor,
          ...(limit === undefined ? {} : { limit })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/v1/realtime",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const origin = request.headers.origin;
        if (origin !== undefined && !realtimeAllowedOrigins.has(origin)) {
          return reply.code(403).send({ code: "realtime_origin_forbidden" });
        }
        if (store.getSession(readSessionCookie(request.headers.cookie)) === null) {
          return reply.code(401).send({ code: "session_required" });
        }
      }
    },
    (socket, request) => {
      const sessionId = readSessionCookie(request.headers.cookie);
      const session = store.getSession(sessionId);
      if (session === null) {
        socket.close(1008, "Session required");
        return;
      }

      let unsubscribe: () => void = () => undefined;
      const closeExpiredSession = () => {
        if (store.getSession(sessionId) !== null) {
          return false;
        }
        unsubscribe();
        socket.close(1008, "Session expired");
        return true;
      };
      unsubscribe = store.subscribeSyncChanges({
        sessionId,
        listener: (event) => {
          if (!closeExpiredSession() && socket.readyState === 1) {
            socket.send(JSON.stringify(event));
          }
        }
      });
      const ready: SyncRealtimeReadyEvent = {
        type: "realtime.ready",
        protocolVersion: 1,
        accountId: session.account.id,
        serverTime: new Date().toISOString()
      };
      socket.send(JSON.stringify(ready));
      const sessionTimer = setInterval(closeExpiredSession, 30_000);
      const cleanup = () => {
        clearInterval(sessionTimer);
        unsubscribe();
      };
      socket.once("close", cleanup);
      socket.once("error", cleanup);
    }
  );

  if (options.ownerNodeBroker !== undefined) {
    const ownerNodeBroker = options.ownerNodeBroker;
    app.get(
      "/v1/inference/owner-node/presence",
      async (request: FastifyRequest<{ Querystring: OwnerNodePresenceQuery }>, reply) => {
        const session = store.getSession(readSessionCookie(request.headers.cookie));
        if (session === null) {
          return reply.code(401).send({ code: "session_required" });
        }
        try {
          const tenantId = parseString(request.query.tenantId, "tenantId");
          const agentId = parseString(request.query.agentId, "agentId");
          const modelId = parseString(request.query.modelId, "modelId");
          if (
            !store
              .listAccountShops({ sessionId: session.session.id })
              .some((shop) => shop.business.id === tenantId)
          ) {
            return reply.code(403).send({ code: "inference_tenant_forbidden" });
          }
          return {
            reachable: ownerNodeBroker.isReachable({ tenantId, agentId, modelId })
          };
        } catch (error) {
          return sendCp2Error(reply, error);
        }
      }
    );

    app.get(
      "/v1/inference/owner-node",
      {
        websocket: true,
        preValidation: async (request, reply) => {
          const origin = request.headers.origin;
          if (origin !== undefined && !realtimeAllowedOrigins.has(origin)) {
            return reply.code(403).send({ code: "inference_origin_forbidden" });
          }
          if (store.getSession(readSessionCookie(request.headers.cookie)) === null) {
            return reply.code(401).send({ code: "session_required" });
          }
        }
      },
      (socket, request) => {
        const session = store.getSession(readSessionCookie(request.headers.cookie));
        if (session === null) {
          socket.close(1008, "Session required");
          return;
        }
        let registeredNodeId: string | null = null;
        socket.on("message", (raw) => {
          try {
            const message = JSON.parse(String(raw)) as OwnerInferenceNodeMessage;
            if (message.type === "inference.node.register") {
              if (
                !store
                  .listAccountShops({ sessionId: session.session.id })
                  .some((shop) => shop.business.id === message.presence.tenantId)
              ) {
                throw new Error("Tenant access is forbidden.");
              }
              const presence = ownerNodeBroker.register({
                ...message.presence,
                userId: session.user.id,
                send: (job) => socket.send(JSON.stringify({ type: "inference.job", job }))
              });
              registeredNodeId = presence.nodeId;
              socket.send(JSON.stringify({ type: "inference.node.ready", presence }));
              return;
            }
            if (message.type === "inference.node.heartbeat") {
              ownerNodeBroker.heartbeat(message.nodeId, session.user.id);
              return;
            }
            if (message.type === "inference.job.chunk") {
              ownerNodeBroker.acceptChunk({
                nodeId: message.nodeId,
                userId: session.user.id,
                jobToken: message.jobToken,
                sequence: message.sequence,
                chunk: message.chunk
              });
            }
          } catch {
            socket.close(1008, "Invalid owner-node message");
          }
        });
        const cleanup = () => {
          if (registeredNodeId !== null) {
            try {
              ownerNodeBroker.unregister(registeredNodeId, session.user.id);
            } catch {
              // The ephemeral node may already have expired.
            }
          }
        };
        socket.once("close", cleanup);
        socket.once("error", cleanup);
      }
    );

    app.post(
      "/v1/inference/owner-node/jobs",
      async (request: FastifyRequest<{ Body: InferenceRequest }>, reply) => {
        const session = store.getSession(readSessionCookie(request.headers.cookie));
        if (session === null) {
          return reply.code(401).send({ code: "session_required" });
        }
        try {
          const inferenceRequest = parseOwnerInferenceRequest(request.body);
          if (
            !store
              .listAccountShops({ sessionId: session.session.id })
              .some((shop) => shop.business.id === inferenceRequest.tenantId)
          ) {
            return reply.code(403).send({ code: "inference_tenant_forbidden" });
          }
          const dispatched = ownerNodeBroker.dispatch(inferenceRequest);
          reply.hijack();
          reply.raw.writeHead(200, {
            "content-type": "application/x-ndjson",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "x-inference-runtime": "owner-node"
          });
          for await (const chunk of dispatched.chunks) {
            reply.raw.write(`${JSON.stringify(chunk)}\n`);
          }
          reply.raw.end();
          return reply;
        } catch {
          if (!reply.sent) {
            return reply.code(503).send({
              code: "owner_node_unavailable",
              message: "The shop device is unavailable."
            });
          }
          reply.raw.end();
          return reply;
        }
      }
    );
  }

  app.get(
    "/v1/marketplace-intro",
    async (request: FastifyRequest<{ Querystring: MarketplaceIntroBody }>, reply) => {
      try {
        return store.getMarketplaceIntroState({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: parseNullableString(request.query.businessId)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/v1/marketplace-intro/complete",
    async (request: FastifyRequest<{ Body: MarketplaceIntroBody }>, reply) => {
      try {
        return store.completeMarketplaceIntro({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: parseNullableString(request.body.businessId)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  registerAgentSkillsRoutes(app, store);
  registerAgentRuntimeRoutes(app, store);
  registerBusinessTaskRoutes(
    app,
    store,
    options.businessTaskStore,
    undefined,
    options.inventoryTaskController
  );
  registerRuntimeHandoffRoutes(app, store);
  registerComputerRuntimeRoutes(app, store);
  registerModelTemplateRoutes(app, store);

  registerRuntimeRegistryRoutes(app, {
    searchService: runtimeRegistrySearchService,
    adapters: runtimeRegistryAdapters,
    importService: runtimeRegistryImportService,
    resolveContext(sessionId) {
      const session = store.getSession(sessionId);
      if (session === null) return { accountId: "", connected: false };
      const connections = store.listExternalConnections({ sessionId });
      return {
        accountId: session.account.id,
        connected: connections.some((connection) => connection.status === "connected")
      };
    },
    requireAccount(sessionId) {
      const session = store.getSession(sessionId);
      if (session === null) {
        throw new Cp2Error(401, "unauthenticated", "Sign in to import a runtime asset.");
      }
      return { accountId: session.account.id, userId: session.user.id };
    }
  });

  registerMessagingRoutes(app, store, oauthAllowedRedirectOrigins, options.vapidPublicKey);

  app.post("/auth/logout", async (request, reply) => {
    const revoked = store.logout(readSessionCookie(request.headers.cookie));
    reply.header("set-cookie", [clearSessionCookie(), clearRefreshCookie()]);
    return {
      revoked
    };
  });

  app.post("/logout", async (request, reply) => {
    const revoked = store.logout(readSessionCookie(request.headers.cookie));
    reply.header("set-cookie", [clearSessionCookie(), clearRefreshCookie()]);
    return { revoked };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const revoked = store.logout(readSessionCookie(request.headers.cookie));
    reply.header("set-cookie", [clearSessionCookie(), clearRefreshCookie()]);
    return {
      revoked
    };
  });

  app.post("/auth/logout-all", async (request, reply) => {
    const result = store.logoutAll(readSessionCookie(request.headers.cookie));
    reply.header("set-cookie", [clearSessionCookie(), clearRefreshCookie()]);
    return result;
  });

  app.post("/logout-all", async (request, reply) => {
    const result = store.logoutAll(readSessionCookie(request.headers.cookie));
    reply.header("set-cookie", [clearSessionCookie(), clearRefreshCookie()]);
    return result;
  });

  app.post("/api/auth/logout-all", async (request, reply) => {
    const result = store.logoutAll(readSessionCookie(request.headers.cookie));
    reply.header("set-cookie", [clearSessionCookie(), clearRefreshCookie()]);
    return result;
  });

  registerNetworkRoutes(app, store);

  app.post("/businesses", async (request: FastifyRequest<{ Body: CreateBusinessBody }>, reply) => {
    try {
      const name = parseString(request.body.name, "name");
      const language = parseLanguage(request.body.language);
      return store.createBusiness({
        sessionId: readSessionCookie(request.headers.cookie),
        name,
        language,
        ...(request.body.phoneNumber === undefined
          ? {}
          : { phoneNumber: request.body.phoneNumber }),
        ...(request.body.phoneCountry === undefined
          ? {}
          : { phoneCountry: request.body.phoneCountry })
      });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  // Explicit merchant-initiated storefront id (grogoniId) rename
  // (docs/architecture/grogoni-id-slug-system.md). Pinned by default at creation - this is the only
  // way it ever changes.
  app.put(
    "/businesses/:businessId/grogoni-id",
    async (
      request: FastifyRequest<{ Params: BusinessParams; Body: GrogoniIdRenameBody }>,
      reply
    ) => {
      try {
        const business = store.renameGrogoniId({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          handle: parseString(request.body.handle, "handle")
        });
        return {
          business,
          links: getStoreLinks(business.grogoniId, { webOrigin: webPublicUrl, telegramBotUsername })
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  // The channel-neutral fallback link (QR codes, flyers, anywhere the viewer's channel isn't
  // known) - resolves through the same shared resolver every channel uses, never a duplicate
  // lookup (docs/architecture/grogoni-id-slug-system.md).
  app.get("/s/:slug", async (request: FastifyRequest<{ Params: { slug: string } }>, reply) => {
    const resolution = store.resolveBusinessByGrogoniId(request.params.slug);
    if (resolution === null) {
      return reply.code(404).send({
        code: "storefront_not_found",
        message: "This storefront link is no longer valid."
      });
    }
    if (resolution.status === "stale") {
      return reply.code(410).send({
        code: "storefront_moved",
        message: "This shop has moved to a new storefront link.",
        redirectTo: publicAgentUrl(webPublicUrl, resolution.business.grogoniId)
      });
    }
    return reply.redirect(publicAgentUrl(webPublicUrl, resolution.business.grogoniId), 302);
  });

  app.put("/account/phone", async (request: FastifyRequest<{ Body: OwnerPhoneBody }>, reply) => {
    try {
      return store.updateOwnerPhone({
        sessionId: readSessionCookie(request.headers.cookie),
        phoneNumber: typeof request.body.phoneNumber === "string" ? request.body.phoneNumber : "",
        country: typeof request.body.country === "string" ? request.body.country : ""
      });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.put(
    "/account/display-name",
    async (request: FastifyRequest<{ Body: DisplayNameBody }>, reply) => {
      try {
        return store.updateOwnDisplayName({
          sessionId: readSessionCookie(request.headers.cookie),
          displayName: parseString(request.body.displayName, "displayName")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post("/roles/check", async (request: FastifyRequest<{ Body: RoleCheckBody }>, reply) => {
    try {
      const businessId = parseString(request.body.businessId, "businessId");
      const role = parseString(request.body.role, "role");
      const permission = parseOptionalPermission(request.body.permission);
      const input = {
        sessionId: readSessionCookie(request.headers.cookie),
        businessId,
        role
      };
      return permission === undefined
        ? store.checkRole(input)
        : store.checkRole({ ...input, permission });
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.get(
    "/public/storefronts",
    async (request: FastifyRequest<{ Querystring: PublicStorefrontSearchQuery }>, reply) => {
      try {
        const search = parseOptionalString(request.query.search);
        const limit =
          request.query.limit === undefined
            ? undefined
            : parseIntegerString(request.query.limit, "limit");
        return {
          storefronts: store.listPublicStorefronts({
            ...(search === undefined ? {} : { search }),
            ...(limit === undefined ? {} : { limit })
          })
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/public/storefronts/:agentId",
    async (request: FastifyRequest<{ Params: StorefrontParams }>, reply) => {
      try {
        return store.getPublicStorefront({
          agentId: parseString(request.params.agentId, "agentId")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/public/commerce-identities/availability",
    async (request: FastifyRequest<{ Querystring: { address?: string } }>, reply) => {
      try {
        return store.checkCommerceAddressAvailability(
          parseString(request.query.address, "address")
        );
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/public/commerce-identities/:address",
    async (request: FastifyRequest<{ Params: { address: string } }>, reply) => {
      try {
        const resolution = store.resolveCommerceIdentity(
          parseString(request.params.address, "address")
        );
        if (resolution === null) {
          return reply.code(404).send({
            code: "commerce_identity_not_found",
            message: "Commerce identity was not found."
          });
        }
        if (resolution.status === "stale") {
          return reply.code(410).send(resolution);
        }
        return resolution;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/presence",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.getShopPresence({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/presence",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: ShopPresenceBody }>, reply) => {
      try {
        const catalogueShareable =
          request.body.catalogueShareable === undefined
            ? undefined
            : parseBoolean(request.body.catalogueShareable, "catalogueShareable");
        return store.setShopPresence({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          status: parseShopPresenceStatus(request.body.status),
          ...(catalogueShareable === undefined ? {} : { catalogueShareable })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/network/invites",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listNetworkInvites({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/network/invites",
    async (
      request: FastifyRequest<{ Params: BusinessParams; Body: NetworkInvitesBody }>,
      reply
    ) => {
      try {
        const sessionId = readSessionCookie(request.headers.cookie);
        const defaultCountry = parseOptionalString(request.body.defaultCountry);
        const { invites, alreadyOnGrogoniCount, invalidCount } = store.createNetworkInvites({
          sessionId,
          businessId: request.params.businessId,
          contacts: parseNetworkInviteContacts(request.body.contacts),
          ...(defaultCountry === undefined ? {} : { defaultCountry })
        });
        return {
          invites: await store.deliverNetworkInvites({
            sessionId,
            businessId: request.params.businessId,
            inviteIds: invites.map((invite) => invite.id)
          }),
          alreadyOnGrogoniCount,
          invalidCount
        };
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  registerSalesRoutes(app, store);
  registerCatalogueSharingRoutes(app, store);
  registerStaffRoutes(app, store);
  registerOfflineRuntimeRoutes(app, store);

  registerSuppliersRoutes(app, store, binaryUploadPipeline);

  registerLogisticsRoutes(app, store);
  registerCommercialRecordsRoutes(app, store);
  const fulfillmentService = options.fulfillmentService ?? createUnavailableFulfillmentService();
  registerFulfillmentRoutes(app, store, fulfillmentService);
  registerShopHubRoutes(app, store, fulfillmentService);

  app.get(
    "/businesses/:businessId/reports/summary",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.getBusinessReport({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/knowledge",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.getBusinessKnowledge({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  registerNotificationsRoutes(app, store);

  app.get(
    "/businesses/:businessId/compliance/security-review",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.getSecurityReview({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/compliance/export",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.createDataExport({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/compliance/account-deletion",
    async (
      request: FastifyRequest<{ Params: BusinessParams; Body: AccountDeletionBody }>,
      reply
    ) => {
      try {
        const result = store.requestAccountDeletion({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          deletion: parseAccountDeletionBody(request.body)
        });
        reply.header("set-cookie", [clearSessionCookie(), clearRefreshCookie()]);
        return result;
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get("/account-restoration/requests", async (request, reply) => {
    try {
      return {
        requests: store.listRestorableAccountDeletions({
          sessionId: readSessionCookie(request.headers.cookie)
        })
      };
    } catch (error) {
      return sendCp2Error(reply, error);
    }
  });

  app.post(
    "/account-restoration/:requestId",
    async (request: FastifyRequest<{ Params: AccountRestorationParams; Body: PinBody }>, reply) => {
      try {
        return store.restoreAccountDeletion({
          sessionId: readSessionCookie(request.headers.cookie),
          requestId: parseString(request.params.requestId, "requestId"),
          pin: parseString(request.body.pin, "pin")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/shop-deletion/preview",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.getShopDeletionPreview({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/shop-deletion/request",
    async (
      request: FastifyRequest<{ Params: BusinessParams; Body: ShopDeletionRequestBody }>,
      reply
    ) => {
      try {
        return store.requestShopDeletion({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          shopId: parseString(request.body.shopId, "shopId")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/shop-deletion/:requestId/finalize",
    async (
      request: FastifyRequest<{ Params: ShopDeletionParams; Body: ShopDeletionFinalizeBody }>,
      reply
    ) => {
      try {
        const idempotencyKey = parseOptionalString(request.body.idempotencyKey);
        return store.finalizeShopDeletion({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          requestId: request.params.requestId,
          pin: parseString(request.body.pin, "pin"),
          acknowledgement: parseBoolean(request.body.acknowledgement, "acknowledgement"),
          ...(idempotencyKey === undefined ? {} : { idempotencyKey })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/shop-deletion/:requestId/restore",
    async (request: FastifyRequest<{ Params: ShopDeletionParams }>, reply) => {
      try {
        return store.restoreShopDeletion({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          requestId: request.params.requestId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  registerComplianceRoutes(app, store);

  app.get(
    "/businesses/:businessId/beta/readiness",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.getBetaReadiness({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/launch/readiness",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.getLaunchReadiness({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  registerDocumentImportsRoutes(app, store, binaryUploadPipeline);

  registerCommerceRoutes(app, store, binaryUploadPipeline);

  app.get(
    "/businesses/:businessId/offline-cache",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.getOfflineCache({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/sync-queue",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listSyncQueue({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/sync-queue",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: SyncMutationBody }>, reply) => {
      try {
        const body = parseSyncMutationBody(request.body);
        return store.enqueueSyncMutation({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          ...body
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/sync-queue/replay",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.replaySyncQueue({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/sync-queue/:syncItemId/replay",
    async (request: FastifyRequest<{ Params: SyncQueueParams }>, reply) => {
      try {
        return store.replaySyncQueueItem({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          syncItemId: request.params.syncItemId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  return store;
}

function parseSyncMutationBody(body: SyncMutationBody | null | undefined): {
  idempotencyKey: string;
  mutationType: SyncMutationType;
  clientCreatedAt?: string;
  payload: SyncMutationPayload;
} {
  const record = parseRequestBody(body);
  const idempotencyKey = parseString(record.idempotencyKey, "idempotencyKey");
  const mutationType = parseSyncMutationType(record.mutationType);
  const clientCreatedAt =
    record.clientCreatedAt === undefined
      ? undefined
      : parseIsoTimestamp(record.clientCreatedAt, "clientCreatedAt");
  const parsed = {
    idempotencyKey,
    mutationType,
    payload: parseSyncMutationPayload(mutationType, record.payload)
  };

  return clientCreatedAt === undefined ? parsed : { ...parsed, clientCreatedAt };
}

function parseSyncMutationType(value: unknown): SyncMutationType {
  if (typeof value === "string" && isSyncMutationType(value)) {
    return value;
  }

  throw new Cp2Error(400, "mutation_type_invalid", "Sync mutation type is not supported.");
}

function parseSyncMutationPayload(
  mutationType: SyncMutationType,
  value: unknown
): SyncMutationPayload {
  const payload = parseRequestBody(value);

  switch (mutationType) {
    case "product.create":
      return parseProductBody(payload);

    case "customer.create":
    case "supplier.create":
      return parseContactRecordBody(payload);

    case "inventory.adjust":
      return {
        productId: parseString(payload.productId, "payload.productId"),
        ...parseStockAdjustmentBody(payload)
      };

    case "invoice.create":
      return parseInvoiceBody(payload);

    case "invoice.confirm":
      return {
        invoiceId: parseString(payload.invoiceId, "payload.invoiceId")
      };

    case "payment.record":
      return parsePaymentBody(payload);

    case "logistics.create":
      return parseLogisticsBody(payload);

    case "logistics.update_status":
      return {
        logisticsId: parseString(payload.logisticsId, "payload.logisticsId"),
        ...parseLogisticsStatusBody(payload)
      };
  }
}

function parseLanguage(value: string | undefined) {
  if (value === undefined || !isSupportedLanguage(value)) {
    throw new Cp2Error(400, "language_invalid", "Language must be en or sw.");
  }

  return value;
}

/** Mirrors apps/web/src/routes.ts's `publicAgent`/`routeId` exactly (`/agent/${encodeURIComponent(id)}`)
 *  but as an absolute URL, since `GET /s/:slug` redirects across origins (grogoni ->
 *  the web app's own origin) rather than within one - services/api cannot import the web app's
 *  route module, so the same tiny path-building rule is replicated here rather than shared via a
 *  new cross-package dependency for one string template. */
function publicAgentUrl(webPublicUrl: string, grogoniId: string): string {
  return `${webPublicUrl}/agent/${encodeURIComponent(grogoniId)}`;
}

function parseAccountDeletionBody(body: AccountDeletionBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    confirmation: parseString(record.confirmation, "confirmation"),
    reason: parseNullableString(record.reason)
  };
}

function parseGrogoniMode(value: unknown): GrogoniMode {
  if (value === "marketplace" || value === "seller") {
    return value;
  }

  throw new Cp2Error(400, "mode_invalid", "mode must be marketplace or seller.");
}

function parseOptionalGrogoniMode(value: unknown): GrogoniMode | undefined {
  return value === undefined ? undefined : parseGrogoniMode(value);
}

function parseGrogoniChatSurface(value: unknown): GrogoniChatSurface {
  if (
    value === "conversation" ||
    value === "storefront" ||
    value === "catalogue" ||
    value === "product" ||
    value === "order" ||
    value === "receipt" ||
    value === "owner-controls"
  ) {
    return value;
  }

  throw new Cp2Error(400, "surface_invalid", "activeSurface is not supported.");
}

function parseOptionalGrogoniChatSurface(value: unknown): GrogoniChatSurface | undefined {
  return value === undefined ? undefined : parseGrogoniChatSurface(value);
}

function parseOptionalNullableString(value: unknown): string | null | undefined {
  return value === undefined ? undefined : parseNullableString(value);
}

function parseShopPresenceStatus(value: unknown): ShopPresenceStatus {
  if (value === "online" || value === "private" || value === "offline") return value;
  throw new Cp2Error(400, "presence_status_invalid", "Presence status is invalid.");
}

function parseNetworkInviteContacts(value: unknown): Array<{
  name: string;
  phone: string | null;
  email: string | null;
}> {
  if (!Array.isArray(value)) {
    throw new Cp2Error(400, "contacts_required", "contacts is required.");
  }
  return value.map((item, index) => {
    const record = parseRequestBody(item);
    return {
      name: parseString(record.name, `contacts[${index}].name`),
      phone: parseNullableString(record.phone),
      email: parseNullableString(record.email)
    };
  });
}

function parseOwnerInferenceRequest(value: unknown): InferenceRequest {
  const body = parseRequestBody(value);
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 100) {
    throw new Cp2Error(400, "inference_messages_invalid", "Inference messages are invalid.");
  }
  const messages = body.messages.map((item, index) => {
    const message = parseRequestBody(item);
    const role = message.role;
    if (role !== "system" && role !== "user" && role !== "assistant") {
      throw new Cp2Error(
        400,
        "inference_message_role_invalid",
        `messages[${index}].role is invalid.`
      );
    }
    const content = parseString(message.content, `messages[${index}].content`);
    if (content.length > 32_000) {
      throw new Cp2Error(
        400,
        "inference_message_too_large",
        `messages[${index}].content is too large.`
      );
    }
    return { role, content } satisfies InferenceRequest["messages"][number];
  });
  const request: InferenceRequest = {
    requestId: parseString(body.requestId, "requestId"),
    tenantId: parseString(body.tenantId, "tenantId"),
    conversationId: parseString(body.conversationId, "conversationId"),
    agentId: parseString(body.agentId, "agentId"),
    modelId: parseString(body.modelId, "modelId"),
    messages
  };
  if (typeof body.systemPrompt === "string") request.systemPrompt = body.systemPrompt;
  if (body.maxTokens !== undefined) {
    request.maxTokens = Math.min(512, parsePositiveInteger(body.maxTokens, "maxTokens"));
  }
  if (typeof body.temperature === "number" && Number.isFinite(body.temperature)) {
    request.temperature = Math.max(0, Math.min(2, body.temperature));
  }
  if (
    body.taskType === "conversation" ||
    body.taskType === "reasoning" ||
    body.taskType === "coding" ||
    body.taskType === "verification"
  ) {
    request.taskType = body.taskType;
  }
  return request;
}

function parseOptionalPermission(value: string | undefined): BusinessPermission | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (businessPermissions.includes(value as BusinessPermission)) {
    return value as BusinessPermission;
  }

  throw new Cp2Error(400, "permission_invalid", "Permission is not supported.");
}

const businessPermissions: BusinessPermission[] = [
  "business:create",
  "business:read",
  "membership:read",
  "membership:manage",
  "membership:invite",
  "product:read",
  "product:write",
  "customer:read",
  "customer:write",
  "supplier:read",
  "supplier:write",
  "inventory:adjust",
  "invoice:read",
  "invoice:write",
  "invoice:confirm",
  "payment:read",
  "payment:write",
  "logistics:read",
  "logistics:write",
  "fulfillment:read",
  "fulfillment:dispatch",
  "fulfillment:manage",
  "shop_location:write",
  "shop_location:read_precise",
  "delivery:record",
  "import:read",
  "import:write",
  "report:read",
  "notification:read",
  "notification:write",
  "compliance:read",
  "compliance:export",
  "compliance:delete",
  "verification:read",
  "verification:write",
  "tax:read",
  "tax:write",
  "device_trust:read",
  "device_trust:write",
  "beta:read",
  "beta:write",
  "beta:support",
  "beta:telemetry",
  "launch:read",
  "launch:write",
  "launch:support"
];
