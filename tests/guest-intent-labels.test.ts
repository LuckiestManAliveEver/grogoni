import { describe, expect, it } from "vitest";
import { guestIntentLabeledSet } from "../services/api/src/guest-intent/eval/labeled-set";
import { guestRouteForIntent } from "../apps/web/src/marketplace-search-reply";

/**
 * The labeled set's own rule (eval/labeled-set.ts): an `accept` alternative is only "just as
 * right" when the guest gets the same app reply for it. An alternative with a different reply
 * would score a wrong answer as correct.
 */
describe("guest intent labeled set", () => {
  it("accepts only alternatives that get the same app reply as the label", () => {
    const mismatched = guestIntentLabeledSet.flatMap((row) =>
      (row.accept ?? [])
        .filter(
          (alternative) =>
            JSON.stringify(guestRouteForIntent(alternative, null)) !==
            JSON.stringify(guestRouteForIntent(row.intent, null))
        )
        .map((alternative) => `${row.message} (${row.intent} vs ${alternative})`)
    );
    expect(mismatched).toEqual([]);
  });

  it("has no duplicate messages", () => {
    const seen = new Set<string>();
    const duplicates = guestIntentLabeledSet
      .map((row) => row.message)
      .filter((message) => (seen.has(message) ? true : (seen.add(message), false)));
    expect(duplicates).toEqual([]);
  });
});
