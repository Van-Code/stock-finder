import { InsiderPurchase, ScoredPurchase, ClusterSignal, ActivistSignal, ParsedActivistDoc, ActivistFilingMeta } from "./types.js";

// Fractional price change over 90 days, e.g. -0.25 = fell 25%. null = unavailable.
export type PriceChangeMap = Record<string, number | null>;

function verdict(score: number): string {
  if (score >= 80) return "Strong insider signal";
  if (score >= 60) return "Worth researching";
  if (score >= 40) return "Mild signal";
  return "Ignore";
}

function titleIs(title: string, ...terms: string[]): boolean {
  const t = title.toLowerCase();
  return terms.some((term) => t.includes(term));
}

// Returns tickers where 2+ distinct insiders transacted within a 14-day window.
function clusterTickers(purchases: InsiderPurchase[]): Set<string> {
  const WINDOW = 14 * 24 * 60 * 60 * 1000;
  const byTicker = new Map<string, { name: string; ts: number }[]>();

  for (const p of purchases) {
    const ts = new Date(p.transactionDate).getTime();
    if (isNaN(ts) || p.ticker === "N/A") continue;
    const arr = byTicker.get(p.ticker) ?? [];
    arr.push({ name: p.insiderName, ts });
    byTicker.set(p.ticker, arr);
  }

  const clustered = new Set<string>();
  for (const [ticker, entries] of byTicker) {
    const sorted = entries.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < sorted.length - 1; i++) {
      const withinWindow = sorted[i + 1].ts - sorted[i].ts <= WINDOW;
      const distinctInsiders = sorted[i].name !== sorted[i + 1].name;
      if (withinWindow && distinctInsiders) {
        clustered.add(ticker);
        break;
      }
    }
  }
  return clustered;
}

export function scoreAllPurchases(
  purchases: InsiderPurchase[],
  priceChanges: PriceChangeMap
): ScoredPurchase[] {
  const clustered = clusterTickers(purchases);

  return purchases.map((p) => {
    const breakdown: string[] = [];
    let score = 0;

    // ── Bonuses ──────────────────────────────────────────────────────────────

    if (p.transactionCode === "P") {
      score += 30;
      breakdown.push("+30  open-market purchase (P)");
    }

    // Value tiers are cumulative — each threshold that applies adds its bonus
    if (p.totalValue > 1_000_000) {
      score += 35;
      breakdown.push("+35  totalValue > $1M");
    }
    if (p.totalValue > 500_000) {
      score += 25;
      breakdown.push("+25  totalValue > $500k");
    }
    if (p.totalValue > 100_000) {
      score += 15;
      breakdown.push("+15  totalValue > $100k");
    }

    // Role — pick the highest applicable title bonus (not cumulative)
    const t = p.insiderTitle;
    if (titleIs(t, "chief executive", "ceo")) {
      score += 20;
      breakdown.push("+20  CEO");
    } else if (titleIs(t, "chief financial", "cfo")) {
      score += 15;
      breakdown.push("+15  CFO");
    } else if (
      titleIs(t, "director") &&
      !titleIs(t, "chief", "president", "officer", "vp ", "vice president", "managing")
    ) {
      score += 5;
      breakdown.push("+5   Director");
    }

    // Cluster: multiple distinct insiders on same ticker within 14 days
    if (clustered.has(p.ticker)) {
      score += 25;
      breakdown.push("+25  cluster — multiple insiders within 14d");
    }

    // Price momentum: bought after stock fell >20% over prior 90 days
    const pc = priceChanges[p.ticker] ?? null;
    if (pc !== null) {
      if (pc < -0.2) {
        score += 20;
        breakdown.push(`+20  stock fell ${(pc * 100).toFixed(1)}% in prior 90d`);
      }
    }

    // ── Penalties ────────────────────────────────────────────────────────────

    // Option exercise codes: M (acquired via option), C (option conversion)
    if (["M", "C", "X"].includes(p.transactionCode)) {
      score -= 30;
      breakdown.push("-30  option exercise");
    }

    // Derivative-only filing (no direct share purchase price recorded)
    if (p.price === 0 && p.transactionCode !== "P") {
      score -= 25;
      breakdown.push("-25  derivative transaction only");
    }

    // Missing price on what should be a priced transaction
    if (p.price === 0 && p.transactionCode === "P") {
      score -= 20;
      breakdown.push("-20  missing transaction price");
    }

    if (p.totalValue < 25_000 && p.totalValue > 0) {
      score -= 10;
      breakdown.push("-10  totalValue < $25k");
    }

    return { ...p, signalScore: score, verdict: verdict(score), scoreBreakdown: breakdown };
  });
}

// ── Cluster signals ───────────────────────────────────────────────────────────

function clusterScore(
  uniqueInsiders: number,
  totalPurchaseValue: number,
  ceoOrCfoBought: boolean,
  windowDays: number,
  priceChange90d: number | null
): { score: number; breakdown: string[] } {
  const breakdown: string[] = [];
  let score = 0;

  // Conviction grows with each independent buyer
  score += uniqueInsiders * 20;
  breakdown.push(`+${uniqueInsiders * 20}  ${uniqueInsiders} unique insider(s) × 20`);

  // Aggregate value tiers (cumulative, same philosophy as per-purchase scoring)
  if (totalPurchaseValue > 1_000_000) {
    score += 30;
    breakdown.push("+30  total > $1M");
  }
  if (totalPurchaseValue > 500_000) {
    score += 20;
    breakdown.push("+20  total > $500k");
  }
  if (totalPurchaseValue > 100_000) {
    score += 15;
    breakdown.push("+15  total > $100k");
  }

  if (ceoOrCfoBought) {
    score += 25;
    breakdown.push("+25  CEO or CFO participated");
  }

  // Purchases clustered tightly (all within a week) raise conviction further
  if (uniqueInsiders >= 2 && windowDays <= 7) {
    score += 10;
    breakdown.push("+10  all purchases within 7 days");
  }

  // Price-momentum bonus (same threshold as per-purchase)
  if (priceChange90d !== null && priceChange90d < -0.2) {
    score += 20;
    breakdown.push(`+20  stock fell ${(priceChange90d * 100).toFixed(1)}% in prior 90d`);
  }

  return { score, breakdown };
}

/**
 * Group purchases by ticker, keep only tickers with 2+ distinct insiders whose
 * transactions all fall within a 14-day window, then score each cluster.
 * Returns clusters sorted by clusterScore descending.
 */
export function buildClusterSignals(
  purchases: InsiderPurchase[],
  priceChanges: PriceChangeMap
): ClusterSignal[] {
  const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

  // Group by ticker
  const byTicker = new Map<string, InsiderPurchase[]>();
  for (const p of purchases) {
    if (p.ticker === "N/A") continue;
    const arr = byTicker.get(p.ticker) ?? [];
    arr.push(p);
    byTicker.set(p.ticker, arr);
  }

  const clusters: ClusterSignal[] = [];

  for (const [ticker, txns] of byTicker) {
    // Require 2+ distinct insiders
    const uniqueNames = [...new Set(txns.map((p) => p.insiderName))];
    if (uniqueNames.length < 2) continue;

    // All transactions must fall within the 14-day window
    const timestamps = txns
      .map((p) => new Date(p.transactionDate).getTime())
      .filter((t) => !isNaN(t));
    if (timestamps.length < 2) continue;
    const minTs = Math.min(...timestamps);
    const maxTs = Math.max(...timestamps);
    if (maxTs - minTs > WINDOW_MS) continue;

    const windowDays = Math.round((maxTs - minTs) / (24 * 60 * 60 * 1000));
    const totalPurchaseValue = txns.reduce((sum, p) => sum + p.totalValue, 0);
    const avgPurchaseSize = Math.round(totalPurchaseValue / txns.length);

    const ceoOrCfoBought = txns.some((p) =>
      titleIs(p.insiderTitle, "chief executive", "ceo", "chief financial", "cfo")
    );

    const toDate = (ts: number) => new Date(ts).toISOString().slice(0, 10);
    const companyName = txns[0].companyName;

    const { score, breakdown } = clusterScore(
      uniqueNames.length,
      totalPurchaseValue,
      ceoOrCfoBought,
      windowDays,
      priceChanges[ticker] ?? null
    );

    clusters.push({
      ticker,
      companyName,
      uniqueInsiders: uniqueNames.length,
      insiderNames: uniqueNames,
      totalPurchaseValue: Math.round(totalPurchaseValue * 100) / 100,
      avgPurchaseSize,
      ceoOrCfoBought,
      earliestDate: toDate(minTs),
      latestDate: toDate(maxTs),
      windowDays,
      clusterScore: score,
      verdict: verdict(score),
      scoreBreakdown: breakdown,
    });
  }

  return clusters.sort((a, b) => b.clusterScore - a.clusterScore);
}

// ── Activist signal scoring ───────────────────────────────────────────────────

export function scoreActivistFiling(
  meta: ActivistFilingMeta,
  doc: ParsedActivistDoc,
  filingUrl: string
): ActivistSignal {
  const breakdown: string[] = [];
  let score = 0;

  // New SC 13D is the strongest signal — declares intent to influence
  if (meta.formType === "SC 13D") {
    score += 40;
    breakdown.push("+40  new SC 13D filing");
  } else if (meta.formType === "SC 13D/A") {
    score += 20;
    breakdown.push("+20  SC 13D/A amendment");
    if (doc.isIncreasingStake) {
      score += 25;
      breakdown.push("+25  increasing stake detected");
    }
  } else if (meta.formType === "SC 13G") {
    score += 15;
    breakdown.push("+15  new SC 13G (passive ownership)");
  } else if (meta.formType === "SC 13G/A") {
    score += 10;
    breakdown.push("+10  SC 13G/A amendment");
    if (doc.isIncreasingStake) {
      score += 25;
      breakdown.push("+25  increasing stake detected");
    }
  }

  // Ownership thresholds (cumulative)
  if (doc.ownershipPercent !== null) {
    if (doc.ownershipPercent > 10) {
      score += 30;
      breakdown.push(`+30  ownership > 10% (${doc.ownershipPercent.toFixed(2)}%)`);
    }
    if (doc.ownershipPercent > 5) {
      score += 20;
      breakdown.push(`+20  ownership > 5%`);
    }
  }

  // Activist keywords in filer name or filing text
  if (doc.activistKeywordsFound.length > 0) {
    score += 15;
    breakdown.push(`+15  activist keywords: ${doc.activistKeywordsFound.slice(0, 3).join(", ")}`);
  }

  return {
    ticker: doc.ticker || "N/A",
    companyName: doc.subjectCompanyName || meta.filerName,
    filerName: meta.filerName,
    ownershipPercent: doc.ownershipPercent,
    filingDate: meta.filedAt.slice(0, 10),
    filingUrl,
    formType: meta.formType,
    activistScore: score,
    verdict: verdict(score),
    scoreBreakdown: breakdown,
  };
}
