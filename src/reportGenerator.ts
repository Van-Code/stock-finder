import { ScoredPurchase, ClusterSignal, ActivistSignal } from "./types.js";
import { PriceChangeMap } from "./scoring.js";

export interface ReportInput {
  date: string;                     // YYYY-MM-DD
  scored: ScoredPurchase[];
  clusters: ClusterSignal[];
  activist: ActivistSignal[];
  priceChanges: PriceChangeMap;
  daysBack: number;
  activistDaysBack: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function usd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toLocaleString()}`;
}

function pct(n: number | null): string {
  if (n === null) return "N/A";
  return `${n.toFixed(2)}%`;
}

function priceTag(change: number | null): string {
  if (change === null) return "";
  const sign = change >= 0 ? "+" : "";
  return ` _(90d price: ${sign}${(change * 100).toFixed(1)}%)_`;
}

function link(label: string, url: string): string {
  return `[${label}](${url})`;
}

function verdict(score: number): string {
  if (score >= 80) return "🔴 Strong insider signal";
  if (score >= 60) return "🟠 Worth researching";
  if (score >= 40) return "🟡 Mild signal";
  return "⚪ Ignore";
}

function hasPenalties(breakdown: string[]): boolean {
  return breakdown.some((l) => l.trimStart().startsWith("-"));
}

// Per-ticker "best" purchase (highest signalScore)
function bestPerTicker(purchases: ScoredPurchase[]): Map<string, ScoredPurchase[]> {
  const map = new Map<string, ScoredPurchase[]>();
  for (const p of purchases) {
    const arr = map.get(p.ticker) ?? [];
    arr.push(p);
    map.set(p.ticker, arr);
  }
  return map;
}

// ── Next-research-steps logic ─────────────────────────────────────────────────

function insiderNextSteps(purchase: ScoredPurchase, priceChanges: PriceChangeMap): string[] {
  const steps: string[] = [
    "Check the Form 4 footnotes — confirm this is **not** a 10b5-1 plan execution",
    "Verify the transaction date does not fall inside a standard earnings blackout window",
  ];
  const bd = purchase.scoreBreakdown.join(" ");
  if (bd.includes("CEO") || bd.includes("CFO")) {
    steps.push("Pull the most recent earnings call transcript for forward-guidance language");
  }
  if (bd.includes("fell") || (priceChanges[purchase.ticker] ?? 0) < -0.1) {
    steps.push("Research what drove the recent price decline — confirm fundamentals are intact");
  }
  if (bd.includes("> $1M") || bd.includes("> $500k")) {
    steps.push("Large conviction purchase — cross-reference with any upcoming catalysts or M&A rumours");
  }
  steps.push("Set a price alert ±5% around the insider's purchase price");
  steps.push(`SEC EDGAR company page: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(purchase.ticker)}&type=4`);
  return steps;
}

function clusterNextSteps(cluster: ClusterSignal, priceChanges: PriceChangeMap): string[] {
  const steps: string[] = [
    `Review all ${cluster.uniqueInsiders} individual Form 4 filings for 10b5-1 plan disclosures`,
    "Compare this cluster to prior insider-buying patterns — is this unusual for this company?",
  ];
  if (cluster.ceoOrCfoBought) {
    steps.push("CEO/CFO participated — high conviction signal; review most recent 10-K/10-Q");
  }
  if (cluster.windowDays <= 3) {
    steps.push("All purchases within 3 days — unusually tight window; verify no material non-public information concerns");
  }
  const pc = priceChanges[cluster.ticker] ?? null;
  if (pc !== null && pc < -0.15) {
    steps.push("Stock recently declined — insiders may be 'buying the dip'; research the catalyst for the drop");
  }
  steps.push("Check next earnings date — insiders typically cannot buy within 2 weeks of reporting");
  steps.push("Cross-reference with any recent 13D/13G filings on this ticker");
  return steps;
}

function activistNextSteps(signal: ActivistSignal): string[] {
  const steps: string[] = [];
  if (signal.formType === "SC 13D" || signal.formType === "SC 13D/A") {
    steps.push(`Read **Item 4 "Purpose of Transaction"** in the filing in full: ${link("EDGAR", signal.filingUrl)}`);
    steps.push("Search for any public letters, press releases, or board nomination notices from the filer");
    steps.push("Research filer's track record — prior activist campaigns, typical holding period, exit strategies");
    steps.push("Check if the company has a shareholder rights plan (poison pill) or staggered board defenses");
  } else {
    steps.push("SC 13G is a passive filing — monitor for upgrade to SC 13D (crosses into active intent)");
    steps.push("Track subsequent 13G/A amendments for stake changes");
  }
  if (signal.ownershipPercent !== null && signal.ownershipPercent >= 10) {
    steps.push("Stake ≥ 10% — activist has significant blocking power; watch for proxy contest or merger approach");
  }
  steps.push("Set up SEC EDGAR alert for follow-up filings by this filer on this ticker");
  return steps;
}

function redFlagNextSteps(purchase: ScoredPurchase): string[] {
  const bd = purchase.scoreBreakdown.join(" ");
  const steps: string[] = ["Low conviction — treat as noise unless corroborated by other signals"];
  if (bd.includes("option exercise")) steps.push("Option exercise — no new money at risk; not a true conviction buy");
  if (bd.includes("missing price")) steps.push("Missing price data in filing — verify the transaction details directly on EDGAR");
  if (bd.includes("< $25k")) steps.push("Small transaction value relative to executive compensation — limited signal strength");
  return steps;
}

// ── Section renderers ─────────────────────────────────────────────────────────

function renderStrongBuys(
  byTicker: Map<string, ScoredPurchase[]>,
  priceChanges: PriceChangeMap
): string {
  const strong = [...byTicker.entries()]
    .filter(([, txns]) => Math.max(...txns.map((t) => t.signalScore)) >= 80)
    .sort(([, a], [, b]) => Math.max(...b.map((t) => t.signalScore)) - Math.max(...a.map((t) => t.signalScore)));

  if (strong.length === 0) return "_No strong insider buys in this scan window._\n";

  return strong
    .map(([ticker, txns]) => {
      const best = txns.sort((a, b) => b.signalScore - a.signalScore)[0];
      const totalVal = txns.reduce((s, t) => s + t.totalValue, 0);
      const pc = priceChanges[ticker] ?? null;
      const lines: string[] = [];

      lines.push(`### ${ticker} — ${best.companyName}${priceTag(pc)}`);
      lines.push(`**Signal score: ${best.signalScore} | ${verdict(best.signalScore)}**\n`);

      lines.push("**Why flagged:**");
      for (const b of best.scoreBreakdown) lines.push(`- \`${b.trim()}\``);
      lines.push("");

      // Table for all buyers of this ticker
      if (txns.length > 1) {
        lines.push("**All insider purchases this window:**");
        lines.push("| Insider | Title | Date | Shares | Price | Value |");
        lines.push("|---|---|---|---:|---:|---:|");
        for (const t of txns) {
          lines.push(`| ${t.insiderName} | ${t.insiderTitle} | ${t.transactionDate} | ${t.shares.toLocaleString()} | $${t.price.toFixed(2)} | ${usd(t.totalValue)} |`);
        }
        lines.push(`| | | | **Total** | | **${usd(totalVal)}** |`);
      } else {
        lines.push("| Field | Value |");
        lines.push("|---|---|");
        lines.push(`| Insider | ${best.insiderName} |`);
        lines.push(`| Title | ${best.insiderTitle} |`);
        lines.push(`| Transaction date | ${best.transactionDate} |`);
        lines.push(`| Shares | ${best.shares.toLocaleString()} |`);
        lines.push(`| Price per share | $${best.price.toFixed(2)} |`);
        lines.push(`| **Total value** | **${usd(best.totalValue)}** |`);
      }
      lines.push(`| Filing | ${link("View on EDGAR", best.filingUrl)} |`);
      lines.push("");

      lines.push("**Next research steps:**");
      for (const step of insiderNextSteps(best, priceChanges)) {
        lines.push(`- [ ] ${step}`);
      }
      lines.push("");
      lines.push("---");
      return lines.join("\n");
    })
    .join("\n");
}

function renderClusters(
  clusters: ClusterSignal[],
  scored: ScoredPurchase[],
  priceChanges: PriceChangeMap
): string {
  if (clusters.length === 0) {
    return "_No cluster signals found. Consider increasing `DAYS_BACK` to 14 for a wider look-back._\n";
  }

  return clusters
    .map((c) => {
      const tickerPurchases = scored.filter((p) => p.ticker === c.ticker);
      const pc = priceChanges[c.ticker] ?? null;
      const lines: string[] = [];

      lines.push(`### ${c.ticker} — ${c.companyName}${priceTag(pc)}`);
      lines.push(`**Cluster score: ${c.clusterScore} | ${verdict(c.clusterScore)}**\n`);

      lines.push("**Why flagged:**");
      for (const b of c.scoreBreakdown) lines.push(`- \`${b.trim()}\``);
      lines.push("");

      lines.push(`**${c.uniqueInsiders} distinct insider(s) bought within ${c.windowDays === 0 ? "1 day" : `${c.windowDays} days`} (${c.earliestDate}${c.windowDays > 0 ? ` → ${c.latestDate}` : ""})**\n`);

      lines.push("| Insider | Title | Date | Value | Score |");
      lines.push("|---|---|---|---:|---:|");
      for (const p of tickerPurchases.sort((a, b) => b.signalScore - a.signalScore)) {
        lines.push(`| ${p.insiderName} | ${p.insiderTitle} | ${p.transactionDate} | ${usd(p.totalValue)} | ${p.signalScore} |`);
      }
      lines.push(`| | | **Cluster total** | **${usd(c.totalPurchaseValue)}** | |`);
      lines.push(`| | | **Avg purchase** | **${usd(c.avgPurchaseSize)}** | |`);
      lines.push("");

      if (tickerPurchases.length > 0) {
        lines.push(`**Filing links:**`);
        const seen = new Set<string>();
        for (const p of tickerPurchases) {
          if (!seen.has(p.filingUrl)) {
            seen.add(p.filingUrl);
            lines.push(`- ${p.insiderName}: ${link("EDGAR", p.filingUrl)}`);
          }
        }
        lines.push("");
      }

      lines.push("**Next research steps:**");
      for (const step of clusterNextSteps(c, priceChanges)) {
        lines.push(`- [ ] ${step}`);
      }
      lines.push("");
      lines.push("---");
      return lines.join("\n");
    })
    .join("\n");
}

function renderActivist(activist: ActivistSignal[]): string {
  const notable = activist.filter((a) => a.activistScore >= 40);
  if (notable.length === 0) return "_No notable activist filings in this scan window._\n";

  return notable
    .map((a) => {
      const lines: string[] = [];
      lines.push(`### ${a.ticker} — ${a.companyName}`);
      lines.push(`**Activist score: ${a.activistScore} | ${verdict(a.activistScore)}**\n`);

      lines.push("**Why flagged:**");
      for (const b of a.scoreBreakdown) lines.push(`- \`${b.trim()}\``);
      lines.push("");

      lines.push("| Field | Value |");
      lines.push("|---|---|");
      lines.push(`| Filer | ${a.filerName} |`);
      lines.push(`| Form type | \`${a.formType}\` |`);
      lines.push(`| Filed | ${a.filingDate} |`);
      lines.push(`| Ownership | ${pct(a.ownershipPercent)} |`);
      lines.push(`| Filing | ${link("View on EDGAR", a.filingUrl)} |`);
      lines.push("");

      lines.push("**Next research steps:**");
      for (const step of activistNextSteps(a)) {
        lines.push(`- [ ] ${step}`);
      }
      lines.push("");
      lines.push("---");
      return lines.join("\n");
    })
    .join("\n");
}

function renderRedFlags(
  byTicker: Map<string, ScoredPurchase[]>,
  activist: ActivistSignal[]
): string {
  const flaggedPurchases = [...byTicker.values()]
    .flat()
    .filter((p) => p.signalScore < 40 || hasPenalties(p.scoreBreakdown))
    .sort((a, b) => a.signalScore - b.signalScore);

  const flaggedActivist = activist.filter(
    (a) => a.activistScore < 40 && a.formType !== "SC 13G/A"
  );

  if (flaggedPurchases.length === 0 && flaggedActivist.length === 0) {
    return "_No red flags identified in this scan window._\n";
  }

  const lines: string[] = [];

  if (flaggedPurchases.length > 0) {
    lines.push("**Low-conviction or penalised insider transactions:**\n");
    lines.push("| Ticker | Insider | Title | Value | Score | Issues |");
    lines.push("|---|---|---|---:|---:|---|");
    for (const p of flaggedPurchases) {
      const penalties = p.scoreBreakdown
        .filter((b) => b.trimStart().startsWith("-"))
        .map((b) => b.trim())
        .join("; ");
      lines.push(
        `| ${p.ticker} | ${p.insiderName} | ${p.insiderTitle} | ${usd(p.totalValue)} | ${p.signalScore} | ${penalties || "small signal"} |`
      );
    }
    lines.push("");

    for (const p of flaggedPurchases) {
      lines.push(`**${p.ticker} — ${p.insiderName} (${p.insiderTitle})**`);
      lines.push("Next steps:");
      for (const step of redFlagNextSteps(p)) lines.push(`- [ ] ${step}`);
      lines.push("");
    }
  }

  if (flaggedActivist.length > 0) {
    lines.push("**Low-conviction activist filings:**\n");
    lines.push("| Ticker | Filer | Form | Ownership | Score |");
    lines.push("|---|---|---|---:|---:|");
    for (const a of flaggedActivist) {
      lines.push(`| ${a.ticker} | ${a.filerName} | \`${a.formType}\` | ${pct(a.ownershipPercent)} | ${a.activistScore} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderWatchlist(
  byTicker: Map<string, ScoredPurchase[]>,
  clusters: ClusterSignal[],
  activist: ActivistSignal[],
  priceChanges: PriceChangeMap
): string {
  // Purchases scoring 40–79
  const watchPurchases = [...byTicker.entries()]
    .map(([ticker, txns]) => ({
      ticker,
      best: txns.sort((a, b) => b.signalScore - a.signalScore)[0],
      total: txns.reduce((s, t) => s + t.totalValue, 0),
    }))
    .filter(({ best }) => best.signalScore >= 40 && best.signalScore < 80)
    .sort((a, b) => b.best.signalScore - a.best.signalScore);

  const watchClusters = clusters.filter((c) => c.clusterScore >= 40 && c.clusterScore < 80);
  const watchActivist = activist.filter((a) => a.activistScore >= 40 && a.activistScore < 80);

  if (watchPurchases.length === 0 && watchClusters.length === 0 && watchActivist.length === 0) {
    return "_No watchlist candidates in this scan window._\n";
  }

  const lines: string[] = [];

  if (watchPurchases.length > 0) {
    lines.push("**Insider buys (score 40–79):**\n");
    lines.push("| Ticker | Company | Insider | Title | Total Value | Score | Verdict | 90d |");
    lines.push("|---|---|---|---|---:|---:|---|---|");
    for (const { ticker, best, total } of watchPurchases) {
      const pc = priceChanges[ticker] ?? null;
      const pcStr = pc !== null ? `${pc >= 0 ? "+" : ""}${(pc * 100).toFixed(1)}%` : "—";
      lines.push(
        `| **${ticker}** | ${best.companyName.slice(0, 20)} | ${best.insiderName} | ${best.insiderTitle.slice(0, 18)} | ${usd(total)} | ${best.signalScore} | ${best.verdict} | ${pcStr} |`
      );
    }
    lines.push("");

    for (const { ticker, best } of watchPurchases) {
      lines.push(`**${ticker}** — _${best.companyName}_`);
      lines.push(`Score breakdown: ${best.scoreBreakdown.map((b) => b.trim()).join(" · ")}`);
      lines.push(`Filing: ${link("EDGAR", best.filingUrl)}`);
      lines.push("Next steps:");
      for (const step of insiderNextSteps(best, priceChanges)) lines.push(`- [ ] ${step}`);
      lines.push("");
    }
  }

  if (watchClusters.length > 0) {
    lines.push("**Cluster signals (score 40–79):**\n");
    lines.push("| Ticker | Company | Insiders | Total Value | CEO/CFO | Score |");
    lines.push("|---|---|---:|---:|:---:|---:|");
    for (const c of watchClusters) {
      lines.push(
        `| **${c.ticker}** | ${c.companyName.slice(0, 20)} | ${c.uniqueInsiders} | ${usd(c.totalPurchaseValue)} | ${c.ceoOrCfoBought ? "✓" : "—"} | ${c.clusterScore} |`
      );
    }
    lines.push("");
  }

  if (watchActivist.length > 0) {
    lines.push("**Activist filings (score 40–79):**\n");
    lines.push("| Ticker | Company | Filer | Form | Ownership | Score |");
    lines.push("|---|---|---|---|---:|---:|");
    for (const a of watchActivist) {
      lines.push(
        `| **${a.ticker}** | ${a.companyName.slice(0, 20)} | ${a.filerName.slice(0, 22)} | \`${a.formType}\` | ${pct(a.ownershipPercent)} | ${a.activistScore} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Main report generator ─────────────────────────────────────────────────────

export function generateReport(input: ReportInput): string {
  const { date, scored, clusters, activist, priceChanges, daysBack, activistDaysBack } = input;

  const byTicker = bestPerTicker(scored);

  const strongCount = [...byTicker.values()].filter(
    (txns) => Math.max(...txns.map((t) => t.signalScore)) >= 80
  ).length;
  const watchCount = [...byTicker.values()].filter((txns) => {
    const max = Math.max(...txns.map((t) => t.signalScore));
    return max >= 40 && max < 80;
  }).length;
  const redFlagCount = scored.filter((p) => p.signalScore < 40 || hasPenalties(p.scoreBreakdown)).length;
  const notableActivist = activist.filter((a) => a.activistScore >= 40).length;

  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────────
  lines.push(`# SEC Insider Signal Report — ${date}`);
  lines.push("");
  lines.push("> **Research tool only. Not financial advice. Data sourced from SEC EDGAR.**");
  lines.push(`> Scan window: Form 4 (last ${daysBack} day(s)) | 13D/13G (last ${activistDaysBack} day(s))`);
  lines.push(`> Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // ── Summary table ────────────────────────────────────────────────────────────
  lines.push("## Summary");
  lines.push("");
  lines.push("| Signal type | Tickers | Details |");
  lines.push("|---|---:|---|");
  lines.push(`| 🔴 Strong insider buys (score ≥ 80) | ${strongCount} | Highest conviction open-market purchases |`);
  lines.push(`| 🟠 Cluster buying | ${clusters.length} | 2+ insiders buying same ticker within 14d |`);
  lines.push(`| 🔵 Activist filings (score ≥ 40) | ${notableActivist} | SC 13D/13G positions |`);
  lines.push(`| ⚠️ Red flags | ${redFlagCount} | Penalties or low-conviction transactions |`);
  lines.push(`| 👁 Watchlist (score 40–79) | ${watchCount} | Worth monitoring |`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // ── Section 1 ────────────────────────────────────────────────────────────────
  lines.push("## 1. Strong Insider Buys");
  lines.push("");
  lines.push(renderStrongBuys(byTicker, priceChanges));

  // ── Section 2 ────────────────────────────────────────────────────────────────
  lines.push("## 2. Cluster Buying");
  lines.push("");
  lines.push(renderClusters(clusters, scored, priceChanges));

  // ── Section 3 ────────────────────────────────────────────────────────────────
  lines.push("## 3. Activist Filings");
  lines.push("");
  lines.push(renderActivist(activist));

  // ── Section 4 ────────────────────────────────────────────────────────────────
  lines.push("## 4. Red Flags");
  lines.push("");
  lines.push(renderRedFlags(byTicker, activist));

  // ── Section 5 ────────────────────────────────────────────────────────────────
  lines.push("## 5. Watchlist Candidates");
  lines.push("");
  lines.push(renderWatchlist(byTicker, clusters, activist, priceChanges));

  // ── Footer ───────────────────────────────────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("_Generated by [SEC Insider Signal Scanner](https://github.com/Van-Code/stock-finder). Data from [SEC EDGAR](https://www.sec.gov/). For research purposes only._");
  lines.push("");

  return lines.join("\n");
}
