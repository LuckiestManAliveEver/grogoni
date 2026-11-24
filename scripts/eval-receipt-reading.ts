// Paid eval: Luna reads receipts so the posting rules hold (receipt-to-commerce checklist, P0).
// Run: pnpm eval:receipt-reading [--report <path>]
// Renders receipts as PNG images in headless Chromium, sends each through readChatImage (the
// production image reader, platform Luna through OpenRouter; OPENROUTER_API_KEY from
// .env.openrouter), then applies the same checks a draft gets (withReceiptChecks). Scores the
// document type, what it may post, and whether a misprinted line total is copied as printed and
// caught rather than silently corrected. Exit 0 = pass, 1 = below threshold or an integrity case
// failed, 2 = not run.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readChatImage } from "../services/api/src/cp2/chat-image-reader.ts";
import { withReceiptChecks } from "../services/api/src/cp2/domains/suppliers/receipt-validation.ts";
import {
  buildReceiptStructuredExtraction,
  parseReceiptText
} from "../services/api/src/cp2/domains/suppliers/shared.ts";

const passThreshold = 0.8;
const reportFlag = process.argv.indexOf("--report");
const reportPath =
  reportFlag === -1 ? "/tmp/receipt-reading/eval/report.json" : process.argv[reportFlag + 1]!;
const write = (report: unknown) => {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${reportPath}`);
};
if (!process.env.OPENROUTER_API_KEY?.trim()) {
  write({ status: "not_run", reason: "OPENROUTER_API_KEY is not set." });
  process.exit(2);
}

interface Line {
  item: string;
  qty: number;
  price: number;
  total?: number;
}
const receiptHtml = (heading: string | null, shop: string, lines: Line[], footer: string[]) => `
<html><body style="font-family: 'Courier New', monospace; width: 380px; padding: 18px; background: #fff; color: #111; font-size: 15px">
${heading ? `<div style="text-align:center;font-weight:bold;font-size:20px">${heading}</div>` : ""}
<div style="text-align:center">${shop}<br/>Tel 0722 000 111 · Nairobi</div>
<div>Date: 2026-11-20</div>
<hr/>
<table style="width:100%;font-size:15px">
<tr><th align="left">Item</th><th>Qty</th><th>Price</th><th align="right">Total</th></tr>
${lines
  .map(
    (line) =>
      `<tr><td>${line.item}</td><td align="center">${line.qty}</td><td align="center">${line.price}</td><td align="right">${line.total ?? line.qty * line.price}</td></tr>`
  )
  .join("")}
</table>
<hr/>
${footer.map((row) => `<div>${row}</div>`).join("")}
</body></html>`;

interface Case {
  id: string;
  integrity: boolean;
  html: string;
  check: (result: ReturnType<typeof withReceiptChecks>) => string | null;
}
const cases: Case[] = [
  {
    id: "quotation-never-posts",
    integrity: true,
    html: receiptHtml(
      "QUOTATION",
      "Acacia Wholesale Ltd",
      [{ item: "Sugar 2kg", qty: 10, price: 380 }],
      ["Total: KES 3800", "Valid for 14 days"]
    ),
    check: (r) =>
      r.checks?.documentType !== "quotation"
        ? `type ${r.checks?.documentType}`
        : r.checks.recordPurchase
          ? "quotation could post"
          : null
  },
  {
    id: "tax-invoice-with-vat",
    integrity: false,
    html: receiptHtml(
      "TAX INVOICE",
      "Acacia Wholesale Ltd",
      [
        { item: "Sugar 2kg", qty: 5, price: 380 },
        { item: "Blueband 500g", qty: 3, price: 250 }
      ],
      ["Subtotal: 2650", "VAT 16% (incl.): 365.52", "Total: KES 2650"]
    ),
    check: (r) =>
      r.checks?.documentType !== "invoice"
        ? `type ${r.checks?.documentType}`
        : r.checks.arithmeticIssues.length > 0
          ? `false mismatch: ${r.checks.arithmeticIssues[0]!.message}`
          : r.receipt.total !== 2650
            ? `total ${r.receipt.total}`
            : null
  },
  {
    id: "misprinted-line-is-copied-and-caught",
    integrity: true,
    html: receiptHtml(
      "CASH SALE",
      "Mama Pima Stores",
      [
        { item: "Sugar 2kg", qty: 5, price: 380, total: 1800 },
        { item: "Salt 1kg", qty: 2, price: 50 }
      ],
      ["Total: KES 1900"]
    ),
    check: (r) => {
      const sugar = r.products.find((product) => /sugar/iu.test(product.itemName));
      if (sugar?.lineTotal !== 1800)
        return `sugar line read as ${sugar?.lineTotal} (should copy 1800)`;
      return r.checks?.arithmeticIssues.some((issue) => issue.code === "line_total_mismatch")
        ? null
        : "misprint not caught";
    }
  },
  {
    id: "credit-note-refused",
    integrity: false,
    html: receiptHtml(
      "CREDIT NOTE",
      "Acacia Wholesale Ltd",
      [{ item: "Sugar 2kg", qty: 2, price: 380 }],
      ["Credit total: KES 760", "Against invoice INV-2041"]
    ),
    check: (r) =>
      r.checks?.documentType !== "credit_note"
        ? `type ${r.checks?.documentType}`
        : r.checks.recordPurchase
          ? "credit note could post"
          : null
  },
  {
    id: "unheaded-slip-is-a-purchase",
    integrity: false,
    html: receiptHtml(
      null,
      "Kamau Hardware",
      [{ item: "Nails 1kg", qty: 4, price: 220 }],
      ["Total: 880", "Asante, karibu tena"]
    ),
    check: (r) =>
      !r.checks?.recordPurchase
        ? `type ${r.checks?.documentType} cannot post`
        : r.checks.arithmeticIssues.length > 0
          ? `false mismatch: ${r.checks.arithmeticIssues[0]!.message}`
          : null
  }
];

const { chromium } = createRequire(import.meta.url)("@playwright/test");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 640 }, deviceScaleFactor: 2 });
const results: Array<{
  id: string;
  integrity: boolean;
  passed: boolean;
  failure: string | null;
  documentType: string | null;
  source?: "fields" | "text";
}> = [];
for (const testCase of cases) {
  await page.setContent(testCase.html);
  const png = (await page.screenshot({ fullPage: true, type: "png" })) as Buffer;
  try {
    const read = await readChatImage({
      fileName: `${testCase.id}.png`,
      contentType: "image/png",
      contentBase64: png.toString("base64")
    });
    // Without fields (Luna's did not fit the schema) the app drafts from the transcription, as
    // createReceiptOCRJob does with extractedText alone: score that same path.
    const fields =
      (read as { receiptFields?: Parameters<typeof withReceiptChecks>[0] }).receiptFields ??
      buildReceiptStructuredExtraction(parseReceiptText(read.text));
    const source = (read as { receiptFields?: unknown }).receiptFields ? "fields" : "text";
    const checked = withReceiptChecks(fields, read.text);
    const failure = testCase.check(checked);
    results.push({
      id: testCase.id,
      integrity: testCase.integrity,
      passed: failure === null,
      failure,
      documentType: checked.checks?.documentType ?? null,
      source
    });
  } catch (error) {
    results.push({
      id: testCase.id,
      integrity: testCase.integrity,
      passed: false,
      failure: `error: ${error instanceof Error ? error.message : String(error)}`,
      documentType: null
    });
  }
  const last = results.at(-1)!;
  console.log(
    `${last.passed ? "PASS" : "FAIL"} ${last.id}${last.failure ? ` (${last.failure})` : ""}`
  );
}
await browser.close();

const passRate = results.filter((result) => result.passed).length / results.length;
const integrityFailed = results.some((result) => result.integrity && !result.passed);
const status = passRate >= passThreshold && !integrityFailed ? "pass" : "fail";
write({
  status,
  passRate,
  passThreshold,
  integrityFailed,
  results,
  checkedAt: new Date().toISOString()
});
console.log(
  `Receipt reading eval: ${status} (${results.filter((r) => r.passed).length}/${results.length})`
);
process.exit(status === "pass" ? 0 : 1);
