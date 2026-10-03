import { useState } from "react";
import { reportBackgroundLoadError } from "../background-load-error";

import { getErrorMessage } from "../chat-message-plumbing";
import { getJson, patchJson, postJson } from "../api-helpers";
import {
  emptyBetaForm,
  emptyComplianceForm,
  emptyLaunchForm,
  type AccountDeletionRequestSummary,
  type ActiveBusiness,
  type BetaAccessSummary,
  type BetaFeatureFlagSummary,
  type BetaFormState,
  type BetaReadinessReportSummary,
  type BetaSupportTicketStatus,
  type BetaSupportTicketSummary,
  type ComplianceFormState,
  type CountryTaxConfigSummary,
  type DataExportBundle,
  type DeviceTrustSummary,
  type LaunchChecklistItemSummary,
  type LaunchFormState,
  type LaunchIncidentStatus,
  type LaunchIncidentSummary,
  type LaunchReadinessReportSummary,
  type LaunchSettingsSummary,
  type SecurityReviewSummary,
  type SessionResponse,
  type VerificationTierSummary
} from "../grogoni-application-shared";

interface UseReadinessStateDeps {
  business: ActiveBusiness | null;
  session: SessionResponse | null;
  isOnline: boolean;
  setStatusMessage: (message: string) => void;
  loadReports: (businessId: string) => Promise<void>;
  resetClientToStartup: (accountId: string | null, message: string) => Promise<void>;
  registerReset: (domainKey: string, fn: () => void) => void;
  registerRefresh: (
    domainKey: string,
    views: readonly string[],
    fn: (businessId: string) => Promise<void>
  ) => void;
}

export function useReadinessState(deps: UseReadinessStateDeps) {
  const [securityReview, setSecurityReview] = useState<SecurityReviewSummary | null>(null);
  const [dataExport, setDataExport] = useState<DataExportBundle | null>(null);
  const [verificationTier, setVerificationTier] = useState<VerificationTierSummary | null>(null);
  const [taxConfig, setTaxConfig] = useState<CountryTaxConfigSummary | null>(null);
  const [deviceTrust, setDeviceTrust] = useState<DeviceTrustSummary | null>(null);
  const [complianceForm, setComplianceForm] = useState<ComplianceFormState>(emptyComplianceForm);
  const [betaReadiness, setBetaReadiness] = useState<BetaReadinessReportSummary | null>(null);
  const [betaSupportTickets, setBetaSupportTickets] = useState<BetaSupportTicketSummary[]>([]);
  const [betaForm, setBetaForm] = useState<BetaFormState>(emptyBetaForm);
  const [launchReadiness, setLaunchReadiness] = useState<LaunchReadinessReportSummary | null>(null);
  const [launchIncidents, setLaunchIncidents] = useState<LaunchIncidentSummary[]>([]);
  const [launchForm, setLaunchForm] = useState<LaunchFormState>(emptyLaunchForm);

  // --- Compliance ---

  async function loadCompliance(businessId: string) {
    try {
      const [review, verification, tax, trust] = await Promise.all([
        getJson<SecurityReviewSummary>(`/businesses/${businessId}/compliance/security-review`),
        getJson<VerificationTierSummary>(`/businesses/${businessId}/compliance/verification`),
        getJson<CountryTaxConfigSummary>(`/businesses/${businessId}/compliance/tax-config`),
        getJson<DeviceTrustSummary>(`/businesses/${businessId}/compliance/device-trust`)
      ]);
      setSecurityReview(review);
      setVerificationTier(verification);
      setTaxConfig(tax);
      setDeviceTrust(trust);
      setComplianceForm((form) => ({
        ...form,
        verificationTier: verification.tier,
        verificationNote: verification.note ?? "",
        defaultTaxRate: String(tax.defaultTaxRate),
        taxId: tax.taxId ?? "",
        pricesIncludeTax: tax.pricesIncludeTax,
        deviceId: trust.deviceId,
        deviceTrustLevel: trust.level,
        deviceTrustReason: trust.reason ?? ""
      }));
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  async function createDataExport() {
    if (deps.business === null) {
      return;
    }

    try {
      const exportBundle = await postJson<DataExportBundle>(
        `/businesses/${deps.business.id}/compliance/export`,
        {}
      );
      setDataExport(exportBundle);
      await loadCompliance(deps.business.id);
      await deps.loadReports(deps.business.id);
      deps.setStatusMessage("Data export ready");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function saveVerificationTier() {
    if (deps.business === null) {
      return;
    }

    try {
      const verification = await patchJson<VerificationTierSummary>(
        `/businesses/${deps.business.id}/compliance/verification`,
        {
          tier: complianceForm.verificationTier,
          evidenceType:
            complianceForm.verificationTier === "unverified" ? "none" : "owner_attestation",
          note: complianceForm.verificationNote
        }
      );
      setVerificationTier(verification);
      await loadCompliance(deps.business.id);
      await deps.loadReports(deps.business.id);
      deps.setStatusMessage("Verification tier updated");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function saveTaxConfig() {
    if (deps.business === null) {
      return;
    }

    try {
      const tax = await patchJson<CountryTaxConfigSummary>(
        `/businesses/${deps.business.id}/compliance/tax-config`,
        {
          countryCode: "KE",
          defaultTaxRate: Number(complianceForm.defaultTaxRate),
          taxId: complianceForm.taxId,
          pricesIncludeTax: complianceForm.pricesIncludeTax
        }
      );
      setTaxConfig(tax);
      await deps.loadReports(deps.business.id);
      deps.setStatusMessage("Tax configuration updated");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function saveDeviceTrust() {
    if (deps.business === null) {
      return;
    }

    try {
      const trust = await patchJson<DeviceTrustSummary>(
        `/businesses/${deps.business.id}/compliance/device-trust`,
        {
          deviceId: complianceForm.deviceId,
          level: complianceForm.deviceTrustLevel,
          reason: complianceForm.deviceTrustReason
        }
      );
      setDeviceTrust(trust);
      await loadCompliance(deps.business.id);
      await deps.loadReports(deps.business.id);
      deps.setStatusMessage("Device trust updated");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function scheduleAccountDeletion(input: {
    pin: string;
    confirmation: string;
    reason: string;
  }): Promise<boolean> {
    if (deps.business === null) {
      return false;
    }

    try {
      const accountId = deps.session?.account.id ?? null;
      await postJson<{ verified: boolean }>("/auth/pin/verify", { pin: input.pin });
      await postJson<AccountDeletionRequestSummary>(
        `/businesses/${deps.business.id}/compliance/account-deletion`,
        {
          confirmation: input.confirmation,
          reason: input.reason
        }
      );
      await deps.resetClientToStartup(
        accountId,
        "Account deactivated and deletion scheduled. You have been returned to startup."
      );
      return true;
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
      return false;
    }
  }

  // --- Beta ---

  async function loadBetaReadiness(businessId: string) {
    try {
      const [readiness, tickets] = await Promise.all([
        getJson<BetaReadinessReportSummary>(`/businesses/${businessId}/beta/readiness`),
        getJson<BetaSupportTicketSummary[]>(`/businesses/${businessId}/beta/support-tickets`)
      ]);
      setBetaReadiness(readiness);
      setBetaSupportTickets(tickets);
      setBetaForm((form) => ({
        ...form,
        accessStatus: readiness.access.status,
        invitedMerchantCount: String(readiness.access.invitedMerchantCount),
        pauseReason: readiness.access.pauseReason ?? ""
      }));
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  async function updateBetaAccess() {
    if (deps.business === null) {
      return;
    }

    try {
      await patchJson<BetaAccessSummary>(`/businesses/${deps.business.id}/beta/access`, {
        status: betaForm.accessStatus,
        invitedMerchantCount: Number(betaForm.invitedMerchantCount),
        pauseReason: betaForm.pauseReason
      });
      await loadBetaReadiness(deps.business.id);
      deps.setStatusMessage("Beta access updated");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function enableBetaFlags() {
    if (deps.business === null || betaReadiness === null) {
      return;
    }

    try {
      await Promise.all(
        betaReadiness.featureFlags.map((flag) =>
          patchJson<BetaFeatureFlagSummary>(
            `/businesses/${deps.business?.id}/beta/feature-flags/${flag.key}`,
            {
              enabled: true,
              reason: "Enabled for closed beta readiness."
            }
          )
        )
      );
      await loadBetaReadiness(deps.business.id);
      deps.setStatusMessage("Beta feature flags enabled");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function recordBetaDeviceTest() {
    if (deps.business === null) {
      return;
    }

    try {
      await postJson(`/businesses/${deps.business.id}/beta/device-tests`, {
        deviceClass: betaForm.deviceClass,
        workflow: betaForm.deviceWorkflow,
        status: betaForm.deviceStatus,
        durationMs: Number(betaForm.deviceDurationMs),
        notes: "Recorded from owner shell"
      });
      await loadBetaReadiness(deps.business.id);
      deps.setStatusMessage("Beta device test recorded");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function createBetaSupportTicket() {
    if (deps.business === null) {
      return;
    }

    try {
      await postJson<BetaSupportTicketSummary>(
        `/businesses/${deps.business.id}/beta/support-tickets`,
        {
          severity: betaForm.supportSeverity,
          title: betaForm.supportTitle,
          body: betaForm.supportBody,
          source: "operator"
        }
      );
      await loadBetaReadiness(deps.business.id);
      deps.setStatusMessage("Beta support ticket created");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function updateBetaSupportTicketStatus(
    supportTicketId: string,
    status: BetaSupportTicketStatus
  ) {
    if (deps.business === null) {
      return;
    }

    try {
      await patchJson<BetaSupportTicketSummary>(
        `/businesses/${deps.business.id}/beta/support-tickets/${supportTicketId}`,
        { status }
      );
      await loadBetaReadiness(deps.business.id);
      deps.setStatusMessage("Beta support ticket updated");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function recordBetaTelemetry() {
    if (deps.business === null) {
      return;
    }

    try {
      await postJson(`/businesses/${deps.business.id}/beta/telemetry`, {
        kind: betaForm.telemetryKind,
        message: betaForm.telemetryMessage,
        metadata: {
          surface: "web",
          online: deps.isOnline
        }
      });
      await loadBetaReadiness(deps.business.id);
      deps.setStatusMessage("Beta telemetry recorded");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  // --- Launch ---

  async function loadLaunchReadiness(businessId: string) {
    try {
      const [readiness, incidents] = await Promise.all([
        getJson<LaunchReadinessReportSummary>(`/businesses/${businessId}/launch/readiness`),
        getJson<LaunchIncidentSummary[]>(`/businesses/${businessId}/launch/incidents`)
      ]);
      setLaunchReadiness(readiness);
      setLaunchIncidents(incidents);
      setLaunchForm((form) => ({
        ...form,
        status: readiness.settings.status,
        publicOnboardingEnabled: readiness.settings.publicOnboardingEnabled,
        rollbackArmed: readiness.settings.rollbackArmed,
        freezeActive: readiness.settings.freezeActive,
        allowedSignupCount: String(readiness.settings.allowedSignupCount),
        pauseReason: readiness.settings.pauseReason ?? ""
      }));
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  async function updateLaunchSettings() {
    if (deps.business === null) {
      return;
    }

    try {
      await patchJson<LaunchSettingsSummary>(`/businesses/${deps.business.id}/launch/settings`, {
        status: launchForm.status,
        publicOnboardingEnabled: launchForm.publicOnboardingEnabled,
        rollbackArmed: launchForm.rollbackArmed,
        freezeActive: launchForm.freezeActive,
        allowedSignupCount: Number(launchForm.allowedSignupCount),
        pauseReason: launchForm.pauseReason
      });
      await loadLaunchReadiness(deps.business.id);
      deps.setStatusMessage("Launch settings updated");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function updateLaunchChecklist() {
    if (deps.business === null) {
      return;
    }

    try {
      await patchJson<LaunchChecklistItemSummary>(
        `/businesses/${deps.business.id}/launch/checklist/${launchForm.checklistKey}`,
        {
          status: launchForm.checklistStatus,
          evidence: launchForm.checklistEvidence
        }
      );
      await loadLaunchReadiness(deps.business.id);
      deps.setStatusMessage("Launch checklist updated");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function createLaunchIncident() {
    if (deps.business === null) {
      return;
    }

    try {
      await postJson<LaunchIncidentSummary>(`/businesses/${deps.business.id}/launch/incidents`, {
        severity: launchForm.incidentSeverity,
        category: launchForm.incidentCategory,
        title: launchForm.incidentTitle,
        body: launchForm.incidentBody
      });
      await loadLaunchReadiness(deps.business.id);
      deps.setStatusMessage("Launch incident created");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function updateLaunchIncidentStatus(incidentId: string, status: LaunchIncidentStatus) {
    if (deps.business === null) {
      return;
    }

    try {
      await patchJson<LaunchIncidentSummary>(
        `/businesses/${deps.business.id}/launch/incidents/${incidentId}`,
        { status }
      );
      await loadLaunchReadiness(deps.business.id);
      deps.setStatusMessage("Launch incident updated");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  deps.registerReset("readiness", () => {
    setSecurityReview(null);
    setDataExport(null);
    setVerificationTier(null);
    setTaxConfig(null);
    setDeviceTrust(null);
    setBetaReadiness(null);
    setBetaSupportTickets([]);
    setLaunchReadiness(null);
    setLaunchIncidents([]);
    setComplianceForm(emptyComplianceForm);
    setBetaForm(emptyBetaForm);
    setLaunchForm(emptyLaunchForm);
  });
  deps.registerRefresh("compliance", ["compliance"], loadCompliance);
  deps.registerRefresh("beta", ["home", "beta"], loadBetaReadiness);
  deps.registerRefresh("launch", ["home", "launch"], loadLaunchReadiness);

  return {
    securityReview,
    dataExport,
    verificationTier,
    taxConfig,
    deviceTrust,
    complianceForm,
    setComplianceForm,
    loadCompliance,
    createDataExport,
    saveVerificationTier,
    saveTaxConfig,
    saveDeviceTrust,
    scheduleAccountDeletion,
    betaReadiness,
    betaSupportTickets,
    betaForm,
    setBetaForm,
    loadBetaReadiness,
    updateBetaAccess,
    enableBetaFlags,
    recordBetaDeviceTest,
    createBetaSupportTicket,
    updateBetaSupportTicketStatus,
    recordBetaTelemetry,
    launchReadiness,
    launchIncidents,
    launchForm,
    setLaunchForm,
    loadLaunchReadiness,
    updateLaunchSettings,
    updateLaunchChecklist,
    createLaunchIncident,
    updateLaunchIncidentStatus
  };
}
