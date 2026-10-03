/**
 * Ninth domain slice of in-process modularization for services/api/src/cp2/routes.ts (see
 * docs/architecture/routes-modularization-roadmap.md). Verification/tax-config/device-trust/
 * beta/launch routes - self-contained, zero cross-domain routes found, matching the store.ts
 * side's own finding for this domain. Two readiness routes (`GET .../beta/readiness`,
 * `GET .../launch/readiness`) deliberately stay in routes.ts (CORE) since they call
 * `store.getBetaReadiness`/`store.getLaunchReadiness` - cross-cutting report builders that stayed
 * on `Cp2Store` itself on the store.ts side, not delegated to `ComplianceDomain`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  BetaAccessStatus,
  BetaDeviceClass,
  BetaDeviceTestStatus,
  BetaFeatureFlagKey,
  BetaSupportSeverity,
  BetaSupportTicketStatus,
  BetaTelemetryKind,
  DeviceTrustLevel,
  LaunchAccessStatus,
  LaunchChecklistKey,
  LaunchChecklistStatus,
  LaunchIncidentCategory,
  LaunchIncidentSeverity,
  LaunchIncidentStatus,
  TaxCountryCode,
  VerificationTier
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { type Cp2Store, readSessionCookie } from "../../store.js";
import {
  parseBoolean,
  parseNonNegativeInteger,
  parseNullableString,
  parseNumber,
  parseRequestBody,
  parseString,
  sendCp2Error,
  type BusinessParams
} from "../../route-helpers.js";

interface BetaFeatureFlagParams extends BusinessParams {
  featureFlagKey: string;
}

interface BetaSupportTicketParams extends BusinessParams {
  supportTicketId: string;
}

interface LaunchChecklistParams extends BusinessParams {
  checklistKey: string;
}

interface LaunchIncidentParams extends BusinessParams {
  incidentId: string;
}

interface VerificationTierBody {
  tier?: string;
  evidenceType?: string | null;
  note?: string | null;
}

interface TaxConfigBody {
  countryCode?: string;
  defaultTaxRate?: number;
  taxId?: string | null;
  pricesIncludeTax?: boolean;
}

interface DeviceTrustBody {
  deviceId?: string;
  level?: string;
  reason?: string | null;
}

interface BetaAccessBody {
  status?: string;
  invitedMerchantCount?: number;
  pauseReason?: string | null;
}

interface BetaFeatureFlagBody {
  enabled?: boolean;
  reason?: string | null;
}

interface BetaDeviceTestBody {
  deviceClass?: string;
  workflow?: string;
  status?: string;
  durationMs?: number;
  notes?: string | null;
}

interface BetaSupportTicketBody {
  severity?: string;
  title?: string;
  body?: string | null;
  source?: string;
}

interface BetaSupportTicketStatusBody {
  status?: string;
}

interface BetaTelemetryBody {
  kind?: string;
  message?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

interface LaunchSettingsBody {
  status?: string;
  publicOnboardingEnabled?: boolean;
  rollbackArmed?: boolean;
  freezeActive?: boolean;
  allowedSignupCount?: number;
  pauseReason?: string | null;
}

interface LaunchChecklistBody {
  status?: string;
  evidence?: string | null;
}

interface LaunchIncidentBody {
  severity?: string;
  category?: string;
  title?: string;
  body?: string | null;
}

interface LaunchIncidentStatusBody {
  status?: string;
}

export function registerComplianceRoutes(app: FastifyInstance, store: Cp2Store): void {
  app.get(
    "/businesses/:businessId/compliance/verification",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.getVerificationTier({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/compliance/verification",
    async (
      request: FastifyRequest<{ Params: BusinessParams; Body: VerificationTierBody }>,
      reply
    ) => {
      try {
        return store.updateVerificationTier({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          verification: parseVerificationTierBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/compliance/tax-config",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.getTaxConfig({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/compliance/tax-config",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: TaxConfigBody }>, reply) => {
      try {
        return store.updateTaxConfig({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          taxConfig: parseTaxConfigBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/compliance/device-trust",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.getDeviceTrust({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/compliance/device-trust",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: DeviceTrustBody }>, reply) => {
      try {
        return store.updateDeviceTrust({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          deviceTrust: parseDeviceTrustBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/beta/access",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: BetaAccessBody }>, reply) => {
      try {
        return store.updateBetaAccess({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          access: parseBetaAccessBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/beta/feature-flags",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listBetaFeatureFlags({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/beta/feature-flags/:featureFlagKey",
    async (
      request: FastifyRequest<{ Params: BetaFeatureFlagParams; Body: BetaFeatureFlagBody }>,
      reply
    ) => {
      try {
        return store.updateBetaFeatureFlag({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          key: parseBetaFeatureFlagKey(request.params.featureFlagKey),
          featureFlag: parseBetaFeatureFlagBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/beta/device-tests",
    async (
      request: FastifyRequest<{ Params: BusinessParams; Body: BetaDeviceTestBody }>,
      reply
    ) => {
      try {
        return store.recordBetaDeviceTest({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          deviceTest: parseBetaDeviceTestBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/beta/support-tickets",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listBetaSupportTickets({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/beta/support-tickets",
    async (
      request: FastifyRequest<{ Params: BusinessParams; Body: BetaSupportTicketBody }>,
      reply
    ) => {
      try {
        return store.createBetaSupportTicket({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          ticket: parseBetaSupportTicketBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/beta/support-tickets/:supportTicketId",
    async (
      request: FastifyRequest<{
        Params: BetaSupportTicketParams;
        Body: BetaSupportTicketStatusBody;
      }>,
      reply
    ) => {
      try {
        return store.updateBetaSupportTicketStatus({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          supportTicketId: request.params.supportTicketId,
          ticketStatus: parseBetaSupportTicketStatusBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/beta/telemetry",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: BetaTelemetryBody }>, reply) => {
      try {
        return store.recordBetaTelemetry({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          telemetry: parseBetaTelemetryBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/launch/settings",
    async (
      request: FastifyRequest<{ Params: BusinessParams; Body: LaunchSettingsBody }>,
      reply
    ) => {
      try {
        return store.updateLaunchSettings({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          settings: parseLaunchSettingsBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/launch/checklist",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listLaunchChecklist({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/launch/checklist/:checklistKey",
    async (
      request: FastifyRequest<{ Params: LaunchChecklistParams; Body: LaunchChecklistBody }>,
      reply
    ) => {
      try {
        return store.updateLaunchChecklist({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          checklist: parseLaunchChecklistBody(request.params.checklistKey, request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/launch/incidents",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listLaunchIncidents({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/launch/incidents",
    async (
      request: FastifyRequest<{ Params: BusinessParams; Body: LaunchIncidentBody }>,
      reply
    ) => {
      try {
        return store.createLaunchIncident({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          incident: parseLaunchIncidentBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/launch/incidents/:incidentId",
    async (
      request: FastifyRequest<{
        Params: LaunchIncidentParams;
        Body: LaunchIncidentStatusBody;
      }>,
      reply
    ) => {
      try {
        return store.updateLaunchIncidentStatus({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          incidentId: request.params.incidentId,
          incidentStatus: parseLaunchIncidentStatusBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}

function parseVerificationTierBody(body: VerificationTierBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    tier: parseVerificationTier(record.tier),
    evidenceType:
      record.evidenceType === undefined || record.evidenceType === null
        ? null
        : parseVerificationEvidenceType(record.evidenceType),
    note: parseNullableString(record.note)
  };
}

function parseTaxConfigBody(body: TaxConfigBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    countryCode: parseTaxCountryCode(record.countryCode),
    defaultTaxRate: parseNumber(record.defaultTaxRate, "defaultTaxRate"),
    taxId: parseNullableString(record.taxId),
    pricesIncludeTax:
      record.pricesIncludeTax === undefined
        ? false
        : parseBoolean(record.pricesIncludeTax, "pricesIncludeTax")
  };
}

function parseDeviceTrustBody(body: DeviceTrustBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    deviceId: parseString(record.deviceId, "deviceId"),
    level: parseDeviceTrustLevel(record.level),
    reason: parseNullableString(record.reason)
  };
}

function parseBetaAccessBody(body: BetaAccessBody | null | undefined) {
  const record = parseRequestBody(body);
  const invitedMerchantCount =
    record.invitedMerchantCount === undefined
      ? undefined
      : parseNonNegativeInteger(record.invitedMerchantCount, "invitedMerchantCount");

  return {
    status: parseBetaAccessStatus(record.status),
    pauseReason: parseNullableString(record.pauseReason),
    ...(invitedMerchantCount === undefined ? {} : { invitedMerchantCount })
  };
}

function parseBetaFeatureFlagBody(body: BetaFeatureFlagBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    enabled: parseBoolean(record.enabled, "enabled"),
    reason: parseNullableString(record.reason)
  };
}

function parseBetaDeviceTestBody(body: BetaDeviceTestBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    deviceClass: parseBetaDeviceClass(record.deviceClass),
    workflow: parseString(record.workflow, "workflow"),
    status: parseBetaDeviceTestStatus(record.status),
    durationMs: parseNumber(record.durationMs, "durationMs"),
    notes: parseNullableString(record.notes)
  };
}

function parseBetaSupportTicketBody(body: BetaSupportTicketBody | null | undefined) {
  const record = parseRequestBody(body);
  const source = record.source === undefined ? undefined : parseBetaSupportSource(record.source);

  return {
    severity: parseBetaSupportSeverity(record.severity),
    title: parseString(record.title, "title"),
    body: parseNullableString(record.body),
    ...(source === undefined ? {} : { source })
  };
}

function parseBetaSupportTicketStatusBody(body: BetaSupportTicketStatusBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    status: parseBetaSupportTicketStatus(record.status)
  };
}

function parseBetaTelemetryBody(body: BetaTelemetryBody | null | undefined) {
  const record = parseRequestBody(body);
  const metadata =
    record.metadata === undefined ? undefined : parseBetaTelemetryMetadata(record.metadata);

  return {
    kind: parseBetaTelemetryKind(record.kind),
    message: parseNullableString(record.message),
    ...(metadata === undefined ? {} : { metadata })
  };
}

function parseLaunchSettingsBody(body: LaunchSettingsBody | null | undefined) {
  const record = parseRequestBody(body);
  const publicOnboardingEnabled =
    record.publicOnboardingEnabled === undefined
      ? undefined
      : parseBoolean(record.publicOnboardingEnabled, "publicOnboardingEnabled");
  const rollbackArmed =
    record.rollbackArmed === undefined
      ? undefined
      : parseBoolean(record.rollbackArmed, "rollbackArmed");
  const freezeActive =
    record.freezeActive === undefined
      ? undefined
      : parseBoolean(record.freezeActive, "freezeActive");
  const allowedSignupCount =
    record.allowedSignupCount === undefined
      ? undefined
      : parseNumber(record.allowedSignupCount, "allowedSignupCount");

  return {
    status: parseLaunchAccessStatus(record.status),
    ...(publicOnboardingEnabled === undefined ? {} : { publicOnboardingEnabled }),
    ...(rollbackArmed === undefined ? {} : { rollbackArmed }),
    ...(freezeActive === undefined ? {} : { freezeActive }),
    ...(allowedSignupCount === undefined ? {} : { allowedSignupCount }),
    pauseReason: parseNullableString(record.pauseReason)
  };
}

function parseLaunchChecklistBody(key: string, body: LaunchChecklistBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    key: parseLaunchChecklistKey(key),
    status: parseLaunchChecklistStatus(record.status),
    evidence: parseNullableString(record.evidence)
  };
}

function parseLaunchIncidentBody(body: LaunchIncidentBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    severity: parseLaunchIncidentSeverity(record.severity),
    category: parseLaunchIncidentCategory(record.category),
    title: parseString(record.title, "title"),
    body: parseNullableString(record.body)
  };
}

function parseLaunchIncidentStatusBody(body: LaunchIncidentStatusBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    status: parseLaunchIncidentStatus(record.status)
  };
}

function parseVerificationTier(value: unknown): VerificationTier {
  const tier = parseString(value, "tier");

  if (tier === "unverified" || tier === "owner_verified" || tier === "business_verified") {
    return tier;
  }

  throw new Cp2Error(400, "verification_tier_invalid", "Verification tier is not supported.");
}

function parseVerificationEvidenceType(
  value: unknown
): "none" | "owner_attestation" | "business_document" {
  const evidenceType = parseString(value, "evidenceType");

  if (
    evidenceType === "none" ||
    evidenceType === "owner_attestation" ||
    evidenceType === "business_document"
  ) {
    return evidenceType;
  }

  throw new Cp2Error(
    400,
    "verification_evidence_invalid",
    "Verification evidence type is not supported."
  );
}

function parseTaxCountryCode(value: unknown): TaxCountryCode {
  const countryCode = parseString(value, "countryCode");

  if (countryCode === "KE") {
    return countryCode;
  }

  throw new Cp2Error(400, "tax_country_invalid", "Tax country code is not supported.");
}

function parseDeviceTrustLevel(value: unknown): DeviceTrustLevel {
  const level = parseString(value, "level");

  if (level === "unknown" || level === "trusted" || level === "restricted") {
    return level;
  }

  throw new Cp2Error(400, "device_trust_invalid", "Device trust level is not supported.");
}

function parseBetaAccessStatus(value: unknown): BetaAccessStatus {
  const status = parseString(value, "status");

  if (status === "not_invited" || status === "active" || status === "paused") {
    return status;
  }

  throw new Cp2Error(400, "beta_access_invalid", "Beta access status is not supported.");
}

function parseBetaFeatureFlagKey(value: unknown): BetaFeatureFlagKey {
  const key = parseString(value, "featureFlagKey");

  if (
    key === "closed_beta" ||
    key === "offline_hardening" ||
    key === "controlled_payments" ||
    key === "support_intake" ||
    key === "crash_telemetry"
  ) {
    return key;
  }

  throw new Cp2Error(400, "beta_feature_flag_invalid", "Beta feature flag is not supported.");
}

function parseBetaDeviceClass(value: unknown): BetaDeviceClass {
  const deviceClass = parseString(value, "deviceClass");

  if (deviceClass === "android_1gb" || deviceClass === "android_2gb") {
    return deviceClass;
  }

  throw new Cp2Error(400, "beta_device_class_invalid", "Beta device class is not supported.");
}

function parseBetaDeviceTestStatus(value: unknown): BetaDeviceTestStatus {
  const status = parseString(value, "status");

  if (status === "passed" || status === "failed") {
    return status;
  }

  throw new Cp2Error(400, "beta_device_status_invalid", "Beta device status is not supported.");
}

function parseBetaSupportSeverity(value: unknown): BetaSupportSeverity {
  const severity = parseString(value, "severity");

  if (
    severity === "low" ||
    severity === "medium" ||
    severity === "high" ||
    severity === "critical"
  ) {
    return severity;
  }

  throw new Cp2Error(
    400,
    "beta_support_severity_invalid",
    "Beta support severity is not supported."
  );
}

function parseBetaSupportTicketStatus(value: unknown): BetaSupportTicketStatus {
  const status = parseString(value, "status");

  if (status === "open" || status === "triaged" || status === "resolved") {
    return status;
  }

  throw new Cp2Error(400, "beta_support_status_invalid", "Beta support status is not supported.");
}

function parseBetaSupportSource(value: unknown): "merchant" | "operator" {
  const source = parseString(value, "source");

  if (source === "merchant" || source === "operator") {
    return source;
  }

  throw new Cp2Error(400, "beta_support_source_invalid", "Beta support source is not supported.");
}

function parseBetaTelemetryKind(value: unknown): BetaTelemetryKind {
  const kind = parseString(value, "kind");

  if (kind === "session" || kind === "crash" || kind === "error") {
    return kind;
  }

  throw new Cp2Error(400, "beta_telemetry_kind_invalid", "Beta telemetry kind is not supported.");
}

function parseLaunchAccessStatus(value: unknown): LaunchAccessStatus {
  const status = parseString(value, "status");

  if (status === "closed" || status === "open" || status === "paused") {
    return status;
  }

  throw new Cp2Error(400, "launch_status_invalid", "Launch status is not supported.");
}

function parseLaunchChecklistKey(value: unknown): LaunchChecklistKey {
  const key = parseString(value, "checklistKey");

  if (
    key === "environment_config" ||
    key === "secrets_ready" ||
    key === "backup_verified" ||
    key === "monitoring_ready" ||
    key === "deploy_verified" ||
    key === "rollback_runbook" ||
    key === "support_coverage"
  ) {
    return key;
  }

  throw new Cp2Error(400, "launch_checklist_invalid", "Launch checklist key is not supported.");
}

function parseLaunchChecklistStatus(value: unknown): LaunchChecklistStatus {
  const status = parseString(value, "status");

  if (status === "pending" || status === "passed" || status === "failed") {
    return status;
  }

  throw new Cp2Error(
    400,
    "launch_checklist_status_invalid",
    "Launch checklist status is not supported."
  );
}

function parseLaunchIncidentSeverity(value: unknown): LaunchIncidentSeverity {
  const severity = parseString(value, "severity");

  if (
    severity === "low" ||
    severity === "medium" ||
    severity === "high" ||
    severity === "critical"
  ) {
    return severity;
  }

  throw new Cp2Error(
    400,
    "launch_incident_severity_invalid",
    "Launch incident severity is not supported."
  );
}

function parseLaunchIncidentCategory(value: unknown): LaunchIncidentCategory {
  const category = parseString(value, "category");

  if (
    category === "onboarding" ||
    category === "payments" ||
    category === "sync" ||
    category === "support" ||
    category === "telemetry" ||
    category === "rollback"
  ) {
    return category;
  }

  throw new Cp2Error(
    400,
    "launch_incident_category_invalid",
    "Launch incident category is not supported."
  );
}

function parseLaunchIncidentStatus(value: unknown): LaunchIncidentStatus {
  const status = parseString(value, "status");

  if (status === "open" || status === "mitigating" || status === "resolved") {
    return status;
  }

  throw new Cp2Error(
    400,
    "launch_incident_status_invalid",
    "Launch incident status is not supported."
  );
}

function parseBetaTelemetryMetadata(
  value: unknown
): Record<string, string | number | boolean | null> {
  const record = parseRequestBody(value);
  const metadata: Record<string, string | number | boolean | null> = {};

  for (const [key, metadataValue] of Object.entries(record)) {
    if (
      typeof metadataValue === "string" ||
      typeof metadataValue === "number" ||
      typeof metadataValue === "boolean" ||
      metadataValue === null
    ) {
      metadata[key] = metadataValue;
      continue;
    }

    throw new Cp2Error(
      400,
      "beta_telemetry_metadata_invalid",
      "Beta telemetry metadata values must be scalar."
    );
  }

  return metadata;
}
