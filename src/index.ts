import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchRecentForm4Filings, fetchFilingXml } from "./secClient.js";
import { parseForm4Xml } from "./parser.js";
import { InsiderPurchase } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");
const OUTPUT_FILE = path.join(DATA_DIR, "form4-purchases.json");

// Configurable via env
const DAYS_BACK = parseInt(process.env.DAYS_BACK ?? "2", 10);
const PAGE_SIZE = Math.min(parseInt(process.env.PAGE_SIZE ?? "40", 10), 40);

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  SEC Form 4 Insider Purchase Scanner  — Phase 1");
  console.log("  Research tool only. Not financial advice.");
  console.log("═══════════════════════════════════════════════════════\n");

  // 1. Fetch recent Form 4 filing metadata from EDGAR EFTS
  console.log(`[1/3] Fetching recent Form 4 filings (last ${DAYS_BACK} day(s))…`);
  const filings = await fetchRecentForm4Filings(DAYS_BACK, PAGE_SIZE);
  console.log(`      Found ${filings.length} Form 4 filings.\n`);

  if (filings.length === 0) {
    console.log("No filings found for the given date range. Try increasing DAYS_BACK.");
    process.exit(0);
  }

  // 2. Download and parse each filing XML
  console.log(`[2/3] Downloading and parsing XML documents…`);
  const purchases: InsiderPurchase[] = [];
  let parsed = 0;
  let skipped = 0;

  for (const filing of filings) {
    process.stdout.write(
      `  [${parsed + skipped + 1}/${filings.length}] ${filing.accessionNo}  `
    );

    const result = await fetchFilingXml(filing.cik, filing.accessionNo);
    if (!result) {
      process.stdout.write("✗ skipped (no XML)\n");
      skipped++;
      continue;
    }

    const form4 = parseForm4Xml(result.xml);
    if (!form4) {
      process.stdout.write("✗ skipped (parse failed)\n");
      skipped++;
      continue;
    }

    // Filter: open-market purchases only
    const openMarketBuys = form4.transactions.filter(
      (txn) =>
        txn.transactionCode === "P" &&
        txn.transactionShares > 0 &&
        txn.transactionPricePerShare > 0
    );

    if (openMarketBuys.length === 0) {
      process.stdout.write("– no open-market purchases\n");
      parsed++;
      continue;
    }

    for (const txn of openMarketBuys) {
      purchases.push({
        ticker: form4.issuerTicker || "N/A",
        companyName: form4.issuerName || filing.entityName,
        insiderName: form4.reportingOwnerName,
        insiderTitle: form4.reportingOwnerTitle,
        transactionDate: txn.transactionDate,
        shares: txn.transactionShares,
        price: txn.transactionPricePerShare,
        totalValue: Math.round(txn.transactionShares * txn.transactionPricePerShare * 100) / 100,
        filingUrl: result.filingUrl,
      });
    }

    process.stdout.write(`✓ ${openMarketBuys.length} purchase(s) found\n`);
    parsed++;
  }

  console.log(
    `\n      Parsed: ${parsed}  |  Skipped: ${skipped}  |  Open-market purchases: ${purchases.length}\n`
  );

  // 3. Save and display results
  console.log(`[3/3] Saving results…`);

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(purchases, null, 2), "utf-8");

  if (purchases.length === 0) {
    console.log("\n  No open-market insider purchases found in this window.");
    console.log("  Try increasing DAYS_BACK in .env.\n");
  } else {
    console.log(`\n  ── Open-Market Insider Purchases ─────────────────────`);
    console.table(
      purchases.map((p) => ({
        ticker: p.ticker,
        company: p.companyName.slice(0, 24),
        insider: p.insiderName.slice(0, 22),
        title: p.insiderTitle.slice(0, 20),
        date: p.transactionDate,
        shares: p.shares.toLocaleString(),
        price: `$${p.price.toFixed(2)}`,
        total: `$${p.totalValue.toLocaleString()}`,
      }))
    );
  }

  console.log(`\nFetched ${filings.length} Form 4 filings.`);
  console.log(`Saved to form4-purchases.json.`);
  console.log(`Output: ${OUTPUT_FILE}\n`);
}

main().catch((err) => {
  console.error("\n[ERROR]", err instanceof Error ? err.message : err);
  process.exit(1);
});
