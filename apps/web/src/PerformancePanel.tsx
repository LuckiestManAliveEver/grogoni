import { useEffect, useState } from "react";
import {
  isPerformanceDebugEnabled,
  subscribeToPerformanceEvents,
  type GrogoniPerformanceEvent
} from "./performance";

const eventLimit = 16;

interface PerformanceSummary {
  apiRequestCount: number;
  apiAverageMs: number | null;
  apiSlowestMs: number | null;
  latestReadinessMs: number | null;
  latestNavigationMs: number | null;
  longTaskCount: number;
  cumulativeLayoutShift: number;
  failedRequestCount: number;
}

const emptySummary: PerformanceSummary = {
  apiRequestCount: 0,
  apiAverageMs: null,
  apiSlowestMs: null,
  latestReadinessMs: null,
  latestNavigationMs: null,
  longTaskCount: 0,
  cumulativeLayoutShift: 0,
  failedRequestCount: 0
};

export function PerformancePanel() {
  const [events, setEvents] = useState<GrogoniPerformanceEvent[]>([]);
  const [summary, setSummary] = useState<PerformanceSummary>(emptySummary);
  const [collapsed, setCollapsed] = useState(false);
  const enabled = isPerformanceDebugEnabled();

  useEffect(() => {
    if (!enabled) return;
    return subscribeToPerformanceEvents((event) => {
      setEvents((current) => [...current.slice(-(eventLimit - 1)), event]);
      setSummary((current) => reduceSummary(current, event));
    });
  }, [enabled]);

  if (!enabled) return null;

  return (
    <aside className="performance-panel" aria-label="Performance diagnostics">
      <div className="performance-panel__header">
        <div>
          <strong>App performance</strong>
          <span>
            {events.length === 0 ? "Waiting for metrics" : `${events.length} recent events`}
          </span>
        </div>
        <div className="performance-panel__actions">
          <button
            type="button"
            onClick={() => setCollapsed((current) => !current)}
            aria-label={
              collapsed ? "Expand performance dashboard" : "Collapse performance dashboard"
            }
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? "+" : "-"}
          </button>
          <button
            type="button"
            onClick={() => {
              setEvents([]);
              setSummary(emptySummary);
            }}
            aria-label="Clear performance diagnostics"
            title="Clear"
          >
            Clear
          </button>
        </div>
      </div>
      {!collapsed && (
        <>
          <dl className="performance-panel__metrics">
            <Metric label="Ready" value={formatMs(summary.latestReadinessMs)} />
            <Metric label="Nav" value={formatMs(summary.latestNavigationMs)} />
            <Metric label="API avg" value={formatMs(summary.apiAverageMs)} />
            <Metric label="API slow" value={formatMs(summary.apiSlowestMs)} />
            <Metric label="Long tasks" value={String(summary.longTaskCount)} />
            <Metric label="CLS" value={formatNumber(summary.cumulativeLayoutShift)} />
            <Metric label="Requests" value={String(summary.apiRequestCount)} />
            {summary.failedRequestCount > 0 ? (
              <Metric label="Failures" value={String(summary.failedRequestCount)} tone="warn" />
            ) : (
              <Metric label="Failures" value="0" />
            )}
          </dl>
          <ol className="performance-panel__events">
            {events.map((event, index) => (
              <li key={`${event.timestamp}-${event.event}-${index}`}>
                <span>{event.event}</span>
                <code>{compactDetails(event.details)}</code>
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className={tone === undefined ? undefined : `performance-panel__metric--${tone}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function reduceSummary(
  current: PerformanceSummary,
  event: GrogoniPerformanceEvent
): PerformanceSummary {
  if (event.event === "api-request") {
    const durationMs = numericDetail(event, "durationMs");
    const status = event.details.status;
    const apiRequestCount = current.apiRequestCount + 1;
    const apiAverageMs =
      durationMs === null
        ? current.apiAverageMs
        : current.apiAverageMs === null
          ? durationMs
          : (current.apiAverageMs * current.apiRequestCount + durationMs) / apiRequestCount;
    return {
      ...current,
      apiRequestCount,
      apiAverageMs,
      apiSlowestMs:
        durationMs === null
          ? current.apiSlowestMs
          : Math.max(current.apiSlowestMs ?? 0, durationMs),
      failedRequestCount:
        status === "failed" || (typeof status === "number" && status >= 500)
          ? current.failedRequestCount + 1
          : current.failedRequestCount
    };
  }

  if (event.event === "readiness") {
    return { ...current, latestReadinessMs: numericDetail(event, "atMs") };
  }

  if (event.event === "navigation-interactive" || event.event === "first-visible-render") {
    return { ...current, latestNavigationMs: numericDetail(event, "durationMs") };
  }

  if (event.event === "long-task") {
    return { ...current, longTaskCount: current.longTaskCount + 1 };
  }

  if (event.event === "layout-shift") {
    return {
      ...current,
      cumulativeLayoutShift: current.cumulativeLayoutShift + (numericDetail(event, "value") ?? 0)
    };
  }

  return current;
}

function compactDetails(details: Record<string, unknown>): string {
  return Object.entries(details)
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}

function numericDetail(event: GrogoniPerformanceEvent, key: string): number | null {
  const value = event.details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatMs(value: number | null): string {
  return value === null ? "-" : `${Math.round(value)}ms`;
}

function formatNumber(value: number): string {
  return value === 0 ? "0" : value.toFixed(3);
}
