// Regression coverage for audit A03 ("Fonts", docs/audits/grogoni-home-2026-09-17/audit.md): the
// reference loads Sora 500/600/700 and IBM Plex Sans 400/500/600, but production only referenced
// those family names in CSS with no @font-face rule or font asset, so `document.fonts` stayed
// empty and every browser fell back to a system font. This checks the real files exist and the
// stylesheet actually declares faces that can serve every weight the reference uses - not just
// that the family name string appears somewhere.
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "../apps/web");
const stylesheet = readFileSync(path.join(webRoot, "src/styles.css"), "utf8");

function fontFaceBlock(family: string): string {
  const pattern = new RegExp(
    `@font-face\\s*\\{[^}]*font-family:\\s*["']?${family}["']?[^}]*\\}`,
    "u"
  );
  const match = stylesheet.match(pattern);
  if (match === null) throw new Error(`No @font-face rule found for "${family}"`);
  return match[0];
}

function weightRangeCovers(block: string, weights: number[]): void {
  const declared = block.match(/font-weight:\s*(\d+)(?:\s+(\d+))?/u);
  expect(declared).not.toBeNull();
  const min = Number(declared![1]);
  const max = declared![2] === undefined ? min : Number(declared![2]);
  for (const weight of weights) {
    expect(weight).toBeGreaterThanOrEqual(min);
    expect(weight).toBeLessThanOrEqual(max);
  }
}

describe("self-hosted reference fonts (audit A03)", () => {
  it("declares a Sora @font-face covering weights 500/600/700", () => {
    const block = fontFaceBlock("Sora");
    weightRangeCovers(block, [500, 600, 700]);
    expect(block).toMatch(/src:\s*url\(["']?\/fonts\/[\w.-]+\.woff2["']?\)/u);
  });

  it("declares an IBM Plex Sans @font-face covering weights 400/500/600", () => {
    const block = fontFaceBlock("IBM Plex Sans");
    weightRangeCovers(block, [400, 500, 600]);
    expect(block).toMatch(/src:\s*url\(["']?\/fonts\/[\w.-]+\.woff2["']?\)/u);
  });

  it("ships the referenced font files as real, non-empty assets under public/fonts", () => {
    for (const family of ["Sora", "IBM Plex Sans"]) {
      const block = fontFaceBlock(family);
      const urlMatch = block.match(/url\(["']?(\/fonts\/[\w.-]+\.woff2)["']?\)/u);
      expect(urlMatch).not.toBeNull();
      const assetPath = path.join(webRoot, "public", urlMatch![1]);
      expect(existsSync(assetPath)).toBe(true);
      expect(statSync(assetPath).size).toBeGreaterThan(1000);
    }
  });

  it("loads IBM Plex Sans ahead of the old system-font-only stack in the base font-family", () => {
    const rootBlock = stylesheet.match(/:root\s*\{[^}]*\}/u);
    expect(rootBlock).not.toBeNull();
    const fontFamily = rootBlock![0].match(/font-family:\s*([^;]+);/u);
    expect(fontFamily).not.toBeNull();
    const firstFamily = fontFamily![1].split(",")[0]!.trim().replace(/["']/gu, "");
    expect(firstFamily).toBe("IBM Plex Sans");
  });
});
