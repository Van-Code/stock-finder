import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchRecentForm4Filings, fetchFilingXml, fetchPriceChange90d, fetchRecentActivistFilings, fetchActivistFilingDoc } from "./secClient.js";
import { parseForm4Xml } from "./parser.js";
import { parseActivistDoc } from "./activistParser.js";
import { scoreAllPurchases, buildClusterSignals, scoreActivistFiling, PriceChangeMap } from "./scoring.js";
import { generateReport } from "./reportGenerator.js";
import { InsiderPurchase, ScoredPurchase, ActivistSignal } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");
const REPORTS_DIR = path.resolve(__dirname, "../reports");
const OUTPUT_FILE = path.join(DATA_DIR, "form4-purchases.json");
const CLUSTER_FILE = path.join(DATA_DIR, "cluster-signals.json");
const ACTIVIST_FILE = path.join(DATA_DIR, "activist-signals.json");

const DAYS_BACK = parseInt(process.env.DAYS_BACK ?? "2", 10);
const ACTIVIST_DAYS_BACK = parseInt(process.env.ACTIVIST_DAYS_BACK ?? "7", 10);
const PAGE_SIZE = Math.min(parseInt(process.env.PAGE_SIZE ?? "40", 10), 40);
// Set FETCH_PRICE_DATA=false in .env to skip Yahoo Finance price checks
const FETCH_PRICE_DATA = process.env.FETCH_PRICE_DATA !== "false";

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  SEC Insider Signal Scanner");
  console.log("  Research tool only. Not financial advice.");
  console.log("═══════════════════════════════════════════════════════\n");

  // ── 1. Fetch Form 4 filing metadata ───────────────────────────────────────
  console.log(`[1/5] Fetching recent Form 4 filings (last ${DAYS_BACK} day(s))…`);
  const filings = await fetchRecentForm4Filings(DAYS_BACK, PAGE_SIZE);
  console.log(`      Found ${filings.length} Form 4 filings.\n`);

  if (filings.length === 0) {
    console.log("No filings found. Try increasing DAYS_BACK in .env.");
    process.exit(0);
  }

  // ── 2. Download and parse XML ─────────────────────────────────────────────
  console.log(`[2/5] Downloading and parsing filing XML…`);
  const purchases: InsiderPurchase[] = [];
  let parsed = 0;
  let skipped = 0;

  for (const filing of filings) {
    process.stdout.write(`  [${parsed + skipped + 1}/${filings.length}] ${filing.accessionNo}  `);

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
        transactionCode: txn.transactionCode,
      });
    }

    process.stdout.write(`✓ ${openMarketBuys.length} purchase(s)\n`);
    parsed++;
  }

  console.log(
    `\n      Parsed: ${parsed}  |  Skipped: ${skipped}  |  Open-market purchases: ${purchases.length}\n`
  );

  if (purchases.length === 0) {
    console.log("No open-market insider purchases found. Try increasing DAYS_BACK.\n");
    process.exit(0);
  }

  // ── 3. Fetch 90-day price changes ─────────────────────────────────────────
  console.log(`[3/5] Fetching price data…`);
  const priceChanges: PriceChangeMap = {};

  if (FETCH_PRICE_DATA) {
    const uniqueTickers = [
      ...new Set(purchases.map((p) => p.ticker).filter((t) => t !== "N/A")),
    ];
    console.log(`      Checking ${uniqueTickers.length} ticker(s) via Yahoo Finance…`);
    for (const ticker of uniqueTickers) {
      const change = await fetchPriceChange90d(ticker);
      priceChanges[ticker] = change;
      const label =
        change === null ? "no data" : `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;
      console.log(`      ${ticker.padEnd(8)} ${label}`);
    }
  } else {
    console.log("      Skipped (FETCH_PRICE_DATA=false).");
  }

  // ── 4. Score, cluster, save, display ─────────────────────────────────────
  console.log(`\n[4/5] Scoring, clustering, and saving…`);

  const scored: ScoredPurchase[] = scoreAllPurchases(purchases, priceChanges)
    .sort((a, b) => b.signalScore - a.signalScore);

  const clusters = buildClusterSignals(purchases, priceChanges);

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(scored, null, 2), "utf-8");
  fs.writeFileSync(CLUSTER_FILE, JSON.stringify(clusters, null, 2), "utf-8");

  // ── Per-purchase table ────────────────────────────────────────────────────
  console.log(`\n  ── Insider Signal Scores ──────────────────────────────────────────`);
  console.table(
    scored.map((p) => ({
      ticker:     p.ticker,
      insider:    p.insiderName.slice(0, 22),
      title:      p.insiderTitle.slice(0, 20),
      totalValue: `$${p.totalValue.toLocaleString()}`,
      score:      p.signalScore,
      verdict:    p.verdict,
    }))
  );

  // ── Cluster table ─────────────────────────────────────────────────────────
  if (clusters.length > 0) {
    console.log(`\n  ── Cluster Signals (${clusters.length} ticker(s) with 2+ insiders within 14d) ──`);
    console.table(
      clusters.map((c) => ({
        ticker:             c.ticker,
        uniqueInsiders:     c.uniqueInsiders,
        totalPurchaseValue: `$${c.totalPurchaseValue.toLocaleString()}`,
        ceoOrCfoBought:     c.ceoOrCfoBought ? "YES" : "no",
        clusterScore:       c.clusterScore,
        verdict:            c.verdict,
      }))
    );

    // Detail block for strong clusters
    const strongClusters = clusters.filter((c) => c.clusterScore >= 80);
    if (strongClusters.length > 0) {
      console.log(`\n  ── Strong Cluster Details (score ≥ 80) ───────────────────────────`);
      for (const c of strongClusters) {
        console.log(`\n  ${c.ticker}  ${c.companyName}`);
        console.log(`  Score: ${c.clusterScore}  |  ${c.verdict}`);
        console.log(`  Insiders (${c.uniqueInsiders}): ${c.insiderNames.join(", ")}`);
        console.log(`  Window: ${c.earliestDate} → ${c.latestDate} (${c.windowDays}d)`);
        console.log(`  Avg purchase: $${c.avgPurchaseSize.toLocaleString()}`);
        for (const line of c.scoreBreakdown) console.log(`    ${line}`);
      }
    }
  } else {
    console.log(`\n  No clusters found (need 2+ distinct insiders on same ticker within 14d).`);
    console.log(`  Try increasing DAYS_BACK to 14 in .env for a wider look-back.`);
  }

  // ── Strong individual signals ─────────────────────────────────────────────
  const strongPurchases = scored.filter((p) => p.signalScore >= 80);
  if (strongPurchases.length > 0) {
    console.log(`\n  ── Strong Individual Signals (score ≥ 80) ────────────────────────`);
    for (const p of strongPurchases) {
      console.log(`\n  ${p.ticker}  ${p.insiderName}  (${p.insiderTitle})`);
      console.log(`  Score: ${p.signalScore}  |  ${p.verdict}`);
      for (const line of p.scoreBreakdown) console.log(`    ${line}`);
      console.log(`  Filing: ${p.filingUrl}`);
    }
  }

  // ── 5. Activist 13D/13G scan ──────────────────────────────────────────────
  console.log(`\n[5/5] Scanning for activist 13D/13G filings (last ${ACTIVIST_DAYS_BACK} day(s))…`);

  const activistMetas = await fetchRecentActivistFilings(ACTIVIST_DAYS_BACK, PAGE_SIZE);
  console.log(`      Found ${activistMetas.length} activist filing(s).\n`);

  const activistSignals: ActivistSignal[] = [];
  let aProcessed = 0;
  let aSkipped = 0;

  for (const meta of activistMetas) {
    process.stdout.write(`  [${aProcessed + aSkipped + 1}/${activistMetas.length}] ${meta.accessionNo} (${meta.formType})  `);

    const result = await fetchActivistFilingDoc(meta.cik, meta.accessionNo);
    if (!result) {
      process.stdout.write("✗ skipped\n");
      aSkipped++;
      continue;
    }

    const parsed = parseActivistDoc(result.text, meta.formType, meta.filerName);
    const signal = scoreActivistFiling(meta, parsed, result.filingUrl);
    activistSignals.push(signal);
    process.stdout.write(`✓ ${signal.ticker || "?"}  score=${signal.activistScore}\n`);
    aProcessed++;
  }

  const sortedActivist = activistSignals.sort((a, b) => b.activistScore - a.activistScore);
  fs.writeFileSync(ACTIVIST_FILE, JSON.stringify(sortedActivist, null, 2), "utf-8");

  if (sortedActivist.length > 0) {
    console.log(`\n  ── Activist Watchlist ─────────────────────────────────────────────`);
    console.table(
      sortedActivist.map((a) => ({
        ticker:       a.ticker,
        company:      a.companyName.slice(0, 24),
        filer:        a.filerName.slice(0, 24),
        ownership:    a.ownershipPercent !== null ? `${a.ownershipPercent.toFixed(2)}%` : "N/A",
        form:         a.formType,
        score:        a.activistScore,
        verdict:      a.verdict,
      }))
    );

    const strongActivist = sortedActivist.filter((a) => a.activistScore >= 60);
    if (strongActivist.length > 0) {
      console.log(`\n  ── Notable Activist Positions (score ≥ 60) ───────────────────────`);
      for (const a of strongActivist) {
        console.log(`\n  ${a.ticker}  ${a.companyName}`);
        console.log(`  Filer: ${a.filerName}  |  Form: ${a.formType}  |  Filed: ${a.filingDate}`);
        console.log(`  Score: ${a.activistScore}  |  ${a.verdict}`);
        for (const line of a.scoreBreakdown) console.log(`    ${line}`);
        console.log(`  Filing: ${a.filingUrl}`);
      }
    }
  } else {
    console.log(`\n  No activist filings found. Try increasing ACTIVIST_DAYS_BACK in .env.`);
  }

  // ── Generate markdown report ──────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const reportMd = generateReport({
    date: today,
    scored,
    clusters,
    activist: sortedActivist,
    priceChanges,
    daysBack: DAYS_BACK,
    activistDaysBack: ACTIVIST_DAYS_BACK,
  });

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const reportFile = path.join(REPORTS_DIR, `${today}-sec-signals.md`);
  fs.writeFileSync(reportFile, reportMd, "utf-8");

  console.log(`\nFetched ${filings.length} Form 4 filings.`);
  console.log(`Saved to form4-purchases.json.`);
  console.log(`Saved to cluster-signals.json.`);
  console.log(`Saved to activist-signals.json.`);
  console.log(`Report: reports/${today}-sec-signals.md\n`);
}

main().catch((err) => {
  console.error("\n[ERROR]", err instanceof Error ? err.message : err);
  process.exit(1);
});
