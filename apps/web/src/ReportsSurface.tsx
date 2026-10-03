import {
  type BusinessKnowledgeSummary,
  type BusinessReportSummary
} from "./grogoni-application-shared";

import { formatMoney, formatPercent } from "./formatters";

import { ReportRow } from "./ReportRow";

import { EmptyStateSurface } from "./EmptyStateSurface";

export interface ReportsSurfaceProps {
  report: BusinessReportSummary | null;
  knowledge: BusinessKnowledgeSummary | null;
  onRefresh: () => void;
}

export function ReportsSurface({ report, knowledge, onRefresh }: ReportsSurfaceProps) {
  if (report === null) {
    return (
      <EmptyStateSurface
        title="Reports not loaded"
        body="Refresh to load deterministic business summaries."
        onChat={onRefresh}
        actionLabel="Refresh"
      />
    );
  }

  return (
    <div className="records-surface">
      <section className="record-form" aria-label="Report controls">
        <div className="section-heading">
          <p className="eyebrow">Reports</p>
          <h3>Business summary</h3>
        </div>
        <div className="metric-grid compact">
          <div className="metric">
            <span>Sales</span>
            <strong>{formatMoney(report.sales.grossSales)}</strong>
          </div>
          <div className="metric">
            <span>Collected</span>
            <strong>{formatMoney(report.sales.collectedTotal)}</strong>
          </div>
          <div className="metric">
            <span>Debt</span>
            <strong>{formatMoney(report.debts.totalOutstanding)}</strong>
          </div>
        </div>
        <button type="button" onClick={onRefresh}>
          Refresh reports
        </button>
      </section>

      <section className="record-list" aria-label="Report sections">
        <ReportRow
          title="Inventory"
          eyebrow={`${report.inventory.productCount} products`}
          body={`${report.inventory.lowStockCount} low stock, ${report.inventory.outOfStockCount} out of stock, ${report.inventory.totalUnitsOnHand} units on hand.`}
          value={`${report.inventory.movementCount} movements`}
        />
        <ReportRow
          title="Payments"
          eyebrow={`${report.payments.paymentCount} payments`}
          body={`${report.payments.paidInvoiceCount} paid, ${report.payments.partiallyPaidInvoiceCount} partial, ${report.payments.unpaidInvoiceCount} unpaid invoices.`}
          value={formatMoney(report.payments.totalPaid)}
        />
        <ReportRow
          title="Imports"
          eyebrow={`${report.imports.totalJobs} jobs`}
          body={`${report.imports.confirmedJobs} confirmed, ${report.imports.previewedJobs} previewed, ${report.imports.failedJobs} failed.`}
          value={`${report.imports.confirmedRows} rows`}
        />
        <ReportRow
          title="Logistics"
          eyebrow={`${report.logistics.fulfillmentCount} records`}
          body={`${report.logistics.pendingCount} pending, ${report.logistics.readyCount} ready, ${report.logistics.outForDeliveryCount} dispatched.`}
          value={`${report.logistics.activeCount} active`}
        />
        <ReportRow
          title="Compliance"
          eyebrow={`${report.compliance.exportCount} exports`}
          body={`${report.compliance.scheduledAnonymizationCount} scheduled anonymizations, ${report.compliance.highRiskAuditEventCount} high-risk audit events.`}
          value={report.compliance.verificationTier}
        />
        <ReportRow
          title="Beta"
          eyebrow={report.beta.status}
          body={`${report.beta.gates.filter((gate) => !gate.passed).length} gates need review, ${report.beta.support.openTicketCount} support tickets open.`}
          value={formatPercent(report.beta.telemetry.crashFreeSessionRate)}
        />
        <ReportRow
          title="Launch"
          eyebrow={report.launch.status}
          body={`${report.launch.gates.filter((gate) => !gate.passed).length} gates need review, ${report.launch.support.openIncidentCount} incidents open.`}
          value={`${report.launch.checklist.passed}/${report.launch.checklist.total} checks`}
        />
        <ReportRow
          title="Sync"
          eyebrow={`${report.sync.total} queued records`}
          body={`${report.sync.pending} pending, ${report.sync.failed} failed, ${report.sync.conflict} conflicts.`}
          value={`${report.sync.active} active`}
        />
      </section>

      <section className="record-list" aria-label="Knowledge facts">
        <div className="section-heading">
          <p className="eyebrow">Knowledge</p>
          <h3>Runtime-safe facts</h3>
        </div>
        {knowledge?.facts.map((fact) => (
          <article className="record-row" key={`${fact.topic}-${fact.detail}`}>
            <div>
              <p className="eyebrow">{fact.severity}</p>
              <h4>{fact.topic}</h4>
              <p>{fact.detail}</p>
            </div>
            <strong>{fact.metric}</strong>
          </article>
        )) ?? null}
      </section>
    </div>
  );
}
