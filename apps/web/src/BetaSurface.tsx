import {
  type BetaAccessStatus,
  type BetaDeviceClass,
  type BetaDeviceTestStatus,
  type BetaFormState,
  type BetaReadinessReportSummary,
  type BetaSupportSeverity,
  type BetaSupportTicketStatus,
  type BetaSupportTicketSummary,
  type BetaTelemetryKind
} from "./grogoni-application-shared";

import { formatPercent } from "./formatters";

import { ReportRow } from "./ReportRow";

export interface BetaSurfaceProps {
  form: BetaFormState;
  readiness: BetaReadinessReportSummary | null;
  supportTickets: BetaSupportTicketSummary[];
  onFormChange: (form: BetaFormState) => void;
  onUpdateAccess: () => void;
  onEnableFlags: () => void;
  onRecordDeviceTest: () => void;
  onCreateSupportTicket: () => void;
  onUpdateSupportTicket: (supportTicketId: string, status: BetaSupportTicketStatus) => void;
  onRecordTelemetry: () => void;
  onRefresh: () => void;
}

export function BetaSurface(props: BetaSurfaceProps) {
  const failedGates = props.readiness?.gates.filter((gate) => !gate.passed) ?? [];

  return (
    <div className="records-surface">
      <section className="record-form" aria-label="Beta readiness controls">
        <div className="section-heading">
          <p className="eyebrow">Beta</p>
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
            <span>Crash-free</span>
            <strong>{formatPercent(props.readiness?.telemetry.crashFreeSessionRate ?? 1)}</strong>
          </div>
          <div className="metric">
            <span>Support</span>
            <strong>{props.readiness?.support.openTicketCount ?? 0}</strong>
          </div>
        </div>
        <div className="actions">
          <button type="button" onClick={props.onRefresh}>
            Refresh
          </button>
          <button type="button" onClick={props.onEnableFlags}>
            Enable flags
          </button>
        </div>
      </section>

      <section className="record-form" aria-label="Closed beta access">
        <div className="section-heading">
          <p className="eyebrow">Access gate</p>
          <h3>Closed beta</h3>
        </div>
        <label>
          Access status
          <select
            value={props.form.accessStatus}
            onChange={(event) =>
              props.onFormChange({
                ...props.form,
                accessStatus: event.target.value as BetaAccessStatus
              })
            }
          >
            <option value="not_invited">Not invited</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </select>
        </label>
        <label>
          Invited merchants
          <input
            value={props.form.invitedMerchantCount}
            onChange={(event) =>
              props.onFormChange({ ...props.form, invitedMerchantCount: event.target.value })
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
        <button type="button" onClick={props.onUpdateAccess}>
          Save access
        </button>
      </section>

      <section className="record-form" aria-label="Device and telemetry controls">
        <div className="section-heading">
          <p className="eyebrow">Reliability</p>
          <h3>Device and telemetry</h3>
        </div>
        <div className="form-row">
          <label>
            Device class
            <select
              value={props.form.deviceClass}
              onChange={(event) =>
                props.onFormChange({
                  ...props.form,
                  deviceClass: event.target.value as BetaDeviceClass
                })
              }
            >
              <option value="android_1gb">Android 1 GB</option>
              <option value="android_2gb">Android 2 GB</option>
            </select>
          </label>
          <label>
            Test status
            <select
              value={props.form.deviceStatus}
              onChange={(event) =>
                props.onFormChange({
                  ...props.form,
                  deviceStatus: event.target.value as BetaDeviceTestStatus
                })
              }
            >
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
            </select>
          </label>
        </div>
        <label>
          Workflow
          <input
            value={props.form.deviceWorkflow}
            onChange={(event) =>
              props.onFormChange({ ...props.form, deviceWorkflow: event.target.value })
            }
          />
        </label>
        <label>
          Duration ms
          <input
            value={props.form.deviceDurationMs}
            onChange={(event) =>
              props.onFormChange({ ...props.form, deviceDurationMs: event.target.value })
            }
            inputMode="numeric"
          />
        </label>
        <button type="button" onClick={props.onRecordDeviceTest}>
          Record device test
        </button>
        <label>
          Telemetry kind
          <select
            value={props.form.telemetryKind}
            onChange={(event) =>
              props.onFormChange({
                ...props.form,
                telemetryKind: event.target.value as BetaTelemetryKind
              })
            }
          >
            <option value="session">Session</option>
            <option value="error">Error</option>
            <option value="crash">Crash</option>
          </select>
        </label>
        <label>
          Telemetry message
          <input
            value={props.form.telemetryMessage}
            onChange={(event) =>
              props.onFormChange({ ...props.form, telemetryMessage: event.target.value })
            }
          />
        </label>
        <button type="button" onClick={props.onRecordTelemetry}>
          Record telemetry
        </button>
      </section>

      <section className="record-form" aria-label="Support controls">
        <div className="section-heading">
          <p className="eyebrow">Support</p>
          <h3>Issue intake</h3>
        </div>
        <label>
          Severity
          <select
            value={props.form.supportSeverity}
            onChange={(event) =>
              props.onFormChange({
                ...props.form,
                supportSeverity: event.target.value as BetaSupportSeverity
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
          Title
          <input
            value={props.form.supportTitle}
            onChange={(event) =>
              props.onFormChange({ ...props.form, supportTitle: event.target.value })
            }
          />
        </label>
        <label>
          Body
          <textarea
            value={props.form.supportBody}
            onChange={(event) =>
              props.onFormChange({ ...props.form, supportBody: event.target.value })
            }
            rows={3}
          />
        </label>
        <button type="button" onClick={props.onCreateSupportTicket}>
          Create ticket
        </button>
      </section>

      <section className="record-list" aria-label="Beta readiness status">
        {props.readiness?.gates.map((gate) => (
          <ReportRow
            key={gate.key}
            title={gate.key.replaceAll("_", " ")}
            eyebrow={gate.passed ? "passed" : "needs review"}
            body={gate.detail}
            value={gate.passed ? "ok" : "fix"}
          />
        )) ?? null}
        {props.supportTickets.map((ticket) => (
          <article className="record-row" key={ticket.id}>
            <div>
              <p className="eyebrow">
                {ticket.severity} - {ticket.status}
              </p>
              <h4>{ticket.title}</h4>
              <p>{ticket.bodySummary}</p>
            </div>
            <div className="row-actions compact-actions">
              {ticket.status === "open" ? (
                <button
                  type="button"
                  onClick={() => props.onUpdateSupportTicket(ticket.id, "triaged")}
                >
                  Triage
                </button>
              ) : null}
              {ticket.status !== "resolved" ? (
                <button
                  className="secondary"
                  type="button"
                  onClick={() => props.onUpdateSupportTicket(ticket.id, "resolved")}
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
