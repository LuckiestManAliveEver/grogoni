import { readFile, writeFile } from "node:fs/promises";
import { URL } from "node:url";

const source = new URL("../data/kenyan-commerce/v1/catalog.json", import.meta.url);
const destination = new URL(
  "../services/api/src/cp2/domains/catalogue-sharing/seed-catalogue-data.generated.json",
  import.meta.url
);
const catalogue = JSON.parse(await readFile(source, "utf8"));
const products = catalogue.products.map((product) => ({
  id: product.id,
  name: product.name,
  category: product.category,
  department: product.department
}));
if (new Set(products.map((product) => product.id)).size !== products.length)
  throw new Error("Seed catalogue contains duplicate product IDs.");
const result =
  JSON.stringify(
    {
      id: catalogue.dataset.id,
      name: catalogue.dataset.name,
      version: catalogue.dataset.version,
      country: catalogue.dataset.country,
      generatedAt: catalogue.generatedAt,
      sourceWorkbookSha256: catalogue.dataset.sourceWorkbookSha256,
      products
    },
    null,
    2
  ) + "\n";
if (process.argv.includes("--check")) {
  if ((await readFile(destination, "utf8")) !== result)
    throw new Error("Seed catalogue is stale. Run node scripts/build-seed-catalogue.mjs.");
} else {
  await writeFile(destination, result);
}
