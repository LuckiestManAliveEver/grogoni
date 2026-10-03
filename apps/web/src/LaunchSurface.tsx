import {
  type LaunchAccessStatus,
  type LaunchChecklistKey,
  type LaunchChecklistStatus,
  type LaunchFormState,
  type LaunchIncidentCategory,
  type LaunchIncidentSeverity,
  type LaunchIncidentStatus,
  type LaunchIncidentSummary,
  type LaunchReadinessReportSummary
} from "./grogoni-application-shared";

import { ReportRow } from "./ReportRow";

export interface LaunchSurfaceProps {
  form: LaunchFormState;
  readiness: LaunchReadinessReportSummary | null;
  incidents: LaunchIncidentSummary[];
  onFormChange: (form: LaunchFormState) => void;
  onUpdateSettings: () => void;
  onUpdateChecklist: () => void;
  onCreateIncident: () => void;
  onUpdateIncident: (incidentId: string, status: LaunchIncidentStatus) => void;
  onRefresh: () => void;
}

export function LaunchSurface(props: LaunchSurfaceProps) {
  const failedGates = props.readiness?.gates.filter((gate) => !gate.passed) ?? [];

  return (
    <div className="records-surface">
      <section className="record-form" aria-label="Public launch readiness controls">
        <div className="section-heading">
          <p className="eyebrow">Launch</p>
          <h3>Readiness gates</h3>
        </div>
        <div className="metric-grid compact">
          <div className="metric">
            <span>Status</span>
            <strong>{props.readiness?.status ?? "pending"}</strong>
          </div>
          <div className="metric">
            <span>Gates</span>
            <strong>{failedGates.length}</strong>
          </div>
          <div className="metric">
            <span>Checklist</span>
            <strong>
              {props.readiness?.checklist.passed ?? 0}/{props.readiness?.checklist.total ?? 0}
            </strong>
          </div>
          <div className="metric">
            <span>Incidents</span>
            <strong>{props.readiness?.support.openIncidentCount ?? 0}</strong>
          </div>
        </div>
        <div className="actions">
          <button type="button" onClick={props.onRefresh}>
            Refresh
          </button>
        </div>
      </section>

      <section className="record-form" aria-label="Launch settings">
        <div className="section-heading">
          <p className="eyebrow">Onboarding gate</p>
          <h3>Public access</h3>
        </div>
        <label>
          Launch status
          <select
            value={props.form.status}
            onChange={(event) =>
              props.onFormChange({
                ...props.form,
                status: event.target.value as LaunchAccessStatus
              })
            }
          >
            <option value="closed">Closed</option>
            <option value="open">Open</option>
            <option value="paused">Paused</option>
          </select>
        </label>
        <label>
          Allowed signups
          <input
            value={props.form.allowedSignupCount}
            onChange={(event) =>
              props.onFormChange({ ...props.form, allowedSignupCount: event.target.value })
            }
            inputMode="numeric"
          />
        </label>
        <label>
          Pause reason
          <input
            value={props.form.pauseReason}
            onChange={(event) =>
              props.onFormChange({ ...props.form, pauseReason: event.target.value })
            }
          />
        </label>
        <div className="toggle-row">
          <label>
            <input
              type="checkbox"
              checked={props.form.publicOnboardingEnabled}
              onChange={(event) =>
                props.onFormChange({
                  ...props.form,
                  publicOnboardingEnabled: event.target.checked
                })
              }
            />
            Public onboarding
          </label>
          <label>
            <input
              type="checkbox"
              checked={props.form.rollbackArmed}
              onChange={(event) =>
                props.onFormChange({ ...props.form, rollbackArmed: event.target.checked })
              }
            />
            Rollback armed
          </label>
          <label>
            <input
              type="checkbox"
              checked={props.form.freezeActive}
              onChange={(event) =>
                props.onFormChange({ ...props.form, freezeActive: event.target.checked })
              }
            />
            Freeze active
          </label>
        </div>
        <button type="button" onClick={props.onUpdateSettings}>
          Save launch settings
        </button>
      </section>

      <section className="record-form" aria-label="Production checklist">
        <div className="section-heading">
          <p className="eyebrow">Production readiness</p>
          <h3>Checklist</h3>
        </div>
        <label>
          Checklist item
          <select
            value={props.form.checklistKey}
            onChange={(event) =>
              props.onFormChange({
                ...props.form,
                checklistKey: event.target.value as LaunchChecklistKey
              })
            }
          >
            {[
              "environment_config",
              "secrets_ready",
              "backup_verified",
              "monitoring_ready",
              "deploy_verified",
              "rollback_runbook",
              "support_coverage"
            ].map((key) => (
              <option key={key} value={key}>
                {key.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select
            value={props.form.checklistStatus}
            onChange={(event) =>
              props.onFormChange({
                ...props.form,
                checklistStatus: event.target.value as LaunchChecklistStatus
              })
            }
          >
            <option value="pending">Pending</option>
            <option value="passed">Passed</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <label>
          Evidence
          <input
            value={props.form.checklistEvidence}
            onChange={(event) =>
              props.onFormChange({ ...props.form, checklistEvidence: event.target.value })
            }
          />
        </label>
        <button type="button" onClick={props.onUpdateChecklist}>
          Save checklist
        </button>
      </section>

      <section className="record-form" aria-label="Launch incident controls">
        <div className="section-heading">
          <p className="eyebrow">Support</p>
          <h3>Incidents</h3>
        </div>
        <div className="form-row">
          <label>
            Severity
            <select
              value={props.form.incidentSeverity}
              onChange={(event) =>
                props.onFormChange({
                  ...props.form,
                  incidentSeverity: event.target.value as LaunchIncidentSeverity
                })
              }
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <label>
            Category
            <select
              value={props.form.incidentCategory}
              onChange={(event) =>
                props.onFormChange({
                  ...props.form,
                  incidentCategory: event.target.value as LaunchIncidentCategory
                })
              }
            >
              <option value="onboarding">Onboarding</option>
              <option value="payments">Payments</option>
              <option value="sync">Sync</option>
              <option value="support">Support</option>
              <option value="telemetry">Telemetry</option>
              <option value="rollback">Rollback</option>
            </select>
          </label>
        </div>
        <label>
          Title
          <input
            value={props.form.incidentTitle}
            onChange={(event) =>
              props.onFormChange({ ...props.form, incidentTitle: event.target.value })
            }
          />
        </label>
        <label>
          Body
          <textarea
            value={props.form.incidentBody}
            onChange={(event) =>
              props.onFormChange({ ...props.form, incidentBody: event.target.value })
            }
            rows={3}
          />
        </label>
        <button type="button" onClick={props.onCreateIncident}>
          Create incident
        </button>
      </section>

      <section className="record-list" aria-label="Launch readiness status">
        {props.readiness?.gates.map((gate) => (
          <ReportRow
            key={gate.key}
            title={gate.key.replaceAll("_", " ")}
            eyebrow={gate.passed ? "passed" : "needs review"}
            body={gate.detail}
            value={gate.passed ? "ok" : "fix"}
          />
        )) ?? null}
        {props.incidents.map((incident) => (
          <article className="record-row" key={incident.id}>
            <div>
              <p className="eyebrow">
                {incident.category} - {incident.severity} - {incident.status}
              </p>
              <h4>{incident.title}</h4>
              <p>{incident.bodySummary}</p>
            </div>
            <div className="row-actions compact-actions">
              {incident.status === "open" ? (
                <button
                  type="button"
                  onClick={() => props.onUpdateIncident(incident.id, "mitigating")}
                >
                  Mitigate
                </button>
              ) : null}
              {incident.status !== "resolved" ? (
                <button
                  className="secondary"
                  type="button"
                  onClick={() => props.onUpdateIncident(incident.id, "resolved")}
                >
                  Resolve
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
