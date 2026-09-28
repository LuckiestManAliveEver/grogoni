/**
 * What the web bundle budgets measure (scripts/check-web-bundle-budgets.mjs), separated from
 * reading the build so it can be tested against fixture manifests.
 *
 * - initialJavaScriptGzip / initialCssGzip: the entry chunk and everything it statically imports.
 * - ownerRouteGzip: everything opening the owner app downloads beyond the initial page, meaning
 *   its chunk plus every chunk it statically imports that the initial page has not loaded.
 *   Measuring the owner chunk alone would let a split that merely moves code into a sibling eager
 *   chunk "pass" without saving the user a byte.
 */
export function measureWebBundles(manifest, gzipBytes) {
  const chunks = Object.values(manifest);
  const entry = chunks.find((item) => item.isEntry);
  if (!entry) throw new Error("The web build manifest has no entry chunk.");
  const ownerRoute = chunks.find(
    (item) => item.src?.endsWith("src/SokoApplication.tsx") || item.name === "SokoApplication"
  );
  // Without this, a renamed or missing owner chunk would measure 0 and pass every budget.
  if (!ownerRoute) throw new Error("The web build manifest has no SokoApplication chunk.");

  const staticFiles = (chunk) => {
    const files = new Set();
    const visit = (item) => {
      if (files.has(item.file)) return;
      files.add(item.file);
      for (const css of item.css ?? []) files.add(css);
      for (const key of item.imports ?? []) {
        if (manifest[key]) visit(manifest[key]);
      }
    };
    visit(chunk);
    return files;
  };
  const sum = (files) => files.reduce((total, file) => total + gzipBytes(file), 0);

  const initialFiles = staticFiles(entry);
  const ownerFiles = staticFiles(ownerRoute);
  return {
    initialJavaScriptGzip: sum([...initialFiles].filter((file) => file.endsWith(".js"))),
    initialCssGzip: sum([...initialFiles].filter((file) => file.endsWith(".css"))),
    ownerRouteGzip: sum(
      [...ownerFiles].filter((file) => file.endsWith(".js") && !initialFiles.has(file))
    )
  };
}
