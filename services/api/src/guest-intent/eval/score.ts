import type { GuestIntent } from "@grogoni/shared-types";
import type { GuestIntentClassifier, GuestIntentOutcome } from "../classifier.js";
import type { LabeledGuestMessage } from "./labeled-set.js";

/**
 * Scoring for the guest intent eval. Pure: the runner (run-guest-intent-eval.ts) supplies the
 * real classifier, the gate test (eval/score.test.ts) a fake one.
 *
 * The rules are scored the same way, as the baseline the model has to beat. They cannot tell a
 * greeting from a help request (both get the same explanation), so for them any of greeting,
 * help and about counts as right wherever one of those is the label.
 */

export const guestIntentEvalThresholds = {
  /** What the guest gets (model, or rules when the model fails) has the right intent. */
  intentAccuracy: 0.95,
  /** Messages in the never-search subset that were searched as a product. */
  maxNeverSearchViolations: 0,
  /** Searches whose query holds the product words and none of the scaffolding. */
  queryAccuracy: 0.9,
  /**
   * Latency (Julien, 2026-10-23: 5s guest budget): of the messages sent to the model, the share
   * it answered within the server limit (GUEST_INTENT_MODEL_TIMEOUT_MS, default 4000ms, which fits
   * the 5s client budget). A slower answer is a timeout and the rules answer instead.
   */
  minWithinServerLimit: 0.9,
  /** Messages the model failed for any reason other than time (error, malformed output). */
  maxErrorRate: 0.05
} as const;

/** Words that are scaffolding around a product, never part of one. */
const scaffolding = new Set(
  (
    "i im want need buy order like looking show me please pls plz do you have has is are there any " +
    "who sells sell can could get find available stock price cost much how near nairobi kisumu hi " +
    "hello habari thanks thank asante nataka natafuta kuna nipe bei ngapi ni tafadhali also too " +
    "help where wapi naweza pata mnauza anauza mtu kuagiza"
  ).split(" ")
);

function words(text: string): string[] {
  return (
    text
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function near(a: string, b: string): boolean {
  if (a === b) return true;
  const limit = b.length >= 6 ? 2 : b.length >= 4 ? 1 : 0;
  if (limit === 0 || Math.abs(a.length - b.length) > limit) return false;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]! <= limit;
}

/** The query holds every expected product word (typo allowed) and no scaffolding word. */
export function queryMatches(query: string | null, expected: string[]): boolean {
  if (query === null) return false;
  const found = words(query);
  const wanted = expected.flatMap(words);
  return (
    wanted.every((word) => found.some((candidate) => near(candidate, word))) &&
    found.every(
      (word) => !scaffolding.has(word) || wanted.some((expectedWord) => near(word, expectedWord))
    )
  );
}

export interface GuestIntentEvalRow {
  message: string;
  label: GuestIntent;
  accept: GuestIntent[];
  tags: string[];
  /** Who answered: the model, the rules after a model failure, or the rules by design (no text). */
  source: "model" | "rules_fallback" | "rules_no_text";
  intent: GuestIntent;
  query: string | null;
  failure: string | null;
  latencyMs: number;
  intentCorrect: boolean;
  queryCorrect: boolean | null;
  neverSearchViolation: boolean;
}

export interface GuestIntentEvalSummary {
  total: number;
  sentToModel: number;
  modelAnswered: number;
  fallbacks: number;
  fallbackRate: number;
  serverLimitMs: number;
  withinServerLimit: number;
  errorRate: number;
  intentAccuracy: number;
  modelIntentAccuracy: number | null;
  queryAccuracy: number;
  neverSearchTotal: number;
  neverSearchViolations: number;
  latencyMs: { p50: number; p95: number; max: number };
  byTag: Record<string, { total: number; correct: number }>;
  failures: Record<string, number>;
  pass: boolean;
  failedThresholds: string[];
}

/** A rules route as an intent, for the baseline and for the fallback path. */
export type RulesIntent = (message: string) => { intent: GuestIntent; query: string | null };

const explainIntents: GuestIntent[] = ["greeting", "help", "about"];

function row(
  item: LabeledGuestMessage,
  decided: { intent: GuestIntent; query: string | null },
  source: GuestIntentEvalRow["source"],
  failure: string | null,
  latencyMs: number,
  lenientExplain: boolean
): GuestIntentEvalRow {
  const accept = [item.intent, ...(item.accept ?? [])];
  const intentCorrect =
    accept.includes(decided.intent) ||
    (lenientExplain &&
      explainIntents.includes(decided.intent) &&
      accept.some((intent) => explainIntents.includes(intent)));
  return {
    message: item.message,
    label: item.intent,
    accept,
    tags: item.tags,
    source,
    intent: decided.intent,
    query: decided.query,
    failure,
    latencyMs,
    intentCorrect,
    queryCorrect:
      item.intent === "search"
        ? intentCorrect && queryMatches(decided.query, item.query ?? [])
        : null,
    neverSearchViolation: item.intent !== "search" && decided.intent === "search"
  };
}

/** The rules alone, scored on the same set. */
export function scoreRules(items: LabeledGuestMessage[], rules: RulesIntent): GuestIntentEvalRow[] {
  return items.map((item) => row(item, rules(item.message), "rules_fallback", null, 0, true));
}

/**
 * The production path: a message with no letters or digits never reaches the model (the client
 * answers it by rules), every other one goes to the classifier, and a failed classification is
 * answered by the rules, as the client does.
 */
export async function scoreClassifier(
  items: LabeledGuestMessage[],
  classifier: GuestIntentClassifier,
  rules: RulesIntent,
  concurrency = 4
): Promise<GuestIntentEvalRow[]> {
  const rows: GuestIntentEvalRow[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      const item = items[index]!;
      if (!/[\p{L}\p{N}]/u.test(item.message)) {
        rows[index] = row(item, rules(item.message), "rules_no_text", null, 0, true);
        continue;
      }
      const outcome: GuestIntentOutcome = await classifier.classify(item.message);
      rows[index] = outcome.ok
        ? row(item, outcome, "model", null, outcome.latencyMs, false)
        : row(item, rules(item.message), "rules_fallback", outcome.reason, outcome.latencyMs, true);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return rows;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
}

/** `serverLimitMs`: the model limit the classifier ran with (latency threshold). */
export function summarize(
  rows: GuestIntentEvalRow[],
  serverLimitMs = Number.POSITIVE_INFINITY
): GuestIntentEvalSummary {
  const ratio = (part: number, whole: number) => (whole === 0 ? 1 : part / whole);
  const sent = rows.filter((entry) => entry.source !== "rules_no_text");
  const answered = rows.filter((entry) => entry.source === "model");
  const fallbacks = rows.filter(
    (entry) => entry.source === "rules_fallback" && entry.failure !== null
  );
  const searches = rows.filter((entry) => entry.label === "search");
  const neverSearch = rows.filter((entry) => entry.label !== "search");
  const byTag: Record<string, { total: number; correct: number }> = {};
  for (const entry of rows)
    for (const tag of entry.tags.length === 0 ? ["untagged"] : entry.tags) {
      byTag[tag] ??= { total: 0, correct: 0 };
      byTag[tag].total++;
      if (entry.intentCorrect) byTag[tag].correct++;
    }
  const failures: Record<string, number> = {};
  for (const entry of fallbacks) failures[entry.failure!] = (failures[entry.failure!] ?? 0) + 1;
  const latencies = sent.map((entry) => entry.latencyMs);
  const summary = {
    total: rows.length,
    sentToModel: sent.length,
    modelAnswered: answered.length,
    fallbacks: fallbacks.length,
    fallbackRate: sent.length === 0 ? 0 : fallbacks.length / sent.length,
    serverLimitMs,
    withinServerLimit: ratio(
      answered.filter((entry) => entry.latencyMs <= serverLimitMs).length,
      sent.length
    ),
    errorRate:
      sent.length === 0
        ? 0
        : fallbacks.filter((entry) => entry.failure !== "model_timeout").length / sent.length,
    intentAccuracy: ratio(rows.filter((entry) => entry.intentCorrect).length, rows.length),
    modelIntentAccuracy:
      answered.length === 0
        ? null
        : answered.filter((entry) => entry.intentCorrect).length / answered.length,
    queryAccuracy: ratio(searches.filter((entry) => entry.queryCorrect).length, searches.length),
    neverSearchTotal: neverSearch.length,
    neverSearchViolations: neverSearch.filter((entry) => entry.neverSearchViolation).length,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.length === 0 ? 0 : Math.max(...latencies)
    },
    byTag,
    failures
  };
  const t = guestIntentEvalThresholds;
  const failedThresholds = [
    ...(summary.intentAccuracy < t.intentAccuracy
      ? [`intentAccuracy ${summary.intentAccuracy.toFixed(3)} < ${t.intentAccuracy}`]
      : []),
    ...(summary.neverSearchViolations > t.maxNeverSearchViolations
      ? [`neverSearchViolations ${summary.neverSearchViolations} > ${t.maxNeverSearchViolations}`]
      : []),
    ...(summary.queryAccuracy < t.queryAccuracy
      ? [`queryAccuracy ${summary.queryAccuracy.toFixed(3)} < ${t.queryAccuracy}`]
      : []),
    ...(summary.withinServerLimit < t.minWithinServerLimit
      ? [
          `withinServerLimit ${summary.withinServerLimit.toFixed(3)} < ${t.minWithinServerLimit} (limit ${summary.serverLimitMs}ms)`
        ]
      : []),
    ...(summary.errorRate > t.maxErrorRate
      ? [`errorRate ${summary.errorRate.toFixed(3)} > ${t.maxErrorRate}`]
      : [])
  ];
  return { ...summary, pass: failedThresholds.length === 0, failedThresholds };
}
