import {
  type ComplianceFormState,
  type CountryTaxConfigSummary,
  type DataExportBundle,
  type DeviceTrustLevel,
  type DeviceTrustSummary,
  type SecurityReviewSummary,
  type VerificationTier,
  type VerificationTierSummary
} from "./grogoni-application-shared";

import { ReportRow } from "./ReportRow";

export interface ComplianceSurfaceProps {
  form: ComplianceFormState;
  securityReview: SecurityReviewSummary | null;
  dataExport: DataExportBundle | null;
  verification: VerificationTierSummary | null;
  taxConfig: CountryTaxConfigSummary | null;
  deviceTrust: DeviceTrustSummary | null;
  onFormChange: (form: ComplianceFormState) => void;
  onExport: () => void;
  onSaveVerification: () => void;
  onSaveTax: () => void;
  onSaveDeviceTrust: () => void;
  onRefresh: () => void;
}

export function ComplianceSurface(props: ComplianceSurfaceProps) {
  return (
    <div className="records-surface">
      <section className="record-form" aria-label="Compliance controls">
        <div className="section-heading">
          <p className="eyebrow">Compliance</p>
          <h3>Security controls</h3>
        </div>
        <div className="metric-grid compact">
          <div className="metric">
            <span>RBAC</span>
            <strong>{props.securityReview?.rbac.gaps.length ?? 0}</strong>
          </div>
          <div className="metric">
            <span>Audits</span>
            <strong>{props.securityReview?.audit.highRiskActionCount ?? 0}</strong>
          </div>
          <div className="metric">
            <span>Logs</span>
            <strong>{props.securityReview?.sensitiveData.rawSensitiveLogFindings ?? 0}</strong>
          </div>
          <div className="metric">
            <span>TIEL</span>
            <strong>
              {props.securityReview?.tielReadiness.fullTielDeferred ? "defer" : "ready"}
            </strong>
          </div>
        </div>
        <div className="actions">
          <button type="button" onClick={props.onRefresh}>
            Refresh
          </button>
          <button type="button" onClick={props.onExport}>
            Export data
          </button>
        </div>
        {props.dataExport === null ? null : (
          <p className="shell-note">
            Export {props.dataExport.id.slice(0, 8)} ready with{" "}
            {Object.values(props.dataExport.recordCounts).reduce(
              (total, count) => total + count,
              0
            )}{" "}
            records.
          </p>
        )}
      </section>

      <section className="record-form" aria-label="Verification and tax controls">
        <div className="section-heading">
          <p className="eyebrow">Trust and tax</p>
          <h3>Verification</h3>
        </div>
        <label>
          Verification tier
          <select
            value={props.form.verificationTier}
            onChange={(event) =>
              props.onFormChange({
                ...props.form,
                verificationTier: event.target.value as VerificationTier
              })
            }
          >
            <option value="unverified">Unverified</option>
            <option value="owner_verified">Owner verified</option>
            <option value="business_verified">Business verified</option>
          </select>
        </label>
        <label>
          Verification note
          <input
            value={props.form.verificationNote}
            onChange={(event) =>
              props.onFormChange({ ...props.form, verificationNote: event.target.value })
            }
          />
        </label>
        <button type="button" onClick={props.onSaveVerification}>
          Save verification
        </button>
        <div className="form-row">
          <label>
            Default tax rate
            <input
              value={props.form.defaultTaxRate}
              onChange={(event) =>
                props.onFormChange({ ...props.form, defaultTaxRate: event.target.value })
              }
              inputMode="decimal"
            />
          </label>
          <label>
            KRA PIN
            <input
              value={props.form.taxId}
              onChange={(event) => props.onFormChange({ ...props.form, taxId: event.target.value })}
            />
          </label>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={props.form.pricesIncludeTax}
            onChange={(event) =>
              props.onFormChange({ ...props.form, pricesIncludeTax: event.target.checked })
            }
          />
          Prices include tax
        </label>
        <button type="button" onClick={props.onSaveTax}>
          Save tax config
        </button>
      </section>

      <section className="record-form" aria-label="Device trust controls">
        <div className="section-heading">
          <p className="eyebrow">Trust and identity</p>
          <h3>Device trust</h3>
        </div>
        <label>
          Device id
          <input
            value={props.form.deviceId}
            onChange={(event) =>
              props.onFormChange({ ...props.form, deviceId: event.target.value })
            }
          />
        </label>
        <label>
          Trust level
          <select
            value={props.form.deviceTrustLevel}
            onChange={(event) =>
              props.onFormChange({
                ...props.form,
                deviceTrustLevel: event.target.value as DeviceTrustLevel
              })
            }
          >
            <option value="unknown">Unknown</option>
            <option value="trusted">Trusted</option>
            <option value="restricted">Restricted</option>
          </select>
        </label>
        <label>
          Trust reason
          <input
            value={props.form.deviceTrustReason}
            onChange={(event) =>
              props.onFormChange({ ...props.form, deviceTrustReason: event.target.value })
            }
          />
        </label>
        <button type="button" onClick={props.onSaveDeviceTrust}>
          Save device trust
        </button>
      </section>

      <section className="record-list" aria-label="Compliance status">
        <ReportRow
          title="Verification"
          eyebrow={props.verification?.tier ?? "unverified"}
          body={props.verification?.note ?? "No verification evidence recorded."}
          value={props.verification?.evidenceType ?? "none"}
        />
        <ReportRow
          title="Tax"
          eyebrow={props.taxConfig?.countryCode ?? "KE"}
          body={`${props.taxConfig?.taxIdLabel ?? "KRA PIN"}: ${props.taxConfig?.taxId ?? "not set"}`}
          value={`${Math.round((props.taxConfig?.defaultTaxRate ?? 0.16) * 100)}%`}
        />
        <ReportRow
          title="Device"
          eyebrow={props.deviceTrust?.deviceId ?? props.form.deviceId}
          body={props.deviceTrust?.reason ?? "Device trust is ready for review."}
          value={props.deviceTrust?.level ?? "unknown"}
        />
      </section>
    </div>
  );
}
