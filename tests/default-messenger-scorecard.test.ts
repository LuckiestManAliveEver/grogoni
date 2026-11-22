import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scoreScorecard, scorecardPath } from "../scripts/score-messenger.mjs";

type Score = {
  areas: {
    name: string;
    weight: number;
    done: number;
    open: number;
    excluded: number;
    percent: number;
  }[];
  total: number;
  errors: string[];
};
const score = (markdown: string, exists: (file: string) => boolean = () => true) =>
  scoreScorecard(markdown, exists) as Score;

describe("default messenger scorecard", () => {
  it("the checked-in scorecard is valid: weights total 100 and every done item has evidence", () => {
    const result = score(readFileSync(scorecardPath, "utf8"), undefined as never);
    expect(result.errors).toEqual([]);
    expect(result.total).toBeGreaterThan(0);
    expect(result.total).toBeLessThan(100);
  });

  it("weights each area by done / (done + open) and leaves excluded items out", () => {
    const result = score(
      [
        "## A (weight 60)",
        "- [x] one. evidence: a.ts",
        "- [ ] two.",
        "## B (weight 40)",
        "- [x] three. evidence: b.ts",
        "- [-] four. reason: decided"
      ].join("\n")
    );
    expect(result.errors).toEqual([]);
    expect(result.areas.map((area) => area.percent)).toEqual([50, 100]);
    expect(result.total).toBe(70);
  });

  it.each([
    ["## A (weight 100)\n- [x] done without proof.", /cites no evidence/u],
    ["## A (weight 100)\n- [x] done. evidence: gone.ts", /evidence gone\.ts missing/u],
    [
      "## A (weight 100)\n- [x] ok. evidence: a.ts\n- [-] skipped.",
      /excluded item gives no reason/u
    ],
    ["## A (weight 90)\n- [x] ok. evidence: a.ts", /add up to 90/u],
    ["- [x] orphan. evidence: a.ts\n## A (weight 100)\n- [ ] x", /before any/u],
    ["## A (weight 100)\n- [-] only excluded. reason: r", /no counted items/u]
  ])("rejects an invalid scorecard %#", (markdown, message) => {
    const result = score(markdown, (file) => file !== "gone.ts");
    expect(result.errors.join("\n")).toMatch(message);
  });
});
