import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { measureWebBundles } from "../scripts/web-bundle-measurements.mjs";

// Sizes in the fixture: each file "weighs" the number in its name, so sums are easy to read.
const weight = (file: string) => Number(file.match(/(\d+)/u)?.[1] ?? 0);

const manifest = {
  "src/main.tsx": {
    file: "assets/entry-100.js",
    isEntry: true,
    imports: ["_shared"],
    css: ["assets/app-7.css"]
  },
  _shared: { file: "assets/shared-20.js" },
  "src/GrogoniApplication.tsx": {
    file: "assets/GrogoniApplication-50.js",
    name: "GrogoniApplication",
    // A sibling chunk only the owner route loads, and one the initial page already loaded.
    imports: ["_sibling", "_shared"],
    dynamicImports: ["_lazyScreen"]
  },
  _sibling: { file: "assets/sibling-30.js", css: ["assets/owner-5.css"] },
  _lazyScreen: { file: "assets/screen-40.js" }
};

describe("web bundle budget gate", () => {
  it("counts the owner route's whole eager download beyond the initial page", () => {
    expect(measureWebBundles(manifest, weight)).toEqual({
      initialJavaScriptGzip: 120, // entry + shared
      initialCssGzip: 7,
      // Owner chunk + its sibling. Not shared (already loaded), not CSS, not the lazy screen.
      ownerRouteGzip: 80
    });
  });

  it("does not let moving owner code into a sibling eager chunk look like a saving", () => {
    const split = {
      ...manifest,
      "src/GrogoniApplication.tsx": {
        ...manifest["src/GrogoniApplication.tsx"],
        file: "assets/GrogoniApplication-10.js",
        imports: ["_sibling", "_shared", "_moved"]
      },
      _moved: { file: "assets/moved-40.js" }
    };
    expect(measureWebBundles(split, weight).ownerRouteGzip).toBe(80);
  });

  it("fails instead of passing when the owner chunk or entry is missing", () => {
    const withoutOwner: Record<string, unknown> = { ...manifest };
    delete withoutOwner["src/GrogoniApplication.tsx"];
    expect(() => measureWebBundles(withoutOwner, weight)).toThrow(/no GrogoniApplication chunk/u);
    const withoutEntry: Record<string, unknown> = { ...manifest };
    delete withoutEntry["src/main.tsx"];
    expect(() => measureWebBundles(withoutEntry, weight)).toThrow(/no entry chunk/u);
  });

  it("is what the CI budget check runs, against a manifest Vite writes", () => {
    const vite = readFileSync("apps/web/vite.config.ts", "utf8");
    const check = readFileSync("scripts/check-web-bundle-budgets.mjs", "utf8");
    expect(vite).toContain("manifest: true");
    expect(check).toContain("measureWebBundles(manifest, gzipBytes)");
    expect(check).not.toContain("browser-model.worker");
    expect(readFileSync("package.json", "utf8")).toContain("check:web-bundle-budgets");
  });
});
