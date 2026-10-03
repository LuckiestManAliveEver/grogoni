/**
 * Second slice of in-process domain modularization for the Cp2Store monolith (see
 * docs/architecture/domain-modularization-roadmap.md). Owns the eleven entity Maps for
 * per-business compliance config, tax config, device trust, closed-beta access/feature
 * flags/device tests/support/telemetry, and public-launch settings/checklist/incidents - plus
 * every CRUD/validation/event method that reads and writes them directly.
 *
 * What did NOT move here, and why: `buildComplianceReport`/`buildBetaReadinessReport`/
 * `buildLaunchReadinessReport` (the readiness-dashboard builders) and the `getSecurityReview`/
 * `getBetaReadiness`/`getLaunchReadiness` endpoint methods stay on Cp2Store. Reading the actual
 * method bodies (not just the Map names) during this extraction showed those report builders
 * reach across nearly every other domain - invoices, payments, sync queue, offline cache,
 * products, customers, logistics, audit events, data exports, account deletion requests - to
 * compute readiness gates. That is cross-cutting business-report-engine logic that happens to
 * read this domain's records, not compliance/beta/launch logic itself; moving it here would just
 * recreate the ambient-coupling problem this refactor exists to remove. This domain exposes
 * public `getOrCreate*`/`*ForBusiness` accessors (in addition to the auth-gated endpoint methods)
 * specifically so those report builders - and Cp2Store's `auditEventsForBusiness` - can read this
 * domain's records without reaching into its private Maps.
 */
import { randomUUID, createHash } from "node:crypto";
import {
  betaAccessUpdatedEvent,
  betaDeviceTestRecordedEvent,
  betaFeatureFlagRisk,
  betaFeatureFlagUpdatedEvent,
  betaSupportTicketCreatedEvent,
  betaSupportTicketStatusUpdatedEvent,
  betaTelemetryRecordedEvent,
  deviceTrustUpdatedEvent,
  launchChecklistUpdatedEvent,
  launchIncidentCreatedEvent,
  launchIncidentStatusUpdatedEvent,
  launchSettingsUpdatedEvent,
  normalizeBetaAccessInput,
  normalizeBetaDeviceTestInput,
  normalizeBetaFeatureFlagInput,
  normalizeBetaSupportTicketInput,
  normalizeBetaSupportTicketStatusInput,
  normalizeBetaTelemetryInput,
  normalizeCountryTaxConfigInput,
  normalizeDeviceTrustInput,
  normalizeLaunchChecklistInput,
  normalizeLaunchIncidentInput,
  normalizeLaunchIncidentStatusInput,
  normalizeLaunchSettingsInput,
  normalizeVerificationTierInput,
  taxConfigUpdatedEvent,
  validateBetaAccessInput,
  validateBetaDeviceTestInput,
  validateBetaFeatureFlagInput,
  validateBetaSupportTicketInput,
  validateBetaSupportTicketStatusInput,
  validateBetaTelemetryInput,
  validateCountryTaxConfigInput,
  validateDeviceTrustInput,
  validateLaunchChecklistInput,
  validateLaunchIncidentInput,
  validateLaunchIncidentStatusInput,
  validateLaunchSettingsInput,
  validateVerificationTierInput,
  verificationTierUpdatedEvent,
  type BetaAccessInput,
  type BetaDeviceTestInput,
  type BetaFeatureFlagInput,
  type BetaSupportTicketInput,
  type BetaSupportTicketStatusInput,
  type BetaTelemetryInput,
  type BusinessPermission,
  type CountryTaxConfigInput,
  type DeviceTrustInput,
  type LaunchChecklistInput,
  type LaunchIncidentInput,
  type LaunchIncidentStatusInput,
  type LaunchSettingsInput,
  type VerificationTierInput
} from "@grogoni/business-core";
import type { BusinessEvent } from "@grogoni/event-core";
import type {
  AuthenticatedActorView,
  BetaAccessSummary,
  BetaDeviceTestSummary,
  BetaFeatureFlagKey,
  BetaFeatureFlagSummary,
  BetaSupportTicketSummary,
  BetaTelemetryEventSummary,
  CountryTaxConfigSummary,
  DeviceTrustSummary,
  LaunchChecklistItemSummary,
  LaunchChecklistKey,
  LaunchIncidentSummary,
  LaunchSettingsSummary,
  VerificationTierSummary
} from "@grogoni/shared-types";
import { Cp2Error, assertValid } from "../../cp2-error.js";
import {
  betaFeatureFlagKeys,
  betaFeatureFlagMapKey,
  deviceTrustKey,
  launchChecklistKeys,
  launchChecklistMapKey
} from "./shared.js";

export interface ComplianceDomainDeps {
  requireAuthorizedSession: (
    sessionId: string | null,
    businessId: string,
    permission: BusinessPermission,
    now?: Date
  ) => AuthenticatedActorView;
  appendBusinessEvent: (event: BusinessEvent) => void;
}

export class ComplianceDomain {
  private readonly verificationTiers = new Map<string, VerificationTierSummary>();
  private readonly taxConfigs = new Map<string, CountryTaxConfigSummary>();
  private readonly deviceTrust = new Map<string, DeviceTrustSummary>();
  private readonly betaAccess = new Map<string, BetaAccessSummary>();
  private readonly betaFeatureFlags = new Map<string, BetaFeatureFlagSummary>();
  private readonly betaDeviceTests = new Map<string, BetaDeviceTestSummary>();
  private readonly betaSupportTickets = new Map<string, BetaSupportTicketSummary>();
  private readonly betaTelemetryEvents = new Map<string, BetaTelemetryEventSummary>();
  private readonly launchSettings = new Map<string, LaunchSettingsSummary>();
  private readonly launchChecklist = new Map<string, LaunchChecklistItemSummary>();
  private readonly launchIncidents = new Map<string, LaunchIncidentSummary>();

  constructor(private readonly deps: ComplianceDomainDeps) {}

  get verificationTiersMap(): Map<string, VerificationTierSummary> {
    return this.verificationTiers;
  }

  get taxConfigsMap(): Map<string, CountryTaxConfigSummary> {
    return this.taxConfigs;
  }

  get deviceTrustMap(): Map<string, DeviceTrustSummary> {
    return this.deviceTrust;
  }

  get betaAccessMap(): Map<string, BetaAccessSummary> {
    return this.betaAccess;
  }

  get betaFeatureFlagsMap(): Map<string, BetaFeatureFlagSummary> {
    return this.betaFeatureFlags;
  }

  get betaDeviceTestsMap(): Map<string, BetaDeviceTestSummary> {
    return this.betaDeviceTests;
  }

  get betaSupportTicketsMap(): Map<string, BetaSupportTicketSummary> {
    return this.betaSupportTickets;
  }

  get betaTelemetryEventsMap(): Map<string, BetaTelemetryEventSummary> {
    return this.betaTelemetryEvents;
  }

  get launchSettingsMap(): Map<string, LaunchSettingsSummary> {
    return this.launchSettings;
  }

  get launchChecklistMap(): Map<string, LaunchChecklistItemSummary> {
    return this.launchChecklist;
  }

  get launchIncidentsMap(): Map<string, LaunchIncidentSummary> {
    return this.launchIncidents;
  }

  clear(): void {
    this.verificationTiers.clear();
    this.taxConfigs.clear();
    this.deviceTrust.clear();
    this.betaAccess.clear();
    this.betaFeatureFlags.clear();
    this.betaDeviceTests.clear();
    this.betaSupportTickets.clear();
    this.betaTelemetryEvents.clear();
    this.launchSettings.clear();
    this.launchChecklist.clear();
    this.launchIncidents.clear();
  }

  getVerificationTier(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): VerificationTierSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "verification:read",
      now
    );
    return this.getOrCreateVerificationTier(input.businessId, session.user.id, now);
  }

  updateVerificationTier(input: {
    sessionId: string | null;
    businessId: string;
    verification: VerificationTierInput;
    now?: Date;
  }): VerificationTierSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "verification:write",
      now
    );
    assertValid(validateVerificationTierInput(input.verification));
    const normalized = normalizeVerificationTierInput(input.verification);
    const existing = this.getOrCreateVerificationTier(input.businessId, session.user.id, now);
    const updated: VerificationTierSummary = {
      businessId: input.businessId,
      tier: normalized.tier,
      evidenceType: normalized.evidenceType,
      note: normalized.note,
      updatedBy: session.user.id,
      updatedAt: now.toISOString()
    };

    this.verificationTiers.set(input.businessId, updated);
    this.deps.appendBusinessEvent(
      verificationTierUpdatedEvent({
        id: randomUUID(),
        verification: updated,
        previousTier: existing.tier,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return updated;
  }

  getTaxConfig(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): CountryTaxConfigSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "tax:read",
      now
    );
    return this.getOrCreateTaxConfig(input.businessId, session.user.id, now);
  }

  updateTaxConfig(input: {
    sessionId: string | null;
    businessId: string;
    taxConfig: CountryTaxConfigInput;
    now?: Date;
  }): CountryTaxConfigSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "tax:write",
      now
    );
    assertValid(validateCountryTaxConfigInput(input.taxConfig));
    const normalized = normalizeCountryTaxConfigInput(input.taxConfig);
    const updated: CountryTaxConfigSummary = {
      businessId: input.businessId,
      countryCode: normalized.countryCode,
      defaultTaxRate: normalized.defaultTaxRate,
      taxIdLabel: normalized.countryCode === "KE" ? "KRA PIN" : "Tax ID",
      taxId: normalized.taxId,
      pricesIncludeTax: normalized.pricesIncludeTax,
      updatedBy: session.user.id,
      updatedAt: now.toISOString()
    };

    this.taxConfigs.set(input.businessId, updated);
    this.deps.appendBusinessEvent(
      taxConfigUpdatedEvent({
        id: randomUUID(),
        taxConfig: updated,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return updated;
  }

  getDeviceTrust(input: {
    sessionId: string | null;
    businessId: string;
    deviceId?: string;
    now?: Date;
  }): DeviceTrustSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "device_trust:read",
      now
    );
    return this.getOrCreateDeviceTrust(
      input.businessId,
      session.user.id,
      input.deviceId ?? "browser-session",
      session.user.id,
      now
    );
  }

  updateDeviceTrust(input: {
    sessionId: string | null;
    businessId: string;
    deviceTrust: DeviceTrustInput;
    now?: Date;
  }): DeviceTrustSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "device_trust:write",
      now
    );
    assertValid(validateDeviceTrustInput(input.deviceTrust));
    const normalized = normalizeDeviceTrustInput(input.deviceTrust);
    const existing = this.getOrCreateDeviceTrust(
      input.businessId,
      session.user.id,
      normalized.deviceId,
      session.user.id,
      now
    );
    const updated: DeviceTrustSummary = {
      businessId: input.businessId,
      userId: session.user.id,
      deviceId: normalized.deviceId,
      level: normalized.level,
      reason: normalized.reason,
      updatedBy: session.user.id,
      updatedAt: now.toISOString()
    };

    this.deviceTrust.set(
      deviceTrustKey(input.businessId, session.user.id, normalized.deviceId),
      updated
    );
    this.deps.appendBusinessEvent(
      deviceTrustUpdatedEvent({
        id: randomUUID(),
        deviceTrust: updated,
        previousLevel: existing.level,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return updated;
  }

  updateBetaAccess(input: {
    sessionId: string | null;
    businessId: string;
    access: BetaAccessInput;
    now?: Date;
  }): BetaAccessSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "beta:write",
      now
    );
    assertValid(validateBetaAccessInput(input.access));
    const normalized = normalizeBetaAccessInput(input.access);
    const existing = this.getOrCreateBetaAccess(input.businessId, session.user.id, now);
    const updated: BetaAccessSummary = {
      businessId: input.businessId,
      status: normalized.status,
      targetMerchantCount: 10,
      invitedMerchantCount: normalized.invitedMerchantCount,
      pauseReason: normalized.pauseReason,
      updatedBy: session.user.id,
      updatedAt: now.toISOString()
    };

    this.betaAccess.set(input.businessId, updated);
    this.deps.appendBusinessEvent(
      betaAccessUpdatedEvent({
        id: randomUUID(),
        access: updated,
        previousStatus: existing.status,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return updated;
  }

  listBetaFeatureFlags(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): BetaFeatureFlagSummary[] {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "beta:read",
      now
    );
    return betaFeatureFlagKeys.map((key) =>
      this.getOrCreateBetaFeatureFlag(input.businessId, key, session.user.id, now)
    );
  }

  updateBetaFeatureFlag(input: {
    sessionId: string | null;
    businessId: string;
    key: BetaFeatureFlagKey;
    featureFlag: BetaFeatureFlagInput;
    now?: Date;
  }): BetaFeatureFlagSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "beta:write",
      now
    );
    assertValid(validateBetaFeatureFlagInput(input.featureFlag));
    const normalized = normalizeBetaFeatureFlagInput(input.featureFlag);
    const updated: BetaFeatureFlagSummary = {
      businessId: input.businessId,
      key: input.key,
      enabled: normalized.enabled,
      risk: betaFeatureFlagRisk(input.key),
      reason: normalized.reason,
      updatedBy: session.user.id,
      updatedAt: now.toISOString()
    };

    this.betaFeatureFlags.set(betaFeatureFlagMapKey(input.businessId, input.key), updated);
    this.deps.appendBusinessEvent(
      betaFeatureFlagUpdatedEvent({
        id: randomUUID(),
        featureFlag: updated,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return updated;
  }

  recordBetaDeviceTest(input: {
    sessionId: string | null;
    businessId: string;
    deviceTest: BetaDeviceTestInput;
    now?: Date;
  }): BetaDeviceTestSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "beta:write",
      now
    );
    assertValid(validateBetaDeviceTestInput(input.deviceTest));
    const normalized = normalizeBetaDeviceTestInput(input.deviceTest);
    const deviceTest: BetaDeviceTestSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      deviceClass: normalized.deviceClass,
      workflow: normalized.workflow,
      status: normalized.status,
      durationMs: normalized.durationMs,
      notes: normalized.notes,
      recordedBy: session.user.id,
      recordedAt: now.toISOString()
    };

    this.betaDeviceTests.set(deviceTest.id, deviceTest);
    this.deps.appendBusinessEvent(
      betaDeviceTestRecordedEvent({
        id: randomUUID(),
        deviceTest,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return deviceTest;
  }

  listBetaSupportTickets(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): BetaSupportTicketSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "beta:support",
      input.now
    );
    return this.betaSupportTicketsForBusiness(input.businessId);
  }

  createBetaSupportTicket(input: {
    sessionId: string | null;
    businessId: string;
    ticket: BetaSupportTicketInput;
    now?: Date;
  }): BetaSupportTicketSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "beta:support",
      now
    );
    assertValid(validateBetaSupportTicketInput(input.ticket));
    const normalized = normalizeBetaSupportTicketInput(input.ticket);
    const ticket: BetaSupportTicketSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      severity: normalized.severity,
      status: "open",
      title: normalized.title,
      bodySummary: normalized.bodySummary,
      source: normalized.source,
      createdBy: session.user.id,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      resolvedAt: null
    };

    this.betaSupportTickets.set(ticket.id, ticket);
    this.deps.appendBusinessEvent(
      betaSupportTicketCreatedEvent({
        id: randomUUID(),
        ticket,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return ticket;
  }

  updateBetaSupportTicketStatus(input: {
    sessionId: string | null;
    businessId: string;
    supportTicketId: string;
    ticketStatus: BetaSupportTicketStatusInput;
    now?: Date;
  }): BetaSupportTicketSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "beta:support",
      now
    );
    assertValid(validateBetaSupportTicketStatusInput(input.ticketStatus));
    const normalized = normalizeBetaSupportTicketStatusInput(input.ticketStatus);
    const ticket = this.betaSupportTickets.get(input.supportTicketId);

    if (ticket === undefined || ticket.businessId !== input.businessId) {
      throw new Cp2Error(404, "beta_support_ticket_not_found", "Support ticket was not found.");
    }

    const updated: BetaSupportTicketSummary = {
      ...ticket,
      status: normalized.status,
      updatedAt: now.toISOString(),
      resolvedAt: normalized.status === "resolved" ? (ticket.resolvedAt ?? now.toISOString()) : null
    };

    this.betaSupportTickets.set(updated.id, updated);
    this.deps.appendBusinessEvent(
      betaSupportTicketStatusUpdatedEvent({
        id: randomUUID(),
        ticket: updated,
        previousStatus: ticket.status,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return updated;
  }

  recordBetaTelemetry(input: {
    sessionId: string | null;
    businessId: string;
    telemetry: BetaTelemetryInput;
    now?: Date;
  }): BetaTelemetryEventSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "beta:telemetry",
      now
    );
    assertValid(validateBetaTelemetryInput(input.telemetry));
    const normalized = normalizeBetaTelemetryInput(input.telemetry);
    const event: BetaTelemetryEventSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      kind: normalized.kind,
      severity:
        normalized.kind === "crash" ? "critical" : normalized.kind === "error" ? "warning" : "info",
      fingerprint: createHash("sha256")
        .update(`${normalized.kind}:${normalized.message ?? ""}`)
        .digest("hex")
        .slice(0, 16),
      messageHash: createHash("sha256")
        .update(normalized.message ?? "")
        .digest("hex"),
      boundedMetadata: normalized.metadata,
      occurredAt: now.toISOString(),
      recordedAt: now.toISOString()
    };

    this.betaTelemetryEvents.set(event.id, event);
    this.deps.appendBusinessEvent(
      betaTelemetryRecordedEvent({
        id: randomUUID(),
        telemetry: event,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return event;
  }

  updateLaunchSettings(input: {
    sessionId: string | null;
    businessId: string;
    settings: LaunchSettingsInput;
    now?: Date;
  }): LaunchSettingsSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "launch:write",
      now
    );
    assertValid(validateLaunchSettingsInput(input.settings));
    const normalized = normalizeLaunchSettingsInput(input.settings);
    const existing = this.getOrCreateLaunchSettings(input.businessId, session.user.id, now);
    const settings: LaunchSettingsSummary = {
      businessId: input.businessId,
      status: normalized.status,
      publicOnboardingEnabled: normalized.publicOnboardingEnabled,
      rollbackArmed: normalized.rollbackArmed,
      freezeActive: normalized.freezeActive,
      allowedSignupCount: normalized.allowedSignupCount,
      pauseReason: normalized.pauseReason,
      updatedBy: session.user.id,
      updatedAt: now.toISOString()
    };

    this.launchSettings.set(input.businessId, settings);
    this.deps.appendBusinessEvent(
      launchSettingsUpdatedEvent({
        id: randomUUID(),
        settings,
        previousStatus: existing.status,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return settings;
  }

  listLaunchChecklist(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): LaunchChecklistItemSummary[] {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "launch:read",
      now
    );
    return launchChecklistKeys.map((key) =>
      this.getOrCreateLaunchChecklistItem(input.businessId, key, session.user.id, now)
    );
  }

  updateLaunchChecklist(input: {
    sessionId: string | null;
    businessId: string;
    checklist: LaunchChecklistInput;
    now?: Date;
  }): LaunchChecklistItemSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "launch:write",
      now
    );
    assertValid(validateLaunchChecklistInput(input.checklist));
    const normalized = normalizeLaunchChecklistInput(input.checklist);
    const item: LaunchChecklistItemSummary = {
      businessId: input.businessId,
      key: normalized.key,
      status: normalized.status,
      evidence: normalized.evidence,
      updatedBy: session.user.id,
      updatedAt: now.toISOString()
    };

    this.launchChecklist.set(launchChecklistMapKey(input.businessId, item.key), item);
    this.deps.appendBusinessEvent(
      launchChecklistUpdatedEvent({
        id: randomUUID(),
        item,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return item;
  }

  listLaunchIncidents(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): LaunchIncidentSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "launch:support",
      input.now
    );
    return this.launchIncidentsForBusiness(input.businessId);
  }

  createLaunchIncident(input: {
    sessionId: string | null;
    businessId: string;
    incident: LaunchIncidentInput;
    now?: Date;
  }): LaunchIncidentSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "launch:support",
      now
    );
    assertValid(validateLaunchIncidentInput(input.incident));
    const normalized = normalizeLaunchIncidentInput(input.incident);
    const incident: LaunchIncidentSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      severity: normalized.severity,
      status: "open",
      category: normalized.category,
      title: normalized.title,
      bodySummary: normalized.bodySummary,
      createdBy: session.user.id,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      resolvedAt: null
    };

    this.launchIncidents.set(incident.id, incident);
    this.deps.appendBusinessEvent(
      launchIncidentCreatedEvent({
        id: randomUUID(),
        incident,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return incident;
  }

  updateLaunchIncidentStatus(input: {
    sessionId: string | null;
    businessId: string;
    incidentId: string;
    incidentStatus: LaunchIncidentStatusInput;
    now?: Date;
  }): LaunchIncidentSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "launch:support",
      now
    );
    assertValid(validateLaunchIncidentStatusInput(input.incidentStatus));
    const normalized = normalizeLaunchIncidentStatusInput(input.incidentStatus);
    const incident = this.launchIncidents.get(input.incidentId);

    if (incident === undefined || incident.businessId !== input.businessId) {
      throw new Cp2Error(404, "launch_incident_not_found", "Launch incident was not found.");
    }

    const updated: LaunchIncidentSummary = {
      ...incident,
      status: normalized.status,
      updatedAt: now.toISOString(),
      resolvedAt:
        normalized.status === "resolved" ? (incident.resolvedAt ?? now.toISOString()) : null
    };

    this.launchIncidents.set(updated.id, updated);
    this.deps.appendBusinessEvent(
      launchIncidentStatusUpdatedEvent({
        id: randomUUID(),
        incident: updated,
        previousStatus: incident.status,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return updated;
  }

  getOrCreateVerificationTier(
    businessId: string,
    actorId: string,
    now: Date
  ): VerificationTierSummary {
    const existing = this.verificationTiers.get(businessId);

    if (existing !== undefined) {
      return existing;
    }

    const verification: VerificationTierSummary = {
      businessId,
      tier: "unverified",
      evidenceType: "none",
      note: null,
      updatedBy: actorId,
      updatedAt: now.toISOString()
    };
    this.verificationTiers.set(businessId, verification);
    return verification;
  }

  getOrCreateTaxConfig(businessId: string, actorId: string, now: Date): CountryTaxConfigSummary {
    const existing = this.taxConfigs.get(businessId);

    if (existing !== undefined) {
      return existing;
    }

    const taxConfig: CountryTaxConfigSummary = {
      businessId,
      countryCode: "KE",
      defaultTaxRate: 0.16,
      taxIdLabel: "KRA PIN",
      taxId: null,
      pricesIncludeTax: false,
      updatedBy: actorId,
      updatedAt: now.toISOString()
    };
    this.taxConfigs.set(businessId, taxConfig);
    return taxConfig;
  }

  getOrCreateDeviceTrust(
    businessId: string,
    userId: string,
    deviceId: string,
    actorId: string,
    now: Date
  ): DeviceTrustSummary {
    const key = deviceTrustKey(businessId, userId, deviceId);
    const existing = this.deviceTrust.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const trust: DeviceTrustSummary = {
      businessId,
      userId,
      deviceId,
      level: "unknown",
      reason: null,
      updatedBy: actorId,
      updatedAt: now.toISOString()
    };
    this.deviceTrust.set(key, trust);
    return trust;
  }

  getOrCreateBetaAccess(businessId: string, actorId: string, now: Date): BetaAccessSummary {
    const existing = this.betaAccess.get(businessId);

    if (existing !== undefined) {
      return existing;
    }

    const access: BetaAccessSummary = {
      businessId,
      status: "not_invited",
      targetMerchantCount: 10,
      invitedMerchantCount: 0,
      pauseReason: null,
      updatedBy: actorId,
      updatedAt: now.toISOString()
    };
    this.betaAccess.set(businessId, access);
    return access;
  }

  getOrCreateBetaFeatureFlag(
    businessId: string,
    key: BetaFeatureFlagKey,
    actorId: string,
    now: Date
  ): BetaFeatureFlagSummary {
    const mapKey = betaFeatureFlagMapKey(businessId, key);
    const existing = this.betaFeatureFlags.get(mapKey);

    if (existing !== undefined) {
      return existing;
    }

    const featureFlag: BetaFeatureFlagSummary = {
      businessId,
      key,
      enabled: false,
      risk: betaFeatureFlagRisk(key),
      reason: "Disabled until CP15 beta hardening passes.",
      updatedBy: actorId,
      updatedAt: now.toISOString()
    };
    this.betaFeatureFlags.set(mapKey, featureFlag);
    return featureFlag;
  }

  getOrCreateLaunchSettings(businessId: string, actorId: string, now: Date): LaunchSettingsSummary {
    const existing = this.launchSettings.get(businessId);

    if (existing !== undefined) {
      return existing;
    }

    const settings: LaunchSettingsSummary = {
      businessId,
      status: "closed",
      publicOnboardingEnabled: false,
      rollbackArmed: true,
      freezeActive: true,
      allowedSignupCount: 0,
      pauseReason: "Public launch is closed until CP16 gates pass.",
      updatedBy: actorId,
      updatedAt: now.toISOString()
    };
    this.launchSettings.set(businessId, settings);
    return settings;
  }

  getOrCreateLaunchChecklistItem(
    businessId: string,
    key: LaunchChecklistKey,
    actorId: string,
    now: Date
  ): LaunchChecklistItemSummary {
    const mapKey = launchChecklistMapKey(businessId, key);
    const existing = this.launchChecklist.get(mapKey);

    if (existing !== undefined) {
      return existing;
    }

    const item: LaunchChecklistItemSummary = {
      businessId,
      key,
      status: "pending",
      evidence: "Pending CP16 public launch verification.",
      updatedBy: actorId,
      updatedAt: now.toISOString()
    };
    this.launchChecklist.set(mapKey, item);
    return item;
  }

  betaDeviceTestsForBusiness(businessId: string): BetaDeviceTestSummary[] {
    return [...this.betaDeviceTests.values()]
      .filter((test) => test.businessId === businessId)
      .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
  }

  betaSupportTicketsForBusiness(businessId: string): BetaSupportTicketSummary[] {
    return [...this.betaSupportTickets.values()]
      .filter((ticket) => ticket.businessId === businessId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  betaTelemetryEventsForBusiness(businessId: string): BetaTelemetryEventSummary[] {
    return [...this.betaTelemetryEvents.values()]
      .filter((event) => event.businessId === businessId)
      .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
  }

  launchIncidentsForBusiness(businessId: string): LaunchIncidentSummary[] {
    return [...this.launchIncidents.values()]
      .filter((incident) => incident.businessId === businessId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}
