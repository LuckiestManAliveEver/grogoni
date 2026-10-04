import { useState } from "react";
import { reportBackgroundLoadError } from "../background-load-error";

import { getJson } from "../api-helpers";
import type {
  BusinessKnowledgeSummary,
  BusinessReportSummary
} from "../grogoni-application-shared";

interface UseReportsStateDeps {
  setStatusMessage: (message: string) => void;
  registerReset: (domainKey: string, fn: () => void) => void;
  registerRefresh: (
    domainKey: string,
    views: readonly string[],
    fn: (businessId: string) => Promise<void>
  ) => void;
}

export function useReportsState(deps: UseReportsStateDeps) {
  const [reportSummary, setReportSummary] = useState<BusinessReportSummary | null>(null);
  const [knowledgeSummary, setKnowledgeSummary] = useState<BusinessKnowledgeSummary | null>(null);

  async function loadReports(businessId: string) {
    try {
      const [report, knowledge] = await Promise.all([
        getJson<BusinessReportSummary>(
          `/businesses/${businessId}/reports/summary`,
          setReportSummary
        ),
        getJson<BusinessKnowledgeSummary>(
          `/businesses/${businessId}/knowledge`,
          setKnowledgeSummary
        )
      ]);
      setReportSummary(report);
      setKnowledgeSummary(knowledge);
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  deps.registerReset("reports", () => {
    setReportSummary(null);
    setKnowledgeSummary(null);
  });
  deps.registerRefresh("reports", ["home", "reports"], loadReports);

  return { reportSummary, knowledgeSummary, loadReports };
}
