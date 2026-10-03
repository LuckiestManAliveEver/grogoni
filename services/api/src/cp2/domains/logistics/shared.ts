import type { LogisticsReportSummary, LogisticsSummary } from "@grogoni/shared-types";

export function summarizeLogistics(logistics: LogisticsSummary[]): LogisticsReportSummary {
  const summary: LogisticsReportSummary = {
    fulfillmentCount: logistics.length,
    pendingCount: 0,
    readyCount: 0,
    outForDeliveryCount: 0,
    completedCount: 0,
    cancelledCount: 0,
    activeCount: 0
  };

  for (const item of logistics) {
    if (item.status === "pending") {
      summary.pendingCount += 1;
    }

    if (item.status === "ready") {
      summary.readyCount += 1;
    }

    if (item.status === "out_for_delivery") {
      summary.outForDeliveryCount += 1;
    }

    if (item.status === "completed") {
      summary.completedCount += 1;
    }

    if (item.status === "cancelled") {
      summary.cancelledCount += 1;
    }

    if (item.status !== "completed" && item.status !== "cancelled") {
      summary.activeCount += 1;
    }
  }

  return summary;
}
