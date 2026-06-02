import { InsiderPurchase, ScoredPurchase } from "./types.js";

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
