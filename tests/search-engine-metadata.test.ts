import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tagline = "grogoni - the market at your fingertips";

describe("search engine metadata", () => {
  it("titles and describes the app so search results show the tagline", () => {
    const html = readFileSync("apps/web/index.html", "utf8");

    expect(html).toContain(`<title>${tagline}</title>`);
    expect(html).toContain(`<meta name="description" content="${tagline}" />`);
    expect(html).toContain('<link rel="canonical" href="https://grogoni.com/" />');
  });

  it("shares the same tagline in Open Graph and Twitter card previews", () => {
    const html = readFileSync("apps/web/index.html", "utf8");

    expect(html).toContain('<meta property="og:site_name" content="grogoni" />');
    expect(html).toContain('<meta property="og:url" content="https://grogoni.com/" />');
    expect(html).toContain(`<meta property="og:title" content="${tagline}" />`);
    expect(html).toContain(`<meta property="og:description" content="${tagline}" />`);
    expect(html).toContain(
      '<meta property="og:image" content="https://grogoni.com/icons/grogoni-icon-512.png" />'
    );
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).toContain(`<meta name="twitter:title" content="${tagline}" />`);
    expect(html).toContain(`<meta name="twitter:description" content="${tagline}" />`);
  });
});
