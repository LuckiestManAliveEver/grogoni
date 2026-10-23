// Paid eval for the guest intent classifier (services/api/src/guest-intent/README.md).
// Run: pnpm eval:guest-intent [--report <path>]
// Classifies every message in services/api/src/guest-intent/eval/labeled-set.ts with the real
// platform default model through OpenRouter (OPENROUTER_API_KEY from .env or .env.openrouter),
// exactly as the endpoint does, falls back to the rules where the endpoint would, and scores the
// result against the thresholds in eval/score.ts. Also scores the rules alone as the baseline.
// Writes a JSON report; exit 0 = pass, 1 = below threshold, 2 = not run (no model configured).
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GuestIntent } from "@grogoni/shared-types";
import { routeGuestMessage } from "../apps/web/src/marketplace-search-reply.ts";
import { readGuestIntentConfiguration } from "../services/api/src/guest-intent/service.ts";
import { guestIntentLabeledSet } from "../services/api/src/guest-intent/eval/labeled-set.ts";
import {
  guestIntentEvalThresholds,
  scoreClassifier,
  scoreRules,
  summarize,
  type RulesIntent
} from "../services/api/src/guest-intent/eval/score.ts";

const reportFlag = process.argv.indexOf("--report");
const reportPath =
  reportFlag === -1
    ? join(tmpdir(), "guest-intent-eval-report.json")
    : process.argv[reportFlag + 1]!;

/** The rules' answer as an intent. Greeting, help and about share one reply; it reads as help. */
const rulesIntent: RulesIntent = (message) => {
  const route = routeGuestMessage(message);
  if (route.kind === "search") return { intent: "search", query: route.query };
  const intent: GuestIntent = route.reply.startsWith("You're welcome")
    ? "thanks"
    : route.reply.startsWith("I can't look up orders")
      ? "order_help"
      : route.reply.startsWith("To sell on Grogoni")
        ? "selling"
        : "help";
  return { intent, query: null };
};

const rulesRows = scoreRules(guestIntentLabeledSet, rulesIntent);
const rulesBaseline = summarize(rulesRows);
const configuration = readGuestIntentConfiguration(process.env);
const write = (report: unknown) => {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${reportPath}`);
};
const baselineOut = {
  intentAccuracy: rulesBaseline.intentAccuracy,
  queryAccuracy: rulesBaseline.queryAccuracy,
  neverSearchViolations: rulesBaseline.neverSearchViolations,
  wrong: rulesRows
    .filter((entry) => !entry.intentCorrect || entry.queryCorrect === false)
    .map(({ message, label, intent, query }) => ({ message, label, intent, query }))
};

if (configuration.classifier === null) {
  console.error(`NOT RUN: ${configuration.disabledReason}. No model results were produced.`);
  write({
    status: "not_run",
    reason: configuration.disabledReason,
    ranAt: new Date().toISOString(),
    labeledMessages: guestIntentLabeledSet.length,
    thresholds: guestIntentEvalThresholds,
    rulesBaseline: baselineOut
  });
  process.exit(2);
}

const started = Date.now();
const rows = await scoreClassifier(guestIntentLabeledSet, configuration.classifier, rulesIntent);
const summary = summarize(rows);
write({
  status: summary.pass ? "pass" : "fail",
  ranAt: new Date().toISOString(),
  modelId: configuration.classifier.modelId,
  durationMs: Date.now() - started,
  thresholds: guestIntentEvalThresholds,
  summary,
  rulesBaseline: baselineOut,
  wrong: rows.filter(
    (entry) => !entry.intentCorrect || entry.queryCorrect === false || entry.neverSearchViolation
  ),
  rows
});
console.log(
  JSON.stringify(
    {
      status: summary.pass ? "pass" : "fail",
      intentAccuracy: summary.intentAccuracy,
      modelIntentAccuracy: summary.modelIntentAccuracy,
      queryAccuracy: summary.queryAccuracy,
      neverSearchViolations: summary.neverSearchViolations,
      fallbackRate: summary.fallbackRate,
      latencyMs: summary.latencyMs,
      rulesBaselineIntentAccuracy: rulesBaseline.intentAccuracy,
      failedThresholds: summary.failedThresholds
    },
    null,
    2
  )
);
process.exit(summary.pass ? 0 : 1);
