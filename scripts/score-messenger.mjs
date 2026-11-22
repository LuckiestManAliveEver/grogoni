#!/usr/bin/env node
// Scores docs/audits/default-messenger-scorecard.md. The percentage is calculated, never typed:
// each area scores done / (done + not done), the total is the weight-weighted sum. A done item
// must cite evidence that exists; an excluded item must give a reason. Exits 1 on any violation.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const scorecardPath = "docs/audits/default-messenger-scorecard.md";

export function scoreScorecard(markdown, exists = (file) => existsSync(path.join(root, file))) {
  const areas = [];
  const errors = [];
  for (const [index, line] of markdown.split("\n").entries()) {
    const heading = /^## (.+?) \(weight (\d+)\)\s*$/u.exec(line);
    if (heading) {
      areas.push({ name: heading[1], weight: Number(heading[2]), done: 0, open: 0, excluded: 0 });
      continue;
    }
    const item = /^- \[([ x-])\] (.+)$/u.exec(line);
    if (!item) continue;
    const where = `line ${index + 1}`;
    const area = areas.at(-1);
    if (area === undefined) {
      errors.push(`${where}: item before any "## <area> (weight N)" heading`);
      continue;
    }
    const [, mark, text] = item;
    if (mark === "x") {
      const evidence = /evidence: (.+)$/u.exec(text)?.[1];
      const files =
        evidence
          ?.split(",")
          .map((file) => file.trim())
          .filter(Boolean) ?? [];
      if (files.length === 0) errors.push(`${where}: done item cites no evidence`);
      for (const file of files)
        if (!exists(file)) errors.push(`${where}: evidence ${file} missing`);
      area.done += 1;
    } else if (mark === "-") {
      if (!/reason: \S/u.test(text)) errors.push(`${where}: excluded item gives no reason`);
      area.excluded += 1;
    } else {
      area.open += 1;
    }
  }
  const weightTotal = areas.reduce((sum, area) => sum + area.weight, 0);
  if (areas.length === 0) errors.push("no areas found");
  else if (weightTotal !== 100) errors.push(`area weights add up to ${weightTotal}, not 100`);
  for (const area of areas) {
    if (area.done + area.open === 0) errors.push(`area "${area.name}" has no counted items`);
    area.percent = area.done + area.open === 0 ? 0 : (100 * area.done) / (area.done + area.open);
  }
  const total = areas.reduce((sum, area) => sum + (area.weight * area.percent) / 100, 0);
  return { areas, total, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = scoreScorecard(readFileSync(path.join(root, scorecardPath), "utf8"));
  const rows = result.areas.map((area) => ({
    area: area.name,
    weight: area.weight,
    done: `${area.done}/${area.done + area.open}`,
    excluded: area.excluded,
    score: `${area.percent.toFixed(0)}%`
  }));
  console.table(rows);
  console.log(`Default messenger score: ${result.total.toFixed(1)}%`);
  if (process.argv.includes("--json")) console.log(JSON.stringify(result));
  for (const error of result.errors) console.error(`scorecard: ${error}`);
  if (result.errors.length > 0) process.exit(1);
}
