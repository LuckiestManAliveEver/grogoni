import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GuestIntentClassifier, GuestIntentOutcome } from "../classifier.js";
import { guestIntentLabeledSet } from "./labeled-set.js";
import { queryMatches, scoreClassifier, scoreRules, summarize, type RulesIntent } from "./score.js";

/**
 * Gate test for the paid eval's own machinery (no model): the labeled set covers every phrasing
 * the review rounds pinned, and the scorer fails a classifier that searches what it must not.
 */
const routingTest = readFileSync(
  new URL("../../../../../tests/guest-chat-routing.test.tsx", import.meta.url),
  "utf8"
);

/** Every message in the it.each tables of the "guest message routing" block. */
function pinnedPhrasings(): string[] {
  const block = routingTest.slice(0, routingTest.indexOf('describe("buy intent"'));
  return [...block.matchAll(/it\.each\(\[([\s\S]*?)\]\)\(/gu)].flatMap((table) =>
    [...table[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/gu)]
      .map((literal) => JSON.parse(`"${literal[1]}"`) as string)
      .filter((value) => !value.startsWith("search:"))
  );
}

const messages = new Set(guestIntentLabeledSet.map((item) => item.message));

describe("guest intent labeled set", () => {
  it("has at least 80 messages, each once", () => {
    expect(guestIntentLabeledSet.length).toBeGreaterThanOrEqual(80);
    expect(messages.size).toBe(guestIntentLabeledSet.length);
  });

  it("includes every phrasing the review rounds pinned in the routing tests", () => {
    const pinned = pinnedPhrasings();
    expect(pinned.length).toBeGreaterThan(100);
    expect(pinned.filter((message) => !messages.has(message))).toEqual([]);
  });

  it("covers Swahili, typos, mixed intents, injection, and every intent", () => {
    const tags = guestIntentLabeledSet.flatMap((item) => item.tags);
    for (const tag of ["critic", "sw", "typo", "mixed", "injection"])
      expect(tags.filter((value) => value === tag).length, tag).toBeGreaterThanOrEqual(4);
    expect(new Set(guestIntentLabeledSet.map((item) => item.intent))).toEqual(
      new Set(["search", "greeting", "thanks", "help", "about", "order_help", "selling"])
    );
    for (const item of guestIntentLabeledSet)
      if (item.intent === "search") expect(item.query?.length, item.message).toBeGreaterThan(0);
  });
});

/** A fake classifier answering from a table, with no network. */
function fake(
  answer: (message: string) => GuestIntentOutcome | Promise<GuestIntentOutcome>
): GuestIntentClassifier {
  return { modelId: "fake", classify: async (message) => answer(message) };
}

const perfect = fake((message) => {
  const item = guestIntentLabeledSet.find((entry) => entry.message === message)!;
  return {
    ok: true,
    intent: item.intent,
    query: item.intent === "search" ? item.query!.join(" ") : null,
    modelId: "fake",
    latencyMs: 100
  };
});
const rules: RulesIntent = () => ({ intent: "help", query: null });

describe("guest intent eval scoring", () => {
  it("passes a classifier that matches every label", async () => {
    const summary = summarize(await scoreClassifier(guestIntentLabeledSet, perfect, rules));
    expect(summary.failedThresholds).toEqual([]);
    expect(summary.pass).toBe(true);
    expect(summary.intentAccuracy).toBe(1);
    // Emoji and punctuation never reach the model, as in the client.
    expect(summary.sentToModel).toBeLessThan(summary.total);
  });

  it("fails a classifier that searches a single non-product, however accurate otherwise", async () => {
    const searchesHello = fake(async (message) =>
      message === "hello there"
        ? { ok: true, intent: "search", query: "hello there", modelId: "fake", latencyMs: 1 }
        : perfect.classify(message)
    );
    const summary = summarize(await scoreClassifier(guestIntentLabeledSet, searchesHello, rules));
    expect(summary.intentAccuracy).toBeGreaterThan(0.99);
    expect(summary.neverSearchViolations).toBe(1);
    expect(summary.pass).toBe(false);
  });

  it("fails when the model mostly times out, even if the rules cover for it", async () => {
    const slow = fake(() => ({ ok: false, reason: "model_timeout", latencyMs: 2_500 }));
    const summary = summarize(await scoreClassifier(guestIntentLabeledSet, slow, rules));
    expect(summary.failures).toMatchObject({ model_timeout: summary.sentToModel });
    expect(summary.failedThresholds.some((entry) => entry.startsWith("fallbackRate"))).toBe(true);
  });

  it("scores queries on the product words and refuses leftover scaffolding", () => {
    expect(queryMatches("sugar", ["sugar"])).toBe(true);
    expect(queryMatches("suger", ["sugar"])).toBe(true);
    expect(queryMatches("mafuta ya kupika", ["mafuta"])).toBe(true);
    expect(queryMatches("sugar near me", ["sugar"])).toBe(false);
    expect(queryMatches("looking for rice", ["rice"])).toBe(false);
    expect(queryMatches("rice", ["sugar"])).toBe(false);
    expect(queryMatches(null, ["sugar"])).toBe(false);
  });

  it("scores the rules on the same set as the baseline", () => {
    const rows = scoreRules(guestIntentLabeledSet, rules);
    expect(rows).toHaveLength(guestIntentLabeledSet.length);
    expect(summarize(rows).queryAccuracy).toBe(0);
  });
});
